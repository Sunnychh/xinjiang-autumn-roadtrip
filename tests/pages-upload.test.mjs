import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { connect, MAX_BYTES, PhotoError } from '../upload/github.mjs';

const ROOT = '/repos/Sunnychh/xinjiang-trip-memories';
const TOKEN = 'github_pat_LOCAL_TEST_ONLY_12345678901234567890';
const USER = { id: 73129, login: 'TestTraveller' };
const ID = '22222222-2222-4222-8222-222222222222';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8i8AAAAASUVORK5CYII=', 'base64');
const sha = value => createHash('sha1').update(value).digest('hex');
const file = (bytes = PNG, name = '山间.png', type = 'image/png') => new File([bytes], name, { type });
const reply = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers });

// Model reachable Git trees, so an orphaned staging blob is never treated as a
// saved photo. fetchImpl is injected: these tests cannot reach the real network.
function graph(options = {}) {
  const blobs = new Map(), trees = new Map(), commits = new Map(), calls = [];
  const firstTree = sha('first tree'), firstHead = sha('first commit');
  trees.set(firstTree, new Map([['README.md', sha('existing readme')]]));
  commits.set(firstHead, { tree: { sha: firstTree }, parents: [] });
  const state = { head: firstHead, private: true, push: true, branch: 'main', fullName: 'Sunnychh/xinjiang-trip-memories',
    calls, blobs, trees, commits, writes: () => calls.filter(call => call.method !== 'GET'),
    visible: () => trees.get(commits.get(state.head).tree.sha) };
  state.fetchImpl = async (input, init = {}) => {
    const url = new URL(input), method = init.method || 'GET';
    assert.equal(url.origin, 'https://api.github.com', 'tokens must never be sent to a different host');
    assert.ok(url.pathname === '/user' || url.pathname === ROOT || url.pathname.startsWith(ROOT + '/'), 'fixed repository only');
    assert.equal(url.username, ''); assert.equal(url.password, '');
    const headers = new Headers(init.headers);
    assert.equal(headers.get('Authorization'), `Bearer ${TOKEN}`);
    assert.equal(init.credentials, 'omit');
    assert.equal(init.redirect, 'error');
    assert.equal(init.cache, 'no-store');
    assert.equal(init.referrerPolicy, 'no-referrer');
    const body = init.body === undefined ? undefined : await new Response(init.body).json();
    const path = url.pathname === '/user' ? '/user' : url.pathname.slice(ROOT.length);
    const call = { path, method, body, url: String(url) }; calls.push(call);
    const intercepted = await options.before?.({ ...call, state });
    if (intercepted instanceof Response) return intercepted;
    if (path === '/user') return reply({ ...USER });
    if (!path) return reply({ private: state.private, full_name: state.fullName, default_branch: state.branch, permissions: { push: state.push } });
    if (path === '/git/ref/heads/main') return reply({ object: { sha: state.head, type: 'commit' } });
    if (path.startsWith('/contents/')) {
      const prefix = decodeURIComponent(path.slice('/contents/'.length)) + '/';
      const current = commits.get(url.searchParams.get('ref'));
      assert.ok(current, 'lookup uses an actual commit, not a mutable ref');
      const entries = [...trees.get(current.tree.sha)].filter(([name]) => name.startsWith(prefix)).map(([name, hash]) => ({
        name: name.slice(prefix.length), path: name, sha: hash, size: blobs.get(hash).length, type: 'file',
        download_url: 'https://untrusted.example.test/must-not-be-followed',
      }));
      return reply(entries, entries.length ? 200 : 404);
    }
    if (path.startsWith('/git/blobs/')) {
      const bytes = blobs.get(path.slice('/git/blobs/'.length)); assert.ok(bytes);
      return reply({ encoding: 'base64', content: bytes.toString('base64') });
    }
    if (path.startsWith('/git/commits/')) return reply(commits.get(path.slice('/git/commits/'.length)));
    if (path === '/git/blobs' && method === 'POST') {
      const content = Buffer.from(body.content, body.encoding === 'base64' ? 'base64' : 'utf8');
      const hash = sha(Buffer.concat([Buffer.from(`blob ${content.length}\0`), content]));
      blobs.set(hash, content); return reply({ sha: hash }, 201);
    }
    if (path === '/git/trees' && method === 'POST') {
      const tree = new Map(trees.get(body.base_tree));
      for (const entry of body.tree) { assert.equal(entry.mode, '100644'); assert.equal(entry.type, 'blob'); tree.set(entry.path, entry.sha); }
      const hash = sha(JSON.stringify([...tree])); trees.set(hash, tree); return reply({ sha: hash }, 201);
    }
    if (path === '/git/commits' && method === 'POST') {
      const hash = sha(JSON.stringify(body)); commits.set(hash, { tree: { sha: body.tree }, parents: body.parents }); return reply({ sha: hash }, 201);
    }
    if (path === '/git/refs/heads/main' && method === 'PATCH') {
      assert.equal(body.force, false, 'never overwrite another traveller’s commit');
      if (commits.get(body.sha).parents[0] !== state.head) return reply({}, 422);
      state.head = body.sha;
      if (options.loseAcknowledgement) throw new TypeError('Simulated connection loss after the server accepted the ref');
      return reply({ object: { sha: state.head } });
    }
    assert.fail(`Unexpected endpoint ${method} ${path}`);
  };
  state.connect = () => connect(TOKEN, { fetchImpl: state.fetchImpl });
  return state;
}

function safeError(error) {
  assert.ok(error instanceof PhotoError);
  assert.ok(!error.message.includes(TOKEN), 'token must not appear in user-facing errors');
  return true;
}

test('connect validates identity and fixed private push access; disconnect stops further authenticated calls', async () => {
  const g = graph(), client = await g.connect();
  assert.deepEqual(client.user, USER);
  assert.ok(g.calls.some(call => call.path === '/user'));
  assert.ok(g.calls.some(call => call.path === ''));
  assert.equal(g.writes().length, 0);
  const prepared = await client.prepare(file(), '', ID);
  client.disconnect();
  const count = g.calls.length;
  await assert.rejects(client.save(prepared), safeError);
  assert.equal(g.calls.length, count, 'disconnect removes access rather than making a request with an empty token');
});

test('public, wrong, non-writable repositories and wrong default branch fail before uploads', async t => {
  for (const [property, value] of [['private', false], ['push', false], ['fullName', 'Other/private'], ['branch', 'other']]) {
    await t.test(property, async () => {
      const g = graph(); g[property] = value;
      await assert.rejects(g.connect(), safeError);
      assert.equal(g.writes().length, 0);
    });
  }
});

test('redirects are rejected without sending the credential to their target', async () => {
  const g = graph({ before: () => new Response(null, { status: 302, headers: { Location: 'https://untrusted.example.test/collect' } }) });
  await assert.rejects(g.connect(), safeError);
  assert.equal(g.calls.length, 1);
  assert.equal(g.calls[0].path, '/user');
});

test('prepare enforces 20 MiB, UUID, caption and real image signatures without any upload request', async () => {
  const g = graph(), client = await g.connect(), before = g.calls.length;
  assert.equal(MAX_BYTES, 20 * 1024 * 1024);
  for (const args of [
    [file(new Uint8Array(MAX_BYTES + 1)), '', ID],
    [file(new Uint8Array()), '', ID],
    [file('<svg onload="alert(1)"></svg>', 'photo.svg', 'image/svg+xml'), '', ID],
    [file('<script>unsafe</script>', 'renamed.png', 'image/png'), '', ID],
    [file(PNG.subarray(0, 24)), '', ID],
    [file(), 'x'.repeat(4001), ID], [file(), '', '../escape'],
  ]) await assert.rejects(client.prepare(...args), safeError);
  assert.equal(g.calls.length, before);
  const blank = await client.prepare(file(), undefined, ID);
  assert.equal(blank.record.caption, '');
  const detected = await client.prepare(file(PNG, 'wrong.jpg', 'image/jpeg'), '留住风景 🌄', ID);
  assert.equal(detected.record.mimeType, 'image/png');
});

test('save preserves original bytes and Unicode caption, publishing the photo and metadata atomically', async () => {
  const g = graph(), client = await g.connect();
  const caption = '湖边\n"旅行" </script> 🌄', start = Date.now();
  const prepared = await client.prepare(file(PNG, 'IMG_20010101_000000.png'), caption, ID);
  assert.deepEqual(Buffer.from(prepared.bytes), PNG);
  assert.equal(prepared.record.caption, caption);
  assert.equal(prepared.record.captureTime, null);
  assert.equal(prepared.record.location, null);
  assert.ok(Date.parse(prepared.record.uploadedAt) >= Math.floor(start / 1000) * 1000);
  assert.deepEqual(prepared.record.uploader, { id: `github-${USER.id}`, username: USER.login, provider: 'github' });
  const result = await client.save(prepared);
  assert.equal(result.duplicate, false);
  assert.match(result.commitSha, /^[a-f0-9]{40}$/);
  const visible = g.visible();
  assert.equal(visible.size, 3); assert.ok(visible.has('README.md'));
  assert.deepEqual(g.blobs.get(visible.get(prepared.record.photoPath)), PNG);
  const storedRecord = JSON.parse(g.blobs.get(visible.get(`${prepared.directory}/record.json`)).toString('utf8'));
  assert.deepEqual(storedRecord, prepared.record);
  assert.deepEqual(g.writes().map(call => call.path), ['/git/blobs', '/git/blobs', '/git/trees', '/git/commits', '/git/refs/heads/main']);
  assert.equal(g.writes().find(call => call.path === '/git/trees').body.tree.length, 2);
  assert.ok(g.calls.at(-1).method === 'GET', 'success is confirmed by reading reachable metadata after ref publication');
  assert.ok(!JSON.stringify(result).includes(TOKEN));
});

test('same upload is idempotent, while a changed caption with the same UUID conflicts', async () => {
  const g = graph(), client = await g.connect(), prepared = await client.prepare(file(), '', ID);
  const first = await client.save(prepared), writes = g.writes().length;
  const retry = await client.save(prepared);
  assert.equal(retry.duplicate, true);
  assert.equal(retry.commitSha, first.commitSha);
  assert.equal(g.writes().length, writes);
  const changed = await client.prepare(file(), 'different', ID);
  await assert.rejects(client.save(changed), error => safeError(error) && error.status === 409);
  const otherBytes = Buffer.from(PNG);
  otherBytes[29] ^= 1; // Change the IHDR checksum while preserving the valid image container structure.
  const otherPhoto = await client.prepare(file(otherBytes), '', ID);
  await assert.rejects(client.save(otherPhoto), error => safeError(error) && error.status === 409);
  assert.equal(g.writes().length, writes);
  const found = await client.lookup(prepared);
  assert.equal(found.record.id, ID);
  assert.equal(found.commitSha, first.commitSha);
});

test('concurrent branch advancement is retried without losing another upload or repeating blobs', async () => {
  let raced = false, concurrent;
  const g = graph({ before({ path, method, state }) {
    if (path !== '/git/refs/heads/main' || method !== 'PATCH' || raced) return;
    raced = true;
    const tree = new Map(state.visible()); tree.set('another/photo.jpg', sha('other photo'));
    const treeSha = sha('race tree'); concurrent = sha('race head');
    state.trees.set(treeSha, tree); state.commits.set(concurrent, { tree: { sha: treeSha }, parents: [state.head] }); state.head = concurrent;
  } });
  const client = await g.connect(), prepared = await client.prepare(file(), '', ID);
  const result = await client.save(prepared);
  assert.equal(result.duplicate, false);
  assert.deepEqual(g.commits.get(g.head).parents, [concurrent]);
  assert.ok(g.visible().has('another/photo.jpg'));
  assert.equal(g.calls.filter(call => call.method === 'PATCH').length, 2);
  assert.equal(g.calls.filter(call => call.path === '/git/blobs').length, 2);
});

test('staging failure is never acknowledged as saved and never leaks the upstream error body', async () => {
  const g = graph({ before({ path, method }) {
    if (path === '/git/commits' && method === 'POST') return reply({ message: `upstream secret ${TOKEN}` }, 500);
  } });
  const client = await g.connect(), prepared = await client.prepare(file(), '', ID), initial = g.head;
  await assert.rejects(client.save(prepared), error => safeError(error) && !error.message.includes('upstream secret'));
  assert.equal(g.head, initial);
  assert.deepEqual([...g.visible().keys()], ['README.md']);
  assert.equal(g.calls.filter(call => call.method === 'PATCH').length, 0);
});

test('an uncertain network result can be looked up and retried without creating another photo', async () => {
  const g = graph({ loseAcknowledgement: true }), client = await g.connect();
  const prepared = await client.prepare(file(), 'saved but response lost', ID);
  try { await client.save(prepared); } catch (error) { safeError(error); }
  const writes = g.writes().length;
  const found = await client.lookup(prepared);
  assert.equal(found.record.id, ID, 'a committed photo remains discoverable when its response is lost');
  const retry = await client.save(prepared);
  assert.equal(retry.duplicate, true);
  assert.equal(g.writes().length, writes);
  assert.equal(g.visible().size, 3);
});

test('a repository made public after connect is rejected before photo bytes are sent', async () => {
  const g = graph(), client = await g.connect(), prepared = await client.prepare(file(), '', ID);
  g.private = false;
  await assert.rejects(client.save(prepared), safeError);
  assert.equal(g.writes().length, 0);
});
