import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { GitHubStorage } from '../backend/github-storage.mjs';

const REPO = '/repos/Sunnychh/xinjiang-trip-memories';
const TOKEN = 'storage-test-only-token';
const hash = value => createHash('sha1').update(value).digest('hex');
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

function fixture(t, options = {}) {
  // Cross multiple streamed base64 chunks, including an unaligned final byte.
  const bytes = Buffer.from(Array.from({ length: 2 * 48 * 1024 + 5 }, (_, index) => index % 251));
  const photoGitSha = hash(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]));
  const directory = 'records/inbox/member/11111111-1111-4111-8111-111111111111';
  const record = { id: '11111111-1111-4111-8111-111111111111', photoPath: `${directory}/photo.png`,
    metadataPath: `${directory}/record.json`, sha256: createHash('sha256').update(bytes).digest('hex'),
    byteLength: bytes.length, mimeType: 'image/png', caption: '' };
  const calls = [], blobs = new Map(), trees = new Map(), commits = new Map();
  const initialTree = hash('initial-tree'), initialCommit = hash('initial-commit');
  trees.set(initialTree, new Map([['README.md', hash('readme')]]));
  commits.set(initialCommit, { tree: { sha: initialTree }, parents: [] });
  const state = { calls, blobs, trees, commits, head: initialCommit, private: true, revoked: false, checks: 0,
    writes: () => calls.filter(call => call.method !== 'GET'),
    visible: () => trees.get(commits.get(state.head).tree.sha) };
  const reply = (data, status = 200) => new Response(JSON.stringify(data), { status });
  t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
    const url = new URL(input), method = init.method || 'GET';
    const body = init.body === undefined ? undefined : await new Response(init.body).json();
    assert.equal(url.origin, 'https://api.github.com');
    assert.ok(url.pathname === REPO || url.pathname.startsWith(REPO + '/'));
    assert.equal(init.redirect, 'manual');
    assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
    const path = url.pathname.slice(REPO.length);
    calls.push({ path, method, body });
    if (options.before) await options.before({ path, method, body, state });
    if (options.fail === path && method !== 'GET') return reply({ message: `private upstream detail ${TOKEN}` }, 500);
    if (!path) return reply({ private: state.private, full_name: options.fullName || 'Sunnychh/xinjiang-trip-memories' });
    if (path === '/git/ref/heads/main') return reply({ object: { sha: state.head, type: 'commit' } });
    if (path.startsWith('/contents/')) return reply({ message: 'not found' }, 404);
    if (path.startsWith('/git/commits/')) return reply(commits.get(path.slice('/git/commits/'.length)));
    if (path === '/git/blobs' && method === 'POST') {
      const content = Buffer.from(body.content, body.encoding === 'base64' ? 'base64' : 'utf8');
      const sha = hash(Buffer.concat([Buffer.from(`blob ${content.length}\0`), content]));
      blobs.set(sha, content); return reply({ sha }, 201);
    }
    if (path === '/git/trees' && method === 'POST') {
      const tree = new Map(trees.get(body.base_tree));
      for (const entry of body.tree) tree.set(entry.path, entry.sha);
      const sha = hash(JSON.stringify([...tree])); trees.set(sha, tree); return reply({ sha }, 201);
    }
    if (path === '/git/commits' && method === 'POST') {
      const sha = hash(JSON.stringify(body)); commits.set(sha, { tree: { sha: body.tree }, parents: body.parents }); return reply({ sha }, 201);
    }
    if (path === '/git/refs/heads/main' && method === 'PATCH') {
      assert.equal(body.force, false);
      if (commits.get(body.sha).parents[0] !== state.head) return reply({ message: 'Not fast forward' }, 422);
      state.head = body.sha; return reply({ object: { sha: state.head } });
    }
    assert.fail(`Unexpected GitHub call: ${method} ${path}`);
  });
  const storage = new GitHubStorage({ env: { GITHUB_TOKEN: TOKEN }, HttpError,
    requireCurrentUser: async () => { state.checks++; if (state.revoked) throw new HttpError(401, 'Session revoked'); } });
  return { state, storage, bytes, photoGitSha, record, directory,
    save: () => storage.save({ bytes, record, photoGitSha, directory, validateRecord: value => value }) };
}

test('only the fixed private repository is accepted, before any Git objects are written', async t => {
  for (const kind of ['public', 'wrong repository']) await t.test(kind, async sub => {
    const f = fixture(sub, kind === 'wrong repository' ? { fullName: 'Other/elsewhere' } : {});
    if (kind === 'public') f.state.private = false;
    await assert.rejects(f.save(), error => error.status === 503 && !error.message.includes(TOKEN));
    assert.equal(f.state.writes().length, 0);
    assert.deepEqual(f.state.calls.map(call => call.path), ['']);
  });
});

test('an upstream redirect is rejected without following it or forwarding the token', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push(String(url));
    assert.equal(String(url), `https://api.github.com${REPO}`);
    assert.equal(init.redirect, 'manual', 'the runtime must not follow credential-bearing redirects');
    return new Response(null, { status: 302, headers: { Location: 'https://untrusted.example.test/collect' } });
  });
  const storage = new GitHubStorage({ env: { GITHUB_TOKEN: TOKEN }, HttpError, requireCurrentUser: async () => {} });
  await assert.rejects(storage.verifyPrivate(), error => error.status === 503 && !error.message.includes(TOKEN));
  assert.deepEqual(calls, [`https://api.github.com${REPO}`], 'no follow-up request sends credentials to the redirect destination');
});

test('photo bytes and JSON record become visible in one non-forced commit that keeps unrelated files', async t => {
  const f = fixture(t), before = f.state.head;
  const saved = await f.save();
  assert.equal(saved.duplicate, false);
  assert.equal(saved.commitSha, f.state.head);
  assert.notEqual(f.state.head, before);
  const visible = f.state.visible();
  assert.equal(visible.size, 3);
  assert.ok(visible.has('README.md'));
  assert.deepEqual(f.state.blobs.get(visible.get(f.record.photoPath)), f.bytes);
  assert.deepEqual(JSON.parse(f.state.blobs.get(visible.get(`${f.directory}/record.json`))), f.record);
  const writes = f.state.writes();
  assert.deepEqual(writes.map(call => call.path), ['/git/blobs', '/git/blobs', '/git/trees', '/git/commits', '/git/refs/heads/main']);
  assert.equal(writes.find(call => call.path === '/git/trees').body.tree.length, 2);
  assert.ok(f.state.checks >= writes.length, 'live sessions are checked before each external write');
});

test('staging or publication failure never acknowledges a partial saved photo or leaks upstream credentials', async t => {
  for (const failedPath of ['/git/blobs', '/git/trees', '/git/commits', '/git/refs/heads/main']) await t.test(failedPath, async sub => {
    const f = fixture(sub, { fail: failedPath }), before = f.state.head;
    await assert.rejects(f.save(), error => error.status === 503 && !error.message.includes(TOKEN) && !error.message.includes('private upstream detail'));
    assert.equal(f.state.head, before);
    assert.deepEqual([...f.state.visible().keys()], ['README.md']);
    if (failedPath !== '/git/refs/heads/main') assert.equal(f.state.calls.filter(call => call.method === 'PATCH').length, 0);
  });
});

test('a concurrently advanced main is retried from its new tree without duplicating photo blobs', async t => {
  let raced = false, concurrentHead;
  const f = fixture(t, { before({ path, method, state }) {
    if (path !== '/git/refs/heads/main' || method !== 'PATCH' || raced) return;
    raced = true;
    const tree = new Map(state.visible()); tree.set('other-traveller/photo.jpg', hash('other photo'));
    const treeSha = hash('concurrent-tree'); concurrentHead = hash('concurrent-commit');
    state.trees.set(treeSha, tree); state.commits.set(concurrentHead, { tree: { sha: treeSha }, parents: [state.head] });
    state.head = concurrentHead;
  } });
  const saved = await f.save();
  assert.equal(saved.duplicate, false);
  assert.equal(f.state.calls.filter(call => call.method === 'PATCH').length, 2);
  assert.equal(f.state.calls.filter(call => call.path === '/git/blobs').length, 2, 'retry reuses both already-created blobs');
  assert.deepEqual(f.state.commits.get(f.state.head).parents, [concurrentHead]);
  assert.ok(f.state.visible().has('other-traveller/photo.jpg'));
  assert.ok(f.state.visible().has('README.md'));
  assert.ok(f.state.visible().has(f.record.photoPath));
});

test('privacy changes or session revocation before publication prevent the ref write', async t => {
  for (const change of ['privacy', 'session']) await t.test(change, async sub => {
    const f = fixture(sub, { before({ path, method, state }) {
      if (path === '/git/commits' && method === 'POST') {
        if (change === 'privacy') state.private = false;
        else state.revoked = true;
      }
    } });
    await assert.rejects(f.save(), error => error.status === (change === 'privacy' ? 503 : 401));
    assert.equal(f.state.calls.filter(call => call.method === 'PATCH').length, 0);
    assert.equal(f.state.visible().size, 1);
  });
});
