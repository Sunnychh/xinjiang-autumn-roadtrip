import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import worker from '../backend/worker.mjs';
import { hashPassword } from '../backend/crypto.mjs';

const ORIGIN = 'https://trip.example.test';
const PASSWORD = 'Memories-Test-Only!42';
const HASH = await hashPassword(PASSWORD);
const TOKEN = 'test-only-github-token-never-return';
const OWNER = { id: 'memories-owner', username: 'MemoryOwner', role: 'admin' };
const MEMBER = { id: 'memories-member', username: 'MemoryMember', role: 'member' };
const UPLOAD_ID = '11111111-1111-4111-8111-111111111111';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8i8AAAAASUVORK5CYII=', 'base64');
const migration = readFileSync(new URL('../migrations/0001_auth.sql', import.meta.url), 'utf8');

// Real SQLite enforces the same session revocation and user constraints as D1.
class Statement {
  constructor(db, sql, parameters = []) { Object.assign(this, { db, sql, parameters }); }
  bind(...parameters) { return new Statement(this.db, this.sql, parameters); }
  async first(column) {
    const row = this.db.prepare(this.sql).get(...this.parameters);
    return row ? (column ? row[column] : { ...row }) : null;
  }
  async all() { return { success: true, results: this.db.prepare(this.sql).all(...this.parameters).map(row => ({ ...row })) }; }
  execute() {
    const result = this.db.prepare(this.sql).run(...this.parameters);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }
  async run() { return this.execute(); }
}

function fixture(t, extraEnv = {}) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec(migration);
  const now = Math.floor(Date.now() / 1000);
  const insert = sqlite.prepare(`INSERT INTO users
    (id, username, username_normalized, password_hash, role, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  for (const user of [OWNER, MEMBER]) insert.run(user.id, user.username, user.username.toLowerCase(), HASH, user.role, now, now);
  t.after(() => sqlite.close());
  const env = {
    DB: {
      prepare: sql => new Statement(sqlite, sql),
      async batch(statements) {
        sqlite.exec('BEGIN');
        try { const result = statements.map(statement => statement.execute()); sqlite.exec('COMMIT'); return result; }
        catch (error) { sqlite.exec('ROLLBACK'); throw error; }
      },
    },
    GUIDE_ACCESS: 'private', ENVIRONMENT: 'production',
    GITHUB_TOKEN: TOKEN,
    ...extraEnv,
  };
  async function request(path, { method = 'GET', body, cookie, headers = {} } = {}) {
    const outgoing = new Headers({ 'CF-Connecting-IP': '192.0.2.61' });
    if (!['GET', 'HEAD'].includes(method)) {
      outgoing.set('Origin', ORIGIN);
      outgoing.set('X-Requested-With', 'itinerary');
      if (!(body instanceof FormData)) outgoing.set('Content-Type', 'application/json');
    }
    if (cookie) outgoing.set('Cookie', cookie);
    for (const [key, value] of Object.entries(headers)) value === null ? outgoing.delete(key) : outgoing.set(key, value);
    const response = await worker.fetch(new Request(ORIGIN + path, {
      method, headers: outgoing,
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    }), env);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
    const text = await response.clone().text();
    for (const secret of [PASSWORD, HASH, TOKEN]) assert.ok(!text.includes(secret), 'API must not disclose credentials');
    return response;
  }
  async function login(user = MEMBER) {
    const response = await request('/api/auth/login', { method: 'POST', body: { username: user.username, password: PASSWORD } });
    assert.equal(response.status, 200);
    return response.headers.get('Set-Cookie').split(';')[0];
  }
  return { sqlite, env, request, login };
}

function photoForm({ bytes = PNG, type = 'image/png', name = '旅途.png', caption, uploadId = UPLOAD_ID } = {}) {
  const form = new FormData();
  form.append('photo', new File([bytes], name, { type }));
  if (caption !== undefined) form.append('caption', caption);
  form.append('uploadId', uploadId);
  return form;
}

test('memory status, upload, and retry lookup require a current authenticated session', async t => {
  const f = fixture(t);
  let githubCalls = 0;
  t.mock.method(globalThis, 'fetch', async () => { githubCalls++; throw new Error('Unexpected outbound request'); });
  for (const [path, options] of [
    ['/api/memories/status', {}],
    ['/api/memories/photo', { method: 'POST', body: photoForm() }],
    [`/api/memories/photo/${UPLOAD_ID}`, {}],
  ]) {
    const response = await f.request(path, options);
    assert.equal(response.status, 401, path);
  }
  const cookie = await f.login();
  f.sqlite.prepare('DELETE FROM sessions WHERE user_id = ?').run(MEMBER.id);
  assert.equal((await f.request('/api/memories/status', { cookie })).status, 401);
  assert.equal((await f.request('/api/memories/photo', { method: 'POST', body: photoForm(), cookie })).status, 401);
  assert.equal(githubCalls, 0, 'authentication failures never call GitHub');
});

test('photo upload rejects cross-origin and missing request headers before any storage call', async t => {
  const f = fixture(t), cookie = await f.login();
  let githubCalls = 0;
  t.mock.method(globalThis, 'fetch', async () => { githubCalls++; throw new Error('Unexpected outbound request'); });
  for (const headers of [
    { Origin: null }, { Origin: 'null' }, { Origin: 'https://other.example.test' },
    { 'X-Requested-With': null }, { 'X-Requested-With': 'XMLHttpRequest' },
  ]) {
    assert.equal((await f.request('/api/memories/photo', { method: 'POST', body: photoForm(), cookie, headers })).status, 403);
  }
  assert.equal((await f.request('/api/memories/photo', { method: 'POST', body: {}, cookie })).status, 415);
  assert.equal(githubCalls, 0);
});

test('file boundaries reject SVG, misleading MIME, oversize, duplicate fields, and invalid captions without storage writes', async t => {
  const f = fixture(t), cookie = await f.login();
  let writes = 0;
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    if (init.method && init.method !== 'GET') writes++;
    throw new Error('Validation must occur before storage writes');
  });
  const duplicatePhoto = photoForm(); duplicatePhoto.append('photo', new File([PNG], 'another.png', { type: 'image/png' }));
  const duplicateCaption = photoForm({ caption: 'one' }); duplicateCaption.append('caption', 'two');
  const duplicateId = photoForm(); duplicateId.append('uploadId', UPLOAD_ID);
  const duplicateName = photoForm(); duplicateName.append('filename', '../../escape');
  const missingPhoto = new FormData(); missingPhoto.append('uploadId', UPLOAD_ID);
  const cases = [
    [photoForm({ bytes: '<svg onload="alert(1)"></svg>', type: 'image/svg+xml', name: 'unsafe.svg' }), 415],
    [photoForm({ bytes: '<script>bad</script>', type: 'image/png' }), 415],
    [photoForm({ bytes: Buffer.concat([PNG, Buffer.alloc(20 * 1024 * 1024)]) }), 413],
    [duplicatePhoto, 400], [duplicateCaption, 400], [duplicateId, 400], [duplicateName, 400], [missingPhoto, 400],
    [photoForm({ caption: 'x'.repeat(4001) }), 400],
    [photoForm({ bytes: PNG.subarray(0, 32) }), 415],
    [photoForm({ uploadId: '../somewhere' }), 400],
  ];
  for (const [body, expected] of cases) {
    const response = await f.request('/api/memories/photo', { method: 'POST', body, cookie });
    assert.equal(response.status, expected);
  }
  assert.equal(writes, 0);
});

// A miniature Git graph tracks only reachable commits. Unreferenced blobs do not
// count as saved photos, just as an interrupted Git Database API upload does not.
function github(t) {
  const root = '/repos/Sunnychh/xinjiang-trip-memories';
  const sha = value => createHash('sha1').update(value).digest('hex');
  const blobs = new Map(), trees = new Map(), commits = new Map(), calls = [];
  const firstTree = sha('empty tree'), firstCommit = sha('initial commit');
  trees.set(firstTree, new Map()); commits.set(firstCommit, { tree: { sha: firstTree } });
  const state = { head: firstCommit, calls, blobs, onRequest: null };
  const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  state.visible = () => trees.get(commits.get(state.head).tree.sha);
  t.mock.method(globalThis, 'fetch', async (input, options = {}) => {
    const url = new URL(input), method = options.method || 'GET';
    const body = options.body === undefined ? undefined : await new Response(options.body).json();
    assert.equal(url.origin, 'https://api.github.com');
    assert.ok(url.pathname === root || url.pathname.startsWith(root + '/'));
    assert.equal(options.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(options.redirect, 'manual');
    calls.push({ path: url.pathname, method, body });
    await state.onRequest?.({ path: url.pathname, method, body });
    const path = url.pathname.slice(root.length);
    if (!path) return response({ private: true, full_name: 'Sunnychh/xinjiang-trip-memories' });
    if (path === '/git/ref/heads/main') return response({ object: { sha: state.head, type: 'commit' } });
    if (path.startsWith('/contents/')) {
      const prefix = decodeURIComponent(path.slice('/contents/'.length)) + '/';
      const commit = commits.get(url.searchParams.get('ref'));
      const entries = [...trees.get(commit.tree.sha)].filter(([name]) => name.startsWith(prefix)).map(([name, hash]) => ({ name: name.slice(prefix.length), path: name, sha: hash, size: blobs.get(hash).length, type: 'file' }));
      return response(entries, entries.length ? 200 : 404);
    }
    if (path.startsWith('/git/blobs/')) return response({ content: blobs.get(path.slice('/git/blobs/'.length)).toString('base64'), encoding: 'base64' });
    if (path.startsWith('/git/commits/')) return response(commits.get(path.slice('/git/commits/'.length)));
    if (path === '/git/blobs' && method === 'POST') {
      const bytes = Buffer.from(body.content, body.encoding === 'base64' ? 'base64' : 'utf8');
      const hash = sha(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]));
      blobs.set(hash, bytes); return response({ sha: hash }, 201);
    }
    if (path === '/git/trees' && method === 'POST') {
      const tree = new Map(trees.get(body.base_tree));
      for (const entry of body.tree) tree.set(entry.path, entry.sha);
      const hash = sha(JSON.stringify([...tree])); trees.set(hash, tree); return response({ sha: hash }, 201);
    }
    if (path === '/git/commits' && method === 'POST') {
      const hash = sha(JSON.stringify(body)); commits.set(hash, { tree: { sha: body.tree }, parents: body.parents }); return response({ sha: hash }, 201);
    }
    if (path === '/git/refs/heads/main' && method === 'PATCH') {
      assert.equal(body.force, false);
      if (commits.get(body.sha).parents[0] !== state.head) return response({}, 422);
      state.head = body.sha; return response({ object: { sha: state.head } });
    }
    assert.fail(`Unexpected GitHub endpoint: ${method} ${path}`);
  });
  return state;
}

test('status verifies storage and advertises supported uploads without leaking the token', async t => {
  const f = fixture(t), cookie = await f.login(), g = github(t);
  const response = await f.request('/api/memories/status', { cookie });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    configured: true, maxBytes: 20 * 1024 * 1024,
    acceptedTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'],
  });
  assert.deepEqual(g.calls.map(call => call.path), ['/repos/Sunnychh/xinjiang-trip-memories']);
  f.env.GITHUB_TOKEN = '';
  assert.equal((await (await f.request('/api/memories/status', { cookie })).json()).configured, false);
  assert.equal((await f.request('/api/memories/photo', { method: 'POST', body: photoForm(), cookie })).status, 503);
});

test('upload preserves exact image bytes and JSON-safe text; server upload time is never inferred capture time', async t => {
  const f = fixture(t), cookie = await f.login(), g = github(t);
  const caption = '湖边\n"风景" </script><script>window.bad=true</script> 🌄';
  const before = Date.now();
  const response = await f.request('/api/memories/photo', {
    method: 'POST', cookie, body: photoForm({ caption, type: 'application/octet-stream', name: 'IMG_19990101_000000.png' }),
  });
  assert.equal(response.status, 201);
  const { record, duplicate } = await response.json();
  assert.equal(duplicate, false);
  assert.equal(record.id, UPLOAD_ID);
  assert.equal(record.caption, caption);
  assert.equal(record.mimeType, 'image/png', 'detected bytes override untrusted client MIME');
  assert.equal(record.captureTime, null);
  assert.equal(record.location, null);
  assert.ok(Date.parse(record.uploadedAt) >= Math.floor(before / 1000) * 1000);
  assert.ok(Date.parse(record.uploadedAt) <= Date.now());
  assert.deepEqual(record.uploader, { id: MEMBER.id, username: MEMBER.username });
  assert.equal(record.sha256, createHash('sha256').update(PNG).digest('hex'));
  const visible = g.visible();
  assert.equal(visible.size, 2, 'one published commit makes the photo and its record visible together');
  assert.deepEqual(g.blobs.get(visible.get(record.photoPath)), PNG);
  const sidecar = [...visible].find(([path]) => path.endsWith('/record.json'));
  const { metadataPath, ...persistedRecord } = record;
  assert.equal(metadataPath, sidecar[0]);
  assert.deepEqual(JSON.parse(g.blobs.get(sidecar[1]).toString('utf8')), persistedRecord);
  assert.equal(g.calls.filter(call => call.method === 'PATCH').length, 1);
});

test('same UUID is idempotent; changed payload conflicts; retry lookup is scoped to the uploader', async t => {
  const f = fixture(t), cookie = await f.login(), otherCookie = await f.login(OWNER), g = github(t);
  const first = await f.request('/api/memories/photo', { method: 'POST', cookie, body: photoForm() });
  assert.equal(first.status, 201);
  const saved = (await first.json()).record;
  assert.equal(saved.caption, '', 'caption is optional');
  const writes = () => g.calls.filter(call => call.method !== 'GET').length;
  const before = writes();
  const retry = await f.request('/api/memories/photo', { method: 'POST', cookie, body: photoForm() });
  assert.equal(retry.status, 200);
  const retryResult = await retry.json();
  assert.deepEqual(retryResult.record, saved);
  assert.equal(retryResult.duplicate, true);
  assert.equal(retryResult.commitSha, g.head);
  assert.equal(writes(), before, 'retry never creates another blob, tree, or commit');
  const changed = await f.request('/api/memories/photo', { method: 'POST', cookie, body: photoForm({ caption: 'different' }) });
  assert.equal(changed.status, 409);
  assert.equal(writes(), before);
  const found = await f.request(`/api/memories/photo/${UPLOAD_ID}`, { cookie });
  assert.equal(found.status, 200);
  const foundResult = await found.json();
  assert.deepEqual(foundResult.record, saved);
  assert.equal(foundResult.commitSha, g.head);
  const hidden = await f.request(`/api/memories/photo/${UPLOAD_ID}`, { cookie: otherCookie });
  assert.equal(hidden.status, 404, 'even another admin cannot look up the uploader’s record');
  assert.ok(!await hidden.text().then(text => text.includes(saved.photoPath)));
});

test('session revocation while upload is in flight prevents publishing the Git ref', async t => {
  const f = fixture(t), cookie = await f.login(), g = github(t);
  g.onRequest = ({ path, method }) => {
    if (path.endsWith('/git/commits') && method === 'POST') f.sqlite.prepare('DELETE FROM sessions WHERE user_id = ?').run(MEMBER.id);
  };
  const response = await f.request('/api/memories/photo', { method: 'POST', cookie, body: photoForm() });
  assert.equal(response.status, 401);
  assert.equal(g.visible().size, 0, 'unreferenced staging objects are never acknowledged as saved');
  assert.equal(g.calls.filter(call => call.method === 'PATCH').length, 0);
});
