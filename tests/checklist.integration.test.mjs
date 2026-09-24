import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import worker from '../backend/worker.mjs';
import { hashPassword } from '../backend/crypto.mjs';
import catalog from '../data/preparation-checklist.json' with { type: 'json' };

const ORIGIN = 'https://trip.example.test';
const PASSWORD = 'Checklist-Test-Only!42';
const HASH = await hashPassword(PASSWORD);
const OWNER = { id: 'checklist-owner', username: 'ChecklistOwner', role: 'admin' };
const MEMBER = { id: 'checklist-member', username: 'ChecklistMember', role: 'member' };
const IDS = catalog.stages.flatMap(stage => stage.items.map(item => item.id));
const FIRST = IDS[0], SECOND = IDS[1];
const EMPTY = { completed: false, version: 0, updatedAt: null };
const migrations = ['0001_auth.sql', '0002_checklist.sql'].map(name =>
  readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));

// Actual SQLite constraints and conditional writes, with the D1 methods used by
// production. A hook lets a test revoke access immediately before a SQL write.
class Statement {
  constructor(fixture, sql, parameters = []) { Object.assign(this, { fixture, sql, parameters }); }
  bind(...parameters) { return new Statement(this.fixture, this.sql, parameters); }
  before() { this.fixture.beforeStatement?.(this.sql, this.parameters); }
  async first(column) {
    this.before();
    const row = this.fixture.sqlite.prepare(this.sql).get(...this.parameters);
    return row ? (column ? row[column] : { ...row }) : null;
  }
  async all() {
    this.before();
    return { success: true, results: this.fixture.sqlite.prepare(this.sql).all(...this.parameters).map(row => ({ ...row })) };
  }
  execute() {
    this.before();
    const result = this.fixture.sqlite.prepare(this.sql).run(...this.parameters);
    return { success: true, results: [], meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
  }
  async run() { return this.execute(); }
}

function fixture(t) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  for (const migration of migrations) sqlite.exec(migration);
  const now = Math.floor(Date.now() / 1000);
  const insert = sqlite.prepare(`INSERT INTO users
    (id, username, username_normalized, password_hash, role, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  for (const user of [OWNER, MEMBER]) insert.run(user.id, user.username, user.username.toLowerCase(), HASH, user.role, now, now);
  t.after(() => sqlite.close());
  const f = { sqlite, beforeStatement: null };
  const env = {
    DB: {
      prepare: sql => new Statement(f, sql),
      async batch(statements) {
        sqlite.exec('BEGIN');
        try {
          const results = statements.map(statement => statement.execute());
          sqlite.exec('COMMIT');
          return results;
        } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
      },
    },
    GUIDE_ACCESS: 'private',
    ENVIRONMENT: 'production',
  };
  f.request = async (path, { method = 'GET', body, cookie, headers = {} } = {}) => {
    const requestHeaders = new Headers({ 'CF-Connecting-IP': '192.0.2.21' });
    if (method !== 'GET' && method !== 'HEAD') {
      requestHeaders.set('Origin', ORIGIN);
      requestHeaders.set('Content-Type', 'application/json');
      requestHeaders.set('X-Requested-With', 'itinerary');
    }
    if (cookie) requestHeaders.set('Cookie', cookie);
    for (const [key, value] of Object.entries(headers)) {
      if (value === null) requestHeaders.delete(key);
      else requestHeaders.set(key, value);
    }
    const response = await worker.fetch(new Request(`${ORIGIN}${path}`, {
      method, headers: requestHeaders, body: body === undefined ? undefined : JSON.stringify(body),
    }), env);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.equal(response.headers.get('X-Frame-Options'), 'DENY');
    assert.equal(response.headers.get('Referrer-Policy'), 'same-origin');
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
    const text = await response.clone().text();
    assert.ok(!text.includes(PASSWORD) && !text.includes(HASH), 'responses never contain fixture credentials');
    return response;
  };
  f.login = async (user = MEMBER) => {
    const response = await f.request('/api/auth/login', {
      method: 'POST', body: { username: user.username, password: PASSWORD },
    });
    assert.equal(response.status, 200);
    assert.ok(response.headers.get('Set-Cookie'));
    return response.headers.get('Set-Cookie').split(';')[0];
  };
  f.patch = (cookie, id = FIRST, completed = true, version = 0, options = {}) =>
    f.request(`/api/checklist/${id}`, { method: 'PATCH', cookie, body: { completed, version }, ...options });
  return f;
}

test('checklist requires authentication and returns no-store defaults for every catalog item', async t => {
  assert.ok(IDS.length >= 2, 'the production catalog has independently trackable items');
  assert.equal(new Set(IDS).size, IDS.length, 'catalog identifiers must be unique');
  const f = fixture(t);
  for (const response of [await f.request('/api/checklist'), await f.patch(undefined)]) {
    assert.equal(response.status, 401);
    assert.deepEqual(Object.keys(await response.json()), ['error']);
  }
  const cookie = await f.login();
  const response = await f.request('/api/checklist', { cookie });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.catalogVersion, catalog.version);
  assert.deepEqual(result.user, { id: MEMBER.id, username: MEMBER.username });
  assert.deepEqual(Object.keys(result.states).sort(), [...IDS].sort());
  for (const value of Object.values(result.states)) assert.deepEqual(value, EMPTY);
  assert.ok(Number.isSafeInteger(result.serverTime) && result.serverTime > 0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS count FROM checklist_items').get().count, 0,
    'reading untouched defaults does not create state rows');
});

test('a successful save persists through GET, logout, and a fresh authenticated session', async t => {
  const f = fixture(t), cookie = await f.login();
  const saved = await f.patch(cookie);
  assert.equal(saved.status, 200);
  const { item } = await saved.json();
  assert.deepEqual({ id: item.id, completed: item.completed, version: item.version },
    { id: FIRST, completed: true, version: 1 });
  assert.ok(Number.isSafeInteger(item.updatedAt) && item.updatedAt > 0);
  const state = { completed: item.completed, version: item.version, updatedAt: item.updatedAt };
  assert.deepEqual((await (await f.request('/api/checklist', { cookie })).json()).states[FIRST], state);
  assert.equal((await f.request('/api/auth/logout', { method: 'POST', cookie, body: {} })).status, 200);
  const nextCookie = await f.login();
  assert.notEqual(nextCookie, cookie);
  assert.deepEqual((await (await f.request('/api/checklist', { cookie: nextCookie })).json()).states[FIRST], state);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS count FROM checklist_items').get().count, 1);
});

test('members and administrators have separate states and query parameters cannot impersonate another user', async t => {
  const f = fixture(t), memberCookie = await f.login(), ownerCookie = await f.login(OWNER);
  assert.equal((await f.patch(memberCookie)).status, 200);
  const ownerBefore = await (await f.request(`/api/checklist?userId=${MEMBER.id}`, { cookie: ownerCookie })).json();
  assert.deepEqual(ownerBefore.user, { id: OWNER.id, username: OWNER.username });
  assert.deepEqual(ownerBefore.states[FIRST], EMPTY);
  assert.equal((await f.patch(ownerCookie, FIRST, false)).status, 200);
  assert.equal((await f.patch(ownerCookie, SECOND, true)).status, 200);
  const member = await (await f.request('/api/checklist', { cookie: memberCookie })).json();
  const owner = await (await f.request('/api/checklist', { cookie: ownerCookie })).json();
  assert.equal(member.states[FIRST].completed, true);
  assert.deepEqual(member.states[SECOND], EMPTY);
  assert.equal(owner.states[FIRST].completed, false);
  assert.equal(owner.states[FIRST].version, 1);
  assert.equal(owner.states[SECOND].completed, true);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS count FROM checklist_items').get().count, 3);
});

test('stale writes return 409 with canonical state, including matching desired values and absent records', async t => {
  const f = fixture(t), cookie = await f.login();
  const canonical = (await (await f.patch(cookie)).json()).item;
  for (const completed of [false, true]) {
    const response = await f.patch(cookie, FIRST, completed, 0);
    assert.equal(response.status, 409);
    const conflict = await response.json();
    assert.equal(typeof conflict.error, 'string');
    assert.deepEqual(conflict.item, canonical);
  }
  const absent = await f.patch(cookie, SECOND, true, 5);
  assert.equal(absent.status, 409);
  assert.deepEqual((await absent.json()).item, { id: SECOND, ...EMPTY });
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS count FROM checklist_items').get().count, 1);
});

test('concurrent writes using one version produce one success and one conflict without lost updates', async t => {
  const f = fixture(t), cookie = await f.login();
  const responses = await Promise.all([f.patch(cookie, FIRST, true, 0), f.patch(cookie, FIRST, false, 0)]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
  const saved = await responses.find(response => response.status === 200).json();
  const conflict = await responses.find(response => response.status === 409).json();
  assert.deepEqual(conflict.item, saved.item);
  assert.equal(saved.item.version, 1);
  const row = f.sqlite.prepare('SELECT completed, version FROM checklist_items WHERE user_id = ? AND item_id = ?').get(MEMBER.id, FIRST);
  assert.equal(Boolean(row.completed), saved.item.completed);
  assert.equal(row.version, 1);
});

test('unknown IDs, malformed states, extra fields, and forged ownership never mutate the checklist', async t => {
  const f = fixture(t), cookie = await f.login();
  for (const id of ['missing-catalog-item', '', `${FIRST}/extra`, encodeURIComponent("'; DELETE FROM users;--")]) {
    assert.equal((await f.patch(cookie, id)).status, 404, id);
  }
  const invalidBodies = [
    {}, { completed: true }, { version: 0 }, { completed: 1, version: 0 },
    { completed: 'true', version: 0 }, { completed: null, version: 0 },
    { completed: true, version: -1 }, { completed: true, version: 1.1 },
    { completed: true, version: '0' }, { completed: true, version: null },
    { completed: true, version: Number.MAX_SAFE_INTEGER },
    { completed: true, version: Number.MAX_SAFE_INTEGER + 1 },
    { completed: true, version: 0, userId: OWNER.id },
    { completed: true, version: 0, user_id: OWNER.id },
    { completed: true, version: 0, username: OWNER.username },
    { completed: true, version: 0, updatedAt: 1 },
    { completed: true, version: 0, role: 'admin' },
    { completed: true, version: 0, extra: true },
  ];
  for (const body of invalidBodies) {
    const response = await f.patch(cookie, FIRST, true, 0, { body });
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(typeof (await response.json()).error, 'string');
  }
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS count FROM checklist_items').get().count, 0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS count FROM users').get().count, 2);
});

test('checklist mutation requires same-origin JSON requests and the explicit request header', async t => {
  const f = fixture(t), cookie = await f.login();
  for (const [headers, status] of [
    [{ Origin: null }, 403], [{ Origin: 'https://foreign.example.test' }, 403],
    [{ Origin: 'null' }, 403], [{ 'X-Requested-With': null }, 403],
    [{ 'X-Requested-With': 'XMLHttpRequest' }, 403],
    [{ 'Content-Type': 'text/plain' }, 415], [{ 'Content-Type': null }, 415],
  ]) {
    assert.equal((await f.patch(cookie, FIRST, true, 0, { headers })).status, status);
  }
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS count FROM checklist_items').get().count, 0);
});

test('false saves are persisted and every accepted write advances version and server timestamp', async t => {
  let clock = Date.now();
  t.mock.method(Date, 'now', () => clock);
  const f = fixture(t), cookie = await f.login();
  const first = (await (await f.patch(cookie, FIRST, false, 0)).json()).item;
  assert.deepEqual(first, { id: FIRST, completed: false, version: 1, updatedAt: Math.floor(clock / 1000) });
  clock += 5000;
  const repeated = (await (await f.patch(cookie, FIRST, false, 1)).json()).item;
  assert.deepEqual(repeated, { id: FIRST, completed: false, version: 2, updatedAt: Math.floor(clock / 1000) });
  assert.ok(repeated.updatedAt > first.updatedAt);
  clock += 5000;
  const completed = (await (await f.patch(cookie, FIRST, true, 2)).json()).item;
  assert.deepEqual(completed, { id: FIRST, completed: true, version: 3, updatedAt: Math.floor(clock / 1000) });
  clock += 5000;
  const unchecked = (await (await f.patch(cookie, FIRST, false, 3)).json()).item;
  assert.deepEqual(unchecked, { id: FIRST, completed: false, version: 4, updatedAt: Math.floor(clock / 1000) });
  const state = (await (await f.request('/api/checklist', { cookie })).json()).states[FIRST];
  assert.deepEqual(state, { completed: false, version: 4, updatedAt: unchecked.updatedAt });
});

test('logged-out, disabled, expired, and invalidated sessions cannot read or overwrite saved states', async t => {
  for (const kind of ['logout', 'disabled', 'expired', 'version']) {
    await t.test(kind, async sub => {
      const f = fixture(sub), cookie = await f.login();
      assert.equal((await f.patch(cookie)).status, 200);
      if (kind === 'logout') {
        assert.equal((await f.request('/api/auth/logout', { method: 'POST', cookie, body: {} })).status, 200);
      } else if (kind === 'disabled') {
        const adminCookie = await f.login(OWNER);
        assert.equal((await f.request(`/api/admin/users/${MEMBER.id}`, {
          method: 'PATCH', cookie: adminCookie, body: { disabled: true },
        })).status, 200);
      } else if (kind === 'expired') {
        f.sqlite.prepare('UPDATE sessions SET expires_at = ? WHERE user_id = ?').run(Math.floor(Date.now() / 1000) - 1, MEMBER.id);
      } else {
        f.sqlite.prepare('UPDATE users SET auth_version = auth_version + 1 WHERE id = ?').run(MEMBER.id);
      }
      assert.equal((await f.request('/api/checklist', { cookie })).status, 401);
      assert.equal((await f.patch(cookie, FIRST, false, 1)).status, 401);
      const row = f.sqlite.prepare('SELECT completed, version FROM checklist_items WHERE user_id = ? AND item_id = ?').get(MEMBER.id, FIRST);
      assert.deepEqual({ ...row }, { completed: 1, version: 1 });
    });
  }
});

test('revocation between authentication and conditional SQL write cannot create or update a state', async t => {
  for (const existing of [false, true]) {
    await t.test(existing ? 'update' : 'insert', async sub => {
      const f = fixture(sub), cookie = await f.login();
      if (existing) assert.equal((await f.patch(cookie)).status, 200);
      let intercepted = false;
      f.beforeStatement = sql => {
        if (!intercepted && /(?:INSERT INTO|UPDATE) checklist_items/.test(sql)) {
          intercepted = true;
          f.sqlite.prepare('DELETE FROM sessions WHERE user_id = ?').run(MEMBER.id);
        }
      };
      assert.equal((await f.patch(cookie, FIRST, false, existing ? 1 : 0)).status, 401);
      assert.equal(intercepted, true, 'revocation was injected after authentication but before mutation');
      const rows = f.sqlite.prepare('SELECT completed, version FROM checklist_items WHERE user_id = ?').all(MEMBER.id);
      assert.deepEqual(rows.map(row => ({ ...row })), existing ? [{ completed: 1, version: 1 }] : []);
    });
  }
});
