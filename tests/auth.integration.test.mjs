import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import worker, { cleanup } from '../backend/worker.mjs';
import { hashPassword, randomToken, sha256, verifyPassword } from '../backend/crypto.mjs';

const ORIGIN = 'https://trip.example.test';
const ADMIN = { id: 'test-admin', username: 'TrailOwner', password: 'TestOnly-Owner!28' };
const MEMBER = { id: 'test-member', username: 'TrailMate', password: 'TestOnly-Member!29' };
const NEW_PASSWORD = 'TestOnly-Replacement!30';
const hashes = await Promise.all([hashPassword(ADMIN.password), hashPassword(MEMBER.password)]);
const migration = readFileSync(new URL('../migrations/0001_auth.sql', import.meta.url), 'utf8');
const staticFiles = new Set(['/index.html', '/interactive-itinerary.html', '/detailed-itinerary.html',
  '/detailed-itinerary.md', '/account-ui/account.html', '/account-ui/login.html', '/account-ui/auth.css', '/account-ui/auth.js']);

// Use real SQLite constraints and SQL execution, exposing only the D1 interface
// used by the worker. Batch statements run inside one SQLite transaction.
class D1Statement {
  constructor(db, sql, parameters = []) {
    this.db = db;
    this.sql = sql;
    this.parameters = parameters;
  }
  bind(...parameters) { return new D1Statement(this.db, this.sql, parameters); }
  async first(column) {
    const row = this.db.prepare(this.sql).get(...this.parameters);
    return row ? (column ? row[column] : { ...row }) : null;
  }
  async all() {
    return { success: true, results: this.db.prepare(this.sql).all(...this.parameters).map(row => ({ ...row })) };
  }
  execute() {
    const result = this.db.prepare(this.sql).run(...this.parameters);
    return { success: true, results: [], meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
  }
  async run() { return this.execute(); }
}

function fixture(t, overrides = {}) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec(migration);
  const insert = sqlite.prepare(`INSERT INTO users
    (id, username, username_normalized, password_hash, role, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const now = Math.floor(Date.now() / 1000);
  insert.run(ADMIN.id, ADMIN.username, ADMIN.username.toLowerCase(), hashes[0], 'admin', now, now);
  insert.run(MEMBER.id, MEMBER.username, MEMBER.username.toLowerCase(), hashes[1], 'member', now, now);
  insert.run('other-admin', 'OtherOwner', 'otherowner', hashes[0], 'admin', now, now);
  t.after(() => sqlite.close());
  const assetRequests = [];
  const env = {
    DB: {
      prepare: sql => new D1Statement(sqlite, sql),
      async batch(statements) {
        sqlite.exec('BEGIN');
        try {
          const results = statements.map(statement => statement.execute());
          sqlite.exec('COMMIT');
          return results;
        } catch (error) {
          sqlite.exec('ROLLBACK');
          throw error;
        }
      },
    },
    ASSETS: {
      async fetch(request) {
        const path = new URL(request.url).pathname;
        assetRequests.push(path);
        // Match html_handling: "none": a request for "/" does not implicitly
        // resolve to index.html. Route tests must exercise the worker rewrite.
        const exists = staticFiles.has(path);
        return new Response(request.method === 'HEAD' ? null : exists ? `<html><body>ASSET:${path}</body></html>` : 'Asset not found', {
          status: exists ? 200 : 404,
          headers: { 'Content-Type': 'text/html', 'Cache-Control': 'public, max-age=86400' },
        });
      },
    },
    GUIDE_ACCESS: 'private',
    ENVIRONMENT: 'production',
    ...overrides,
  };
  async function request(path, { method = 'GET', body, raw, cookie, headers = {} } = {}) {
    const requestHeaders = new Headers({ 'CF-Connecting-IP': '192.0.2.1' });
    if (method !== 'GET' && method !== 'HEAD') {
      requestHeaders.set('Origin', ORIGIN);
      requestHeaders.set('X-Requested-With', 'itinerary');
      requestHeaders.set('Content-Type', 'application/json');
    }
    if (cookie) requestHeaders.set('Cookie', cookie);
    for (const [key, value] of Object.entries(headers)) {
      if (value === null) requestHeaders.delete(key);
      else requestHeaders.set(key, value);
    }
    const response = await worker.fetch(new Request(`${ORIGIN}${path}`, {
      method, headers: requestHeaders, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    }), env);
    assert.equal(response.headers.get('Cache-Control'), 'no-store', `${path}: private responses must not be cached`);
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.equal(response.headers.get('X-Frame-Options'), 'DENY');
    return response;
  }
  async function login(user = ADMIN, options = {}) {
    return request('/api/auth/login', { method: 'POST', body: { username: user.username, password: user.password }, ...options });
  }
  return { sqlite, env, assetRequests, request, login };
}

function sessionCookie(response) {
  const cookie = response.headers.get('Set-Cookie');
  assert.ok(cookie, 'a successful login sets a session cookie');
  return cookie.split(';')[0];
}

function assertNoSecrets(text, ...additional) {
  for (const secret of [ADMIN.password, MEMBER.password, NEW_PASSWORD, ...hashes, ...additional]) {
    assert.ok(!text.includes(secret), 'response must not disclose a password or password hash');
  }
}

test('all guide aliases and raw account HTML require login; login resources remain reachable', async t => {
  const f = fixture(t);
  const privatePaths = ['/', '/index.html', '/interactive-itinerary.html', '/detailed-itinerary.html',
    '/detailed-itinerary.md', '/account', '/account/', '/account-ui/account.html', '/unlisted-guide-file.html'];
  for (const path of privatePaths) {
    const response = await f.request(path);
    assert.equal(response.status, 302, path);
    assert.equal(response.headers.get('Location'), `/login?next=${encodeURIComponent(path)}`);
    assert.equal(await response.text(), '');
  }
  const queryResponse = await f.request('/interactive-itinerary.html?day=2');
  assert.equal(queryResponse.headers.get('Location'), '/login?next=%2Finteractive-itinerary.html%3Fday%3D2');
  assert.equal(f.assetRequests.length, 0, 'anonymous private requests never reach static assets');
  for (const path of ['/login', '/login/', '/account-ui/auth.css', '/account-ui/auth.js']) {
    const response = await f.request(path);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /ASSET:/);
  }
  assert.deepEqual(f.assetRequests, ['/account-ui/login.html', '/account-ui/login.html', '/account-ui/auth.css', '/account-ui/auth.js']);
});

test('anonymous HEAD and unsupported methods never expose raw guide or account assets', async t => {
  const f = fixture(t);
  const paths = ['/', '/index.html', '/interactive-itinerary.html', '/detailed-itinerary.html',
    '/detailed-itinerary.md', '/account', '/account/', '/account-ui/account.html'];
  for (const path of paths) {
    const head = await f.request(path, { method: 'HEAD' });
    assert.equal(head.status, 302, `${path}: anonymous HEAD`);
    assert.equal(head.headers.get('Location'), `/login?next=${encodeURIComponent(path)}`);
    assert.equal(await head.text(), '');
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      const response = await f.request(path, { method });
      assert.equal(response.status, 405, `${path}: ${method}`);
      assert.equal(response.headers.get('Allow'), 'GET, HEAD');
      const body = await response.text();
      assert.ok(!body.includes('ASSET:'));
      assertNoSecrets(body);
    }
  }
  assert.deepEqual(f.assetRequests, [], 'no anonymous guide method reaches static assets');
});

test('private access is the default; public-guide mode still protects every account alias', async t => {
  const closed = fixture(t, { GUIDE_ACCESS: undefined });
  assert.equal((await closed.request('/')).status, 302);
  const publicGuide = fixture(t, { GUIDE_ACCESS: 'public' });
  assert.equal((await publicGuide.request('/')).status, 200);
  for (const path of ['/account', '/account/', '/account-ui/account.html']) {
    assert.equal((await publicGuide.request(path)).status, 302, path);
  }
});

test('login rejects missing or foreign origin, missing request header, and non-JSON submissions', async t => {
  const f = fixture(t);
  const cases = [
    [{ Origin: null }, 403], [{ Origin: 'https://foreign.example.test' }, 403], [{ Origin: 'null' }, 403],
    [{ 'X-Requested-With': null }, 403], [{ 'X-Requested-With': 'XMLHttpRequest' }, 403],
    [{ 'Content-Type': null }, 415], [{ 'Content-Type': 'text/plain' }, 415],
    [{ 'Content-Type': 'application/x-www-form-urlencoded' }, 415],
  ];
  for (const [headers, status] of cases) {
    const response = await f.login(ADMIN, { headers });
    assert.equal(response.status, status, JSON.stringify(headers));
    assert.equal(response.headers.get('Set-Cookie'), null);
    assertNoSecrets(await response.text());
  }
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS count FROM rate_limits').get().count, 0);
});

test('malformed, invalid, and oversized request bodies fail without echoing submitted secrets', async t => {
  const f = fixture(t);
  const malformed = ['', '{"password":', 'null', '[]', '17', '"value"', new Uint8Array([0xff, 0xfe])];
  for (const raw of malformed) {
    const response = await f.request('/api/auth/login', { method: 'POST', raw });
    assert.equal(response.status, 400);
    assertNoSecrets(await response.text());
  }
  const oversized = JSON.stringify({ username: ADMIN.username, password: ADMIN.password, padding: 'x'.repeat(9000) });
  for (const headers of [{}, { 'Content-Length': '9000' }]) {
    const response = await f.request('/api/auth/login', { method: 'POST', raw: oversized, headers });
    assert.equal(response.status, 413);
    assertNoSecrets(await response.text());
  }
  for (const body of [{}, { username: { nested: true }, password: ADMIN.password },
    { username: ADMIN.username, password: 1234 }, { username: ADMIN.username, password: 'short' }]) {
    const response = await f.request('/api/auth/login', { method: 'POST', body });
    assert.equal(response.status, 401);
    assertNoSecrets(await response.text());
  }
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 0);
});

test('unknown users, bad passwords, and disabled users receive the same generic login error', async t => {
  const f = fixture(t);
  f.sqlite.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(MEMBER.id);
  const responses = await Promise.all([
    f.login({ username: 'UnknownTraveller', password: ADMIN.password }),
    f.login({ username: ADMIN.username, password: 'TestOnly-Incorrect!31' }),
    f.login(MEMBER),
  ]);
  const bodies = [];
  for (const response of responses) {
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('Set-Cookie'), null);
    const text = await response.text();
    assertNoSecrets(text);
    bodies.push(text);
  }
  assert.equal(new Set(bodies).size, 1);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 0);
});

test('successful login normalizes username, sets a secure cookie, and stores only a hashed session token', async t => {
  const f = fixture(t);
  const response = await f.login({ ...ADMIN, username: 'tRaIlOwNeR' });
  assert.equal(response.status, 200);
  const fullCookie = response.headers.get('Set-Cookie');
  assert.match(fullCookie, /^__Host-itinerary_session=[A-Za-z0-9_-]{43};/);
  for (const flag of ['Path=/', 'HttpOnly', 'SameSite=Strict', 'Secure', 'Max-Age=604800']) assert.ok(fullCookie.includes(flag), flag);
  assert.ok(!fullCookie.includes('Domain='));
  const loginText = await response.text();
  assertNoSecrets(loginText);
  assert.deepEqual(JSON.parse(loginText), { user: { id: ADMIN.id, username: ADMIN.username, role: 'admin' } });
  const cookie = sessionCookie(response), token = cookie.split('=')[1];
  const stored = f.sqlite.prepare('SELECT * FROM sessions').get();
  assert.equal(stored.token_hash, sha256(token));
  assert.notEqual(stored.token_hash, token);
  assert.equal(stored.user_id, ADMIN.id);
  assert.ok(stored.expires_at > Math.floor(Date.now() / 1000));
  assert.deepEqual(await (await f.request('/api/auth/me', { cookie })).json(), {
    user: { id: ADMIN.id, username: ADMIN.username, role: 'admin' },
  });
  const destinations = [
    ['/', '/index.html'], ['/index.html', '/index.html'],
    ['/interactive-itinerary.html', '/interactive-itinerary.html'],
    ['/detailed-itinerary.html', '/detailed-itinerary.html'], ['/detailed-itinerary.md', '/detailed-itinerary.md'],
    ['/account', '/account-ui/account.html'], ['/account/', '/account-ui/account.html'],
    ['/account-ui/account.html', '/account-ui/account.html'],
  ];
  for (const [path, destination] of destinations) {
    const result = await f.request(path, { cookie });
    assert.equal(result.status, 200, path);
    assert.equal(await result.text(), `<html><body>ASSET:${destination}</body></html>`, path);
  }
  assert.deepEqual(f.assetRequests, destinations.map(([, destination]) => destination));
  for (const [path, destination] of destinations) {
    const head = await f.request(path, { method: 'HEAD', cookie });
    assert.equal(head.status, 200, `${path}: authenticated HEAD`);
    assert.equal(await head.text(), '');
    assert.equal(f.assetRequests.at(-1), destination);
  }
  const missing = await f.request('/missing-guide.html', { cookie });
  assert.equal(missing.status, 404, 'the asset fixture does not mask unimplemented path rewrites');
});

test('anonymous and member accounts cannot read or mutate the administration API', async t => {
  const f = fixture(t);
  const cookie = sessionCookie(await f.login(MEMBER));
  assert.deepEqual(await (await f.request('/api/auth/me', { cookie })).json(), {
    user: { id: MEMBER.id, username: MEMBER.username, role: 'member' },
  });
  for (const credential of [undefined, cookie]) {
    const expected = credential ? 403 : 401;
    const requests = [
      ['/api/admin/users', { cookie: credential }],
      ['/api/admin/users', { method: 'POST', cookie: credential, body: { username: 'NewMember', password: NEW_PASSWORD } }],
      [`/api/admin/users/${ADMIN.id}`, { method: 'PATCH', cookie: credential, body: { disabled: true } }],
    ];
    for (const [path, options] of requests) assert.equal((await f.request(path, options)).status, expected);
  }
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS count FROM users').get().count, 3);
});

test('admin creates only members, case-insensitive duplicates fail, and disabling revokes member sessions', async t => {
  const f = fixture(t);
  const adminCookie = sessionCookie(await f.login());
  const member = { username: 'NewTraveller', password: NEW_PASSWORD };
  const created = await f.request('/api/admin/users', {
    method: 'POST', cookie: adminCookie, body: { ...member, role: 'admin', disabled: true },
  });
  assert.equal(created.status, 201);
  const createdText = await created.text();
  assertNoSecrets(createdText);
  const { user } = JSON.parse(createdText);
  assert.equal(user.role, 'member');
  assert.equal(user.disabled, false);
  const row = f.sqlite.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  assert.equal(row.username_normalized, 'newtraveller');
  assert.notEqual(row.password_hash, NEW_PASSWORD);
  assert.equal(await verifyPassword(NEW_PASSWORD, row.password_hash), true);
  const duplicate = await f.request('/api/admin/users', {
    method: 'POST', cookie: adminCookie, body: { ...member, username: 'NEWTRAVELLER' },
  });
  assert.equal(duplicate.status, 409);
  const memberCookie = sessionCookie(await f.login(member));
  const secondCookie = sessionCookie(await f.login(member));
  assert.equal((await f.request(`/api/admin/users/${user.id}`, {
    method: 'PATCH', cookie: adminCookie, body: { disabled: true },
  })).status, 200);
  assert.equal(f.sqlite.prepare('SELECT disabled FROM users WHERE id = ?').get(user.id).disabled, 1);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?').get(user.id).count, 0);
  for (const cookie of [memberCookie, secondCookie]) assert.equal((await f.request('/api/auth/me', { cookie })).status, 401);
  assert.equal((await f.login(member)).status, 401);
  const listingResponse = await f.request('/api/admin/users', { cookie: adminCookie });
  const listingText = await listingResponse.text();
  assertNoSecrets(listingText, row.password_hash);
  assert.equal(JSON.parse(listingText).users.find(entry => entry.id === user.id).disabled, true);
  assert.equal((await f.request(`/api/admin/users/${user.id}`, {
    method: 'PATCH', cookie: adminCookie, body: { disabled: false },
  })).status, 200);
  assert.equal((await f.request('/api/auth/me', { cookie: memberCookie })).status, 401, 're-enabling must not revive old sessions');
  assert.equal((await f.login(member)).status, 200);
});

test('administrators cannot disable themselves or another admin, or promote a member', async t => {
  const f = fixture(t);
  const cookie = sessionCookie(await f.login());
  assert.equal((await f.request(`/api/admin/users/${ADMIN.id}`, { method: 'PATCH', cookie, body: { disabled: true } })).status, 403);
  assert.equal((await f.request('/api/admin/users/other-admin', { method: 'PATCH', cookie, body: { disabled: true } })).status, 404);
  for (const body of [{ role: 'admin', disabled: false }, { disabled: 'true' }, { disabled: false, password: NEW_PASSWORD }]) {
    assert.equal((await f.request(`/api/admin/users/${MEMBER.id}`, { method: 'PATCH', cookie, body })).status, 400);
  }
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND disabled = 0").get().count, 2);
  assert.equal(f.sqlite.prepare('SELECT role FROM users WHERE id = ?').get(MEMBER.id).role, 'member');
  assert.equal((await f.request('/api/auth/me', { cookie })).status, 200);
});

test('password changes require the old password, revoke every session, and invalidate old credentials', async t => {
  const f = fixture(t);
  const cookie = sessionCookie(await f.login(MEMBER));
  const otherCookie = sessionCookie(await f.login(MEMBER));
  const change = body => f.request('/api/auth/password', { method: 'POST', cookie, body });
  assert.equal((await change({ currentPassword: 'TestOnly-Wrong!32', newPassword: NEW_PASSWORD })).status, 400);
  assert.equal((await change({ currentPassword: MEMBER.password, newPassword: 'tiny' })).status, 400);
  assert.equal((await f.request('/api/auth/me', { cookie: otherCookie })).status, 200);
  const changed = await change({ currentPassword: MEMBER.password, newPassword: NEW_PASSWORD });
  assert.equal(changed.status, 200);
  assert.match(changed.headers.get('Set-Cookie'), /^__Host-itinerary_session=;.*Max-Age=0/);
  assertNoSecrets(await changed.text());
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?').get(MEMBER.id).count, 0);
  for (const previousCookie of [cookie, otherCookie]) assert.equal((await f.request('/api/auth/me', { cookie: previousCookie })).status, 401);
  assert.equal((await f.login(MEMBER)).status, 401);
  assert.equal((await f.login({ ...MEMBER, password: NEW_PASSWORD })).status, 200);
  const user = f.sqlite.prepare('SELECT password_hash, auth_version FROM users WHERE id = ?').get(MEMBER.id);
  assert.equal(user.auth_version, 1);
  assert.notEqual(user.password_hash, hashes[1]);
  assert.equal(await verifyPassword(NEW_PASSWORD, user.password_hash), true);
});

test('logout revokes the current session without revoking another active session', async t => {
  const f = fixture(t);
  const firstCookie = sessionCookie(await f.login(MEMBER));
  const otherCookie = sessionCookie(await f.login(MEMBER));
  const response = await f.request('/api/auth/logout', { method: 'POST', cookie: firstCookie, body: {} });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('Set-Cookie'), /Max-Age=0/);
  assert.equal((await f.request('/api/auth/me', { cookie: firstCookie })).status, 401);
  assert.equal((await f.request('/api/auth/me', { cookie: otherCookie })).status, 200);
});

test('expired, duplicated, forged, and old-version session cookies cannot authenticate', async t => {
  const f = fixture(t);
  const cookie = sessionCookie(await f.login(MEMBER));
  for (const invalid of [`${cookie}; ${cookie}`, '__Host-itinerary_session=invalid', `__Host-itinerary_session=${randomToken()}`,
    cookie.replace('__Host-itinerary_session', 'itinerary_session_dev')]) {
    assert.equal((await f.request('/api/auth/me', { cookie: invalid })).status, 401);
  }
  f.sqlite.prepare('UPDATE sessions SET expires_at = ?').run(Math.floor(Date.now() / 1000) - 1);
  assert.equal((await f.request('/api/auth/me', { cookie })).status, 401);
  const nextCookie = sessionCookie(await f.login(MEMBER));
  f.sqlite.prepare('UPDATE users SET auth_version = auth_version + 1 WHERE id = ?').run(MEMBER.id);
  assert.equal((await f.request('/api/auth/me', { cookie: nextCookie })).status, 401);
  const disabledCookie = sessionCookie(await f.login(MEMBER));
  f.sqlite.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(MEMBER.id);
  assert.equal((await f.request('/api/auth/me', { cookie: disabledCookie })).status, 401);
});

test('concurrent account limits are atomic and capitalization cannot bypass them', async t => {
  const f = fixture(t);
  const variants = ['trailowner', 'TRAILOWNER', 'TrailOwner'];
  const responses = await Promise.all(Array.from({ length: 12 }, (_, i) => f.login({
    username: variants[i % variants.length], password: 'TestOnly-Incorrect!33',
  })));
  assert.equal(responses.filter(response => response.status === 401).length, 10);
  assert.equal(responses.filter(response => response.status === 429).length, 2);
  for (const response of responses.filter(response => response.status === 429)) {
    assert.ok(Number(response.headers.get('Retry-After')) > 0);
    assertNoSecrets(await response.text());
  }
  const buckets = f.sqlite.prepare("SELECT * FROM rate_limits WHERE bucket_key LIKE 'login:account:%'").all();
  assert.equal(buckets.length, 1);
  assert.equal(buckets[0].attempts, 12);
  assert.equal(buckets[0].bucket_key, `login:account:${sha256('trailowner')}`);
  assert.equal((await f.login()).status, 429, 'valid credentials do not bypass an exhausted bucket');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 0);
});

test('the IP limit caps attempts against many accounts before creating more account buckets', async t => {
  const f = fixture(t);
  const responses = await Promise.all(Array.from({ length: 41 }, (_, i) => f.login({ username: `unknown-${i}`, password: 'short' })));
  assert.equal(responses.filter(response => response.status === 401).length, 40);
  assert.equal(responses.filter(response => response.status === 429).length, 1);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS count FROM rate_limits WHERE bucket_key LIKE 'login:account:%'").get().count, 40);
  assert.equal(f.sqlite.prepare("SELECT attempts FROM rate_limits WHERE bucket_key LIKE 'login:ip:%'").get().attempts, 41);
});

test('unsupported methods and absent services return safe errors; cleanup removes only expired rows', async t => {
  const f = fixture(t);
  const method = await f.request('/api/auth/login');
  assert.equal(method.status, 405);
  assert.equal(method.headers.get('Allow'), 'POST');
  assert.equal((await f.request('/api/unknown')).status, 404);
  assert.equal((await f.request('/login', { method: 'POST', body: {} })).status, 405);
  const missing = fixture(t, { DB: undefined });
  const unavailable = await missing.login();
  assert.equal(unavailable.status, 503);
  assertNoSecrets(await unavailable.text());
  const broken = fixture(t, { DB: { prepare() { throw new Error(`database detail ${NEW_PASSWORD}`); } } });
  const failed = await broken.login();
  assert.equal(failed.status, 503);
  assertNoSecrets(await failed.text());
  const cookie = sessionCookie(await f.login());
  const now = Math.floor(Date.now() / 1000);
  f.sqlite.prepare('INSERT INTO sessions VALUES (?, ?, 0, ?, ?)').run(sha256(randomToken()), MEMBER.id, now - 100, now - 1);
  f.sqlite.prepare('INSERT INTO rate_limits VALUES (?, ?, ?, ?)').run('expired-test', now - 100, 1, now - 1);
  await cleanup(f.env);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 1);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS count FROM rate_limits WHERE bucket_key = 'expired-test'").get().count, 0);
  assert.equal((await f.request('/api/auth/me', { cookie })).status, 200);
});
