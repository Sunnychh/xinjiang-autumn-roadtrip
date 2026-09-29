import assert from 'node:assert/strict';
import test from 'node:test';
import { PhotoQueue } from '../upload/queue.mjs';
import { MAX_BYTES, PhotoError } from '../upload/github.mjs?v=20260929-batch';

const photo = (name = '旅行.jpg', size = 100, type = '') => ({ name, size, type });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const fail = (code = 'NETWORK') => new PhotoError(`test ${code}`, code === 'AUTH' ? 401 : 0, code);
function fakeClient(overrides = {}) {
  const calls = [];
  let serial = 0;
  const client = {
    user: { id: 42, login: 'Traveller' }, calls,
    async prepare(file, caption) {
      calls.push(['prepare', file.name, caption]);
      const id = String(++serial);
      return { bytes: new Uint8Array(file.size), record: { id, originalName: file.name, caption,
        photoPath: `records/inbox/github-42/${id}/photo.jpg` } };
    },
    async lookup(prepared) { calls.push(['lookup', prepared.record.id]); return null; },
    async save(prepared, progress) { calls.push(['save', prepared.record.id]); progress({ percent: 100 }); return receipt(prepared); },
    ...overrides,
  };
  return client;
}
function receipt(prepared) { return { record: { ...prepared.record }, commitSha: 'a'.repeat(40) }; }

// These clients never make network requests or require browser globals.
test('add only checks size, accepts JPG with empty/nonstandard MIME, and returns independent caption items', () => {
  const queue = new PhotoQueue();
  const { added, errors } = queue.add([photo(), photo('UPPER.JPG', 10, 'image/jpg'), photo('bad.txt', 1, 'text/plain'),
    photo('empty.jpg', 0), photo('large.jpg', MAX_BYTES + 1)]);
  assert.equal(added.length, 3); assert.equal(errors.length, 2);
  assert.equal(queue.pending, 3); assert.equal(queue.complete, false);
  added[0].caption = '第一张'; assert.equal(added[1].caption, '');
  assert.equal(new Set(added.map(item => item.id)).size, 3);
  assert.ok(errors.every(entry => entry.error.code === 'INVALID'));
});

test('runs photos in order, preserves per-photo captions, and releases prepared bytes after confirmation', async () => {
  const queue = new PhotoQueue(), client = fakeClient(), progress = [];
  const { added } = queue.add([photo('A.jpg'), photo('B.jpg')]);
  added[0].caption = '山间'; added[1].caption = '湖边';
  const result = await queue.run(client, { onProgress: (item, event) => progress.push([item.file.name, event.percent]) });
  assert.deepEqual(result, { complete: true });
  assert.deepEqual(client.calls, [['prepare', 'A.jpg', '山间'], ['save', '1'], ['prepare', 'B.jpg', '湖边'], ['save', '2']]);
  assert.deepEqual(progress, [['A.jpg', 100], ['B.jpg', 100]]);
  assert.equal(queue.pending, 0); assert.equal(queue.uncertain, false);
  assert.ok(added.every(item => item.status === 'saved' && item.prepared === null && item.receipt.commitSha));
  assert.deepEqual(added[0].owner, client.user);
  await queue.run(client); assert.equal(client.calls.length, 4, 'saved photos must not upload again');
});

test('invalid file does not prevent subsequent valid files from saving', async () => {
  const queue = new PhotoQueue(), client = fakeClient();
  const prepare = client.prepare;
  client.prepare = async (file, caption) => { if (file.name === 'invalid.txt') throw fail('INVALID'); return prepare(file, caption); };
  const { added } = queue.add([photo('invalid.txt'), photo('valid.jpg')]);
  assert.deepEqual(await queue.run(client), { complete: false });
  assert.equal(added[0].status, 'invalid'); assert.equal(added[1].status, 'saved');
  assert.equal(queue.pending, 0); assert.equal(queue.complete, false);
  assert.equal(queue.remove(added[0].id), true); assert.equal(queue.complete, true);
});

test('preparation auth failure pauses batch before any write and keeps later files pending', async () => {
  const queue = new PhotoQueue(), client = fakeClient({ prepare: async () => { throw fail('AUTH'); } });
  const { added } = queue.add([photo('A.jpg'), photo('B.jpg')]);
  const result = await queue.run(client);
  assert.equal(result.error.code, 'AUTH'); assert.equal(result.item, added[0]);
  assert.deepEqual(added.map(item => item.status), ['failed', 'pending']);
  assert.equal(queue.uncertain, false); assert.equal(client.calls.length, 0);
});

test('lost save response is checked once and confirmed receipt continues the batch', async () => {
  const queue = new PhotoQueue(), client = fakeClient();
  client.save = async prepared => { client.calls.push(['save', prepared.record.id]); if (prepared.record.id === '1') throw fail(); return receipt(prepared); };
  client.lookup = async prepared => { client.calls.push(['lookup', prepared.record.id]); return receipt(prepared); };
  queue.add([photo('A.jpg'), photo('B.jpg')]);
  assert.deepEqual(await queue.run(client), { complete: true });
  assert.deepEqual(client.calls.map(call => call[0]), ['prepare', 'save', 'lookup', 'prepare', 'save']);
});

test('unconfirmed write stops at the current item, retry reuses prepared identity before saving', async () => {
  const queue = new PhotoQueue(), client = fakeClient();
  const originalSave = client.save;
  client.save = async prepared => { client.calls.push(['failed-save', prepared.record.id]); throw fail(); };
  const { added } = queue.add([photo('A.jpg'), photo('B.jpg')]);
  const first = await queue.run(client), preserved = added[0].prepared;
  assert.equal(first.error.code, 'NETWORK'); assert.deepEqual(added.map(item => item.status), ['uncertain', 'pending']);
  assert.equal(queue.uncertain, true); assert.equal(queue.pending, 2);
  assert.equal(queue.remove(added[0].id), false); assert.equal(queue.clear(), false);
  client.save = async (prepared, progress) => {
    if (prepared.record.id === '1') assert.equal(prepared, preserved);
    return originalSave(prepared, progress);
  };
  await queue.run(client);
  assert.deepEqual(client.calls.map(call => call[0]), ['prepare', 'failed-save', 'lookup', 'lookup', 'save', 'prepare', 'save']);
  assert.equal(queue.complete, true);
});

test('retry finding a previous committed photo does not write it again', async () => {
  const queue = new PhotoQueue(), client = fakeClient({ save: async () => { throw fail(); } });
  queue.add([photo()]); await queue.run(client);
  client.lookup = async prepared => receipt(prepared);
  client.save = async () => assert.fail('existing photo must not be written again');
  assert.deepEqual(await queue.run(client), { complete: true });
});

test('permission, auth, private and configuration failures skip automatic lookup', async t => {
  for (const code of ['AUTH', 'PERMISSION', 'PRIVATE', 'CONFIG']) await t.test(code, async () => {
    const queue = new PhotoQueue(), client = fakeClient({ save: async () => { throw fail(code); }, lookup: async () => assert.fail('do not retry denied lookup') });
    const { added } = queue.add([photo()]);
    const result = await queue.run(client);
    assert.equal(result.error.code, code); assert.equal(added[0].status, 'uncertain');
    assert.ok(added[0].prepared);
  });
});

test('uncertain item cannot be retried with another account', async () => {
  const queue = new PhotoQueue(), client = fakeClient({ save: async () => { throw fail(); } });
  const { added } = queue.add([photo()]); await queue.run(client);
  const preserved = added[0].prepared;
  const other = fakeClient({ user: { id: 99, login: 'Other' } });
  const result = await queue.run(other);
  assert.equal(result.error.code, 'ACCOUNT'); assert.equal(other.calls.length, 0);
  assert.equal(added[0].prepared, preserved); assert.equal(queue.uncertain, true);
});

test('incomplete or mismatched receipt is never counted as saved', async () => {
  const queue = new PhotoQueue(), client = fakeClient({ save: async prepared => ({ ...receipt(prepared), commitSha: 'invalid' }) });
  const { added } = queue.add([photo()]);
  assert.equal((await queue.run(client)).error.code, 'RESPONSE');
  assert.equal(added[0].status, 'uncertain'); assert.equal(added[0].receipt, null);
  client.lookup = async prepared => ({ ...receipt(prepared), record: { ...prepared.record, id: 'other-photo' } });
  assert.equal((await queue.run(client)).error.code, 'RESPONSE');
  assert.equal(queue.complete, false);
});

test('only one run can be active and removal cannot discard an in-flight item', async () => {
  const queue = new PhotoQueue(), gate = deferred(), client = fakeClient({ prepare: () => gate.promise });
  const { added } = queue.add([photo()]); const active = queue.run(client);
  assert.equal(added[0].status, 'preparing');
  assert.equal(queue.remove(added[0].id), false); assert.equal(queue.clear(), false);
  assert.equal((await queue.run(client)).error.code, 'BUSY');
  queue.interrupt(); gate.resolve({ record: {} });
  assert.deepEqual(await active, { stale: true }); assert.equal(added[0].status, 'pending');
  assert.equal(added[0].prepared, null); assert.equal(queue.remove(added[0].id), true);
});

test('interrupt during save preserves prepared item; stale completion cannot change a new run', async () => {
  const queue = new PhotoQueue(), oldSave = deferred(), newLookup = deferred(), client = fakeClient({ save: () => oldSave.promise });
  const { added } = queue.add([photo()]);
  const first = queue.run(client); await Promise.resolve();
  const prepared = added[0].prepared;
  assert.equal(added[0].status, 'uploading'); queue.interrupt();
  assert.equal(added[0].status, 'uncertain'); assert.equal(added[0].prepared, prepared);
  const next = fakeClient({ lookup: () => newLookup.promise });
  const second = queue.run(next);
  oldSave.resolve(receipt(prepared)); assert.deepEqual(await first, { stale: true });
  assert.equal(added[0].receipt, null);
  assert.equal((await queue.run(next)).error.code, 'BUSY', 'old finally must not unlock the new run');
  newLookup.resolve(receipt(prepared)); assert.deepEqual(await second, { complete: true });
});

test('generation change drops late prepare, save and progress callbacks', async () => {
  let current = true, progressCount = 0;
  const queue = new PhotoQueue(), gate = deferred();
  let reportProgress;
  const client = fakeClient({ save: (_prepared, callback) => { reportProgress = callback; return gate.promise; } });
  const { added } = queue.add([photo()]);
  const active = queue.run(client, { isCurrent: () => current, onProgress: () => progressCount++ });
  await Promise.resolve(); const prepared = added[0].prepared;
  current = false; queue.interrupt(); reportProgress({ percent: 100 }); gate.resolve(receipt(prepared));
  assert.deepEqual(await active, { stale: true }); assert.equal(progressCount, 0);
  assert.equal(added[0].receipt, null); assert.equal(added[0].status, 'uncertain');
});

test('selection added mid-run waits for next batch, and clear permits fully confirmed batches', async () => {
  const queue = new PhotoQueue(), gate = deferred(), client = fakeClient({ save: () => gate.promise });
  const { added } = queue.add([photo('first.jpg')]); const active = queue.run(client); await Promise.resolve();
  queue.add([photo('later.jpg')]); gate.resolve(receipt(added[0].prepared));
  assert.deepEqual(await active, { complete: false }); assert.equal(queue.items[1].status, 'pending');
  assert.equal(queue.remove(added[0].id), false);
  await queue.run(fakeClient()); assert.equal(queue.complete, true);
  assert.equal(queue.clear(), true); assert.equal(queue.items.length, 0); assert.equal(queue.complete, false);
});
