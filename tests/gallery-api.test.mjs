import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { connect, MAX_BYTES, PhotoError } from '../upload/github.mjs';

const ROOT = '/repos/Sunnychh/xinjiang-trip-memories';
const TOKEN = 'synthetic-gallery-test-token';
const HEAD = 'a'.repeat(40), NEXT = 'b'.repeat(40);
const INDEX = 'records/derived/index.json';
const IMAGE_PATH = 'records/inbox/github-7/legacy_012abc/新疆旅行.jpg';
const PREVIEW_PATH = 'records/derived/previews/legacy_012abc.jpg';
const JPEG = readFileSync(new URL('./fixtures/jpeg-baseline.jpg', import.meta.url));
const reply = (value, status = 200) => new Response(JSON.stringify(value), { status });
const gitSha = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const photo = overrides => ({ id: 'legacy_012abc', photoPath: IMAGE_PATH, fileName: '新疆旅行.jpg', originalName: 'camera.jpg',
  caption: '合成测试附言', uploadedAt: '2026-10-03T06:00:00Z', captureTime: '2026-10-02T13:05:00',
  captureTimeSource: 'exif', captureTimeOffset: null, location: { lat: 43.16, lng: 81.12, source: 'exif' },
  thumbnailPath: PREVIEW_PATH, issues: [], ...overrides });
const manifest = overrides => ({ schemaVersion: 1, sourceCommit: 'c'.repeat(40), generatedAt: '2026-10-03T08:00:00Z',
  stats: { located: 1 }, photos: [photo()], ...overrides });

function graph({ value = manifest(), before } = {}) {
  const files = new Map(), blobs = new Map(), calls = [];
  const state = { private: true, head: HEAD, calls, files, blobs };
  state.put = (path, bytes) => {
    bytes = Buffer.from(bytes);
    const hash = gitSha(bytes);
    files.set(path, { sha: hash, size: bytes.length }); blobs.set(hash, bytes);
  };
  if (value !== null) state.put(INDEX, JSON.stringify(value));
  state.put(IMAGE_PATH, JPEG); state.put(PREVIEW_PATH, JPEG);
  state.fetchImpl = async (input, init = {}) => {
    const url = new URL(input);
    assert.equal(url.origin, 'https://api.github.com');
    assert.equal(init.method, 'GET', 'gallery never writes');
    assert.equal(init.redirect, 'error');
    assert.equal(init.credentials, 'omit');
    assert.equal(init.cache, 'no-store');
    assert.equal(init.referrerPolicy, 'no-referrer');
    assert.equal(new Headers(init.headers).get('Authorization'), `Bearer ${TOKEN}`);
    const path = url.pathname === '/user' ? '/user' : url.pathname.slice(ROOT.length);
    const call = { url, path }; calls.push(call);
    const intercepted = await before?.({ ...call, state });
    if (intercepted instanceof Response) return intercepted;
    if (path === '/user') return reply({ id: 7, login: 'SyntheticTraveller' });
    if (!path) return reply({ private: state.private, full_name: ROOT.slice(7), default_branch: 'main', permissions: { push: true } });
    if (path === '/git/ref/heads/main') return reply({ object: { type: 'commit', sha: state.head } });
    if (path.startsWith('/contents/')) {
      assert.match(url.searchParams.get('ref'), /^[a-f0-9]{40}$/);
      const filePath = decodeURIComponent(path.slice('/contents/'.length));
      const entry = files.get(filePath);
      return entry ? reply({ ...entry, type: 'file', path: filePath,
        download_url: 'https://attacker.invalid/do-not-send-token', html_url: 'https://attacker.invalid/also-ignore' }) : reply({}, 404);
    }
    if (path.startsWith('/git/blobs/')) {
      const hash = path.slice('/git/blobs/'.length), bytes = blobs.get(hash);
      assert.ok(bytes);
      return reply({ sha: hash, size: bytes.length, encoding: 'base64', content: bytes.toString('base64') });
    }
    assert.fail(`Unexpected endpoint ${path}`);
  };
  state.connect = () => connect(TOKEN, { fetchImpl: state.fetchImpl });
  return state;
}
const isCode = code => error => error instanceof PhotoError && error.code === code && !error.message.includes(TOKEN);

test('gallery reads a fixed private snapshot and preserves timestamps, extensions, and refresh metadata', async () => {
  const g = graph(), client = await g.connect();
  const result = await client.gallery();
  assert.deepEqual(result, { ...manifest(), snapshotCommit: HEAD });
  const indexCall = g.calls.find(call => call.path.startsWith('/contents/'));
  assert.equal(indexCall.url.searchParams.get('ref'), HEAD);
  g.head = NEXT;
  const image = await client.photoBlob(IMAGE_PATH);
  assert.ok(image instanceof Blob); assert.equal(image.type, 'image/jpeg');
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), JPEG);
  const lastContents = g.calls.filter(call => call.path.startsWith('/contents/')).at(-1);
  assert.equal(lastContents.url.searchParams.get('ref'), HEAD, 'photos use the index snapshot, not newly changed main');
  assert.ok(g.calls.every(call => call.url.origin === 'https://api.github.com'), 'download_url is ignored');
  assert.equal((await client.gallery()).snapshotCommit, NEXT, 'explicit refresh captures new head');
});

test('missing index is null; absent EXIF stays unlocated, not inferred from caption', async () => {
  const g = graph({ value: null }), client = await g.connect();
  assert.equal(await client.gallery(), null);
  g.put(INDEX, JSON.stringify(manifest({ photos: [photo({ location: null, captureTime: null, captureTimeSource: null,
    thumbnailPath: undefined, caption: '在夏塔', issues: ['gps_missing'] })] })));
  const result = await client.gallery();
  assert.equal(result.photos[0].location, null);
  assert.equal(result.photos[0].thumbnailPath, null);
});

test('legacy direct uploads preserve unknown uploadedAt and sourceCommit as null', async () => {
  const legacy = photo({ id: 'legacy_' + 'a'.repeat(40), uploadedAt: null, captureTime: null,
    captureTimeSource: null, captureTimeOffset: null, location: null, thumbnailPath: null, issues: ['no_record_metadata'] });
  const client = await graph({ value: manifest({ sourceCommit: null, photos: [legacy] }) }).connect();
  const result = await client.gallery();
  assert.equal(result.sourceCommit, null);
  assert.deepEqual(result.photos, [legacy]);
});

test('privacy is rechecked before every gallery or photo read', async () => {
  const g = graph(), client = await g.connect();
  g.private = false;
  await assert.rejects(client.gallery(), isCode('PRIVATE'));
  await assert.rejects(client.photoBlob(IMAGE_PATH), isCode('PRIVATE'));
  assert.equal(g.calls.filter(call => call.path.startsWith('/contents/')).length, 0);
});

test('disconnect prevents further reads and in-flight response release', async () => {
  let release, entered;
  const reached = new Promise(resolve => { entered = resolve; });
  const hold = new Promise(resolve => { release = resolve; });
  const g = graph({ before: async ({ path }) => {
    if (path.startsWith('/contents/')) { entered(); await hold; }
  } });
  const client = await g.connect(), pending = client.gallery();
  await reached; client.disconnect(); release();
  await assert.rejects(pending, isCode('AUTH'));
  const count = g.calls.length;
  await assert.rejects(client.gallery(), isCode('AUTH'));
  await assert.rejects(client.photoBlob(IMAGE_PATH), isCode('AUTH'));
  assert.equal(g.calls.length, count);
});

test('paths and requested size limits are rejected before fetching', async t => {
  const g = graph(), client = await g.connect(), count = g.calls.length;
  for (const path of [
    'https://attacker.invalid/photo.jpg', 'records/inbox/../secret.jpg', 'records/inbox//photo.jpg',
    'records/inbox/./photo.jpg', 'records/inbox/\\secret.jpg', 'records/inbox/%2e%2e/photo.jpg',
    'records/inbox/%252e%252e/photo.jpg', 'records/inbox/\0photo.jpg', '/records/inbox/photo.jpg',
    'records/derived/index.json', 'records/inbox/a.svg', 'records/derived/previews/a.png', 'records/inbox/a.jpg?raw=1',
  ]) await t.test(JSON.stringify(path), () => assert.rejects(client.photoBlob(path), isCode('INVALID')));
  for (const maxBytes of [0, -1, Infinity, '100', MAX_BYTES + 1]) await assert.rejects(client.photoBlob(IMAGE_PATH, { maxBytes }), isCode('INVALID'));
  assert.equal(g.calls.length, count);
});

test('manifest rejects invalid schema, item paths, IDs, duplicate entries and geographic coordinates', async t => {
  for (const [name, value] of [
    ['schema', manifest({ schemaVersion: 2 })], ['photos limit', manifest({ photos: Array(5001).fill(photo()) })],
    ['path', manifest({ photos: [photo({ photoPath: 'records/inbox/%2e%2e/a.jpg' })] })],
    ['thumbnail path', manifest({ photos: [photo({ thumbnailPath: 'https://attacker.invalid/a.jpg' })] })],
    ['id', manifest({ photos: [photo({ id: 123 })] })], ['duplicate', manifest({ photos: [photo(), photo()] })],
    ['latitude', manifest({ photos: [photo({ location: { lat: 91, lng: 0, source: 'exif' } })] })],
    ['longitude', manifest({ photos: [photo({ location: { lat: 0, lng: -181, source: 'exif' } })] })],
    ['numeric strings', manifest({ photos: [photo({ location: { lat: '43', lng: 81, source: 'exif' } })] })],
    ['missing lat', manifest({ photos: [photo({ location: { lng: 81, source: 'exif' } })] })],
    ['inferred', manifest({ photos: [photo({ location: { lat: 43, lng: 81, source: 'caption' } })] })],
    ['bad timestamp', manifest({ photos: [photo({ captureTime: 'not a date' })] })],
  ]) await t.test(name, async () => {
    const client = await graph({ value }).connect();
    await assert.rejects(client.gallery(), isCode('RESPONSE'));
  });
});

test('coordinates at valid bounds and explicit manual locations are preserved', async () => {
  const location = { lat: -90, lng: 180, source: 'manual' };
  const client = await graph({ value: manifest({ photos: [photo({ location })] }) }).connect();
  assert.deepEqual((await client.gallery()).photos[0].location, location);
});

test('metadata size is checked before fetching photo or index blob', async t => {
  for (const [path, size, call] of [
    [IMAGE_PATH, MAX_BYTES + 1, client => client.photoBlob(IMAGE_PATH)],
    [IMAGE_PATH, JPEG.length, client => client.photoBlob(IMAGE_PATH, { maxBytes: JPEG.length - 1 })],
    [INDEX, 8 * 1024 * 1024 + 1, client => client.gallery()],
  ]) await t.test(path + size, async () => {
    const g = graph(); g.files.get(path).size = size;
    const client = await g.connect();
    await assert.rejects(call(client), isCode('RESPONSE'));
    assert.equal(g.calls.filter(item => item.path.startsWith('/git/blobs/')).length, 0);
  });
});

test('forged image data, mismatched blob sizes and digests, symlinks, and malformed base64 fail closed', async t => {
  for (const [name, changes] of [
    ['size', { size: JPEG.length + 1 }], ['encoding', { encoding: 'utf-8' }],
    ['base64', { content: '*'.repeat(4 * Math.ceil(JPEG.length / 3)) }],
    ['digest', { sha: 'f'.repeat(40) }],
    ['short decoded content', { content: Buffer.from('short').toString('base64') }],
    ['different bytes', { content: Buffer.alloc(JPEG.length, 65).toString('base64') }],
  ]) await t.test(name, async () => {
    const g = graph({ before: ({ path }) => path.startsWith('/git/blobs/') ? reply({ sha: gitSha(JPEG), size: JPEG.length,
      encoding: 'base64', content: JPEG.toString('base64'), ...changes }) : undefined });
    const client = await g.connect();
    await assert.rejects(client.photoBlob(IMAGE_PATH), isCode('RESPONSE'));
  });
  for (const bytes of [Buffer.from('<svg onload="alert(1)"></svg>'), Buffer.from('plain text'), JPEG.subarray(0, -2)]) {
    const g = graph(); g.put(IMAGE_PATH, bytes);
    const client = await g.connect(); await assert.rejects(client.photoBlob(IMAGE_PATH), isCode('RESPONSE'));
  }
  const g = graph({ before: ({ path }) => path.startsWith('/contents/') ? reply({ type: 'symlink', path: IMAGE_PATH,
    sha: gitSha(JPEG), size: JPEG.length }) : undefined });
  await assert.rejects((await g.connect()).photoBlob(IMAGE_PATH), isCode('RESPONSE'));
});

test('large photo envelopes work above original 1 MiB JSON limit with an explicit bounded binary limit', async () => {
  const g = graph(), bytes = Buffer.concat([JPEG, Buffer.alloc(1200 * 1024)]);
  g.put(IMAGE_PATH, bytes);
  const client = await g.connect(), result = await client.photoBlob(IMAGE_PATH, { maxBytes: bytes.length });
  assert.equal(result.size, bytes.length);
});

test('oversized streamed responses are canceled instead of fully buffered', async () => {
  let canceled = false, sent = false;
  const g = graph({ before: ({ path }) => path.startsWith('/git/blobs/') ? new Response(new ReadableStream({
    pull(controller) { if (!sent) { sent = true; controller.enqueue(new Uint8Array(10000)); } },
    cancel() { canceled = true; },
  })) : undefined });
  const client = await g.connect();
  await assert.rejects(client.photoBlob(IMAGE_PATH, { maxBytes: JPEG.length }), isCode('RESPONSE'));
  assert.equal(canceled, true);
});

test('redirects are never followed and redirected synthetic responses are rejected', async t => {
  for (const status of [302, 307]) await t.test(String(status), async () => {
    const g = graph({ before: ({ path }) => path.startsWith('/contents/')
      ? new Response(null, { status, headers: { Location: 'https://attacker.invalid/leak' } }) : undefined });
    const client = await g.connect();
    await assert.rejects(client.gallery(), isCode('HTTP'));
    assert.equal(g.calls.filter(call => call.path.startsWith('/git/blobs/')).length, 0);
  });
  const g = graph({ before: ({ path }) => {
    if (!path.startsWith('/contents/')) return;
    const response = reply({}); Object.defineProperty(response, 'redirected', { value: true }); return response;
  } });
  await assert.rejects((await g.connect()).gallery(), isCode('RESPONSE'));
});


test('duplicate fingerprints survive authenticated gallery validation while old records remain compatible', async () => {
  const contentHash = 'a'.repeat(64), pixelHash = 'b'.repeat(64);
  const client = await graph({ value: manifest({ photos: [photo({ contentHash, pixelHash })] }) }).connect();
  const [item] = (await client.gallery()).photos;
  assert.equal(item.contentHash, contentHash); assert.equal(item.pixelHash, pixelHash);
  const legacy = await graph({ value: manifest({ photos: [photo({ contentHash: null, pixelHash: null })] }) }).connect();
  assert.equal((await legacy.gallery()).photos[0].contentHash, null);
});
test('invalid duplicate fingerprints cannot become trusted grouping keys', async t => {
  for (const value of ['bad', 'a'.repeat(63), 'A'.repeat(64), 42, {}]) {
    for (const field of ['contentHash', 'pixelHash']) await t.test(field + String(value), async () => {
      const client = await graph({ value: manifest({ photos: [photo({ [field]: value })] }) }).connect();
      await assert.rejects(client.gallery(), isCode('RESPONSE'));
    });
  }
});
