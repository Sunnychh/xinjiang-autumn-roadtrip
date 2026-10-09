import test from 'node:test';
import assert from 'node:assert/strict';
import { createPendingStore, PendingStorageError } from '../upload/pending-store.mjs';
import { PhotoQueue } from '../upload/queue.mjs';

function memoryVault() {
  let record = null;
  return {
    async read() { return structuredClone(record); },
    async write(next) { record = structuredClone(next); },
    async clear(id) { if (record?.id !== id) return false; record = null; return true; },
    corrupt() { record.items[0].file = null; },
  };
}
function lockManager() {
  let held = false;
  return { async request(name, options, callback) {
    assert.equal(name, 'xinjiang-photo-upload-v1'); assert.deepEqual(options, { ifAvailable: true });
    if (held) return callback(null);
    held = true;
    try { return await callback({ name }); } finally { held = false; }
  } };
}
function batch() {
  const queue = new PhotoQueue();
  queue.add([new File(['synthetic-photo'], 'lake.JPG', { type: 'image/jpeg', lastModified: 1000 })]);
  queue.items[0].caption = '湖边';
  return { version: 1, id: crypto.randomUUID(), owner: { id: 42, login: 'Traveller' },
    createdAt: '2026-10-09T01:00:00Z', backgroundRevision: 'remembered-revision', items: queue.snapshot() };
}
const setup = () => {
  const vault = memoryVault(), locks = lockManager();
  return { vault, locks, store: createPendingStore({ vault, locks }) };
};

test('pending photo blobs and captions roundtrip across stores without temporary buffers or credentials', async () => {
  const { store, vault, locks } = setup();
  const next = batch();
  next.token = 'SYNTHETIC-SECRET'; next.items[0].prepared = { bytes: new Uint8Array([1, 2]), token: 'SYNTHETIC-SECRET' };
  assert.equal(await store.load(), null);
  await store.save(next);
  const raw = await vault.read();
  assert.equal('token' in raw, false); assert.equal('prepared' in raw.items[0], false);
  const reopened = createPendingStore({ vault, locks });
  const saved = await reopened.load();
  assert.equal(saved.items[0].uploadId, next.items[0].uploadId);
  assert.equal(saved.items[0].caption, '湖边'); assert.equal(saved.backgroundRevision, 'remembered-revision');
  assert.equal(await saved.items[0].file.text(), 'synthetic-photo');
  assert.equal(saved.items[0].fileInfo.name, 'lake.JPG');
});

test('a different batch or account cannot replace a pending batch; clear checks the expected ID', async () => {
  const { store } = setup(), first = batch();
  await store.save(first);
  await assert.rejects(store.save(batch()), PendingStorageError);
  await assert.rejects(store.save({ ...first, owner: { id: 99, login: 'Other' } }), PendingStorageError);
  assert.equal(await store.clear(crypto.randomUUID()), false);
  assert.equal((await store.load()).id, first.id);
  assert.equal(await store.clear(first.id), true);
  assert.equal(await store.load(), null);
});

test('batch ownership must match prepared item owners; missing authorization normalizes to null', async () => {
  const { store } = setup(), next = batch();
  next.items[0].owner = { id: 99, login: 'Other' };
  await assert.rejects(store.save(next), PendingStorageError);
  next.items[0].owner = next.owner; delete next.backgroundRevision;
  await store.save(next); assert.equal((await store.load()).backgroundRevision, null);
  await store.save({ ...next, backgroundRevision: 'new-authorization' });
  assert.equal((await store.load()).backgroundRevision, 'new-authorization');
});

test('corruption and storage failures return a fixed error without leaking exception details', async () => {
  const { store, vault } = setup();
  await store.save(batch()); vault.corrupt();
  await assert.rejects(store.load(), PendingStorageError);
  const broken = createPendingStore({ vault: { read: async () => { throw new Error('PRIVATE DETAIL'); } }, locks: lockManager() });
  await assert.rejects(broken.load(), error => error instanceof PendingStorageError && !error.message.includes('PRIVATE DETAIL'));
});

test('invalid batch identities, revisions, receipts and timestamps are rejected', async () => {
  const { store } = setup();
  for (const change of [{ id: '../other' }, { version: 2 }, { createdAt: 'yesterday' },
    { owner: { id: '42', login: 'Traveller' } }, { backgroundRevision: '' }, { backgroundRevision: 1 },
    { items: [{ ...batch().items[0], status: 'saved', file: null }] }]) {
    await assert.rejects(store.save({ ...batch(), ...change }), PendingStorageError);
  }
});

test('page and worker cannot acquire the upload lock concurrently; the lock is retained through callback completion', async () => {
  const { store, locks, vault } = setup(), other = createPendingStore({ vault, locks });
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  const first = store.lock(async () => { await wait; return 7; });
  assert.deepEqual(await other.lock(() => assert.fail('other context must not run')), { acquired: false });
  release(); assert.deepEqual(await first, { acquired: true, value: 7 });
  assert.deepEqual(await other.lock(() => 9), { acquired: true, value: 9 });
});

test('unsupported Web Locks does not persist photos and permits the caller to fall back to current-page mode', async () => {
  const store = createPendingStore({ vault: memoryVault(), locks: null });
  assert.equal(store.supported(), false);
  assert.deepEqual(await store.lock(() => assert.fail('cannot run without lock')), { acquired: false });
  await assert.rejects(store.save(batch()), PendingStorageError);
});

test('lock API errors and request timeouts never call the upload callback later', async () => {
  const failed = createPendingStore({ vault: memoryVault(), locks: { request() { throw new Error('private'); } } });
  await assert.rejects(failed.lock(() => {}), PendingStorageError);
  let delayed;
  const hung = createPendingStore({ vault: memoryVault(), timeoutMs: 5,
    locks: { request(_name, _options, callback) { delayed = callback; return new Promise(() => {}); } } });
  await assert.rejects(hung.lock(() => assert.fail('expired request cannot start work')), PendingStorageError);
  assert.deepEqual(await delayed({ name: 'lock' }), { acquired: false });
});
