import test from 'node:test';
import assert from 'node:assert/strict';
import { PhotoQueue } from '../upload/queue.mjs';
import { PendingStorageError } from '../upload/pending-store.mjs';

const photo = name => new File(['synthetic-photo'], name, { type: 'image/jpeg', lastModified: 1000 });
const later = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function client(overrides = {}) {
  const calls = [];
  return { user: { id: 42, login: 'Traveller' }, calls,
    async prepare(file, caption, id, { nameBase }) {
      calls.push(['prepare', id]);
      return { bytes: new Uint8Array(await file.arrayBuffer()), record: { id, originalName: file.name,
        fileName: `${nameBase}.jpg`, displayName: nameBase, caption: caption.replace(/\r\n?/g, '\n'),
        photoPath: `records/inbox/github-42/${id}/${nameBase}.jpg`, uploadedAt: '2026-10-09T01:00:00Z' } };
    },
    async lookup(prepared) { calls.push(['lookup', prepared.record.id]); return null; },
    async save(prepared) { calls.push(['save', prepared.record.id]); return receipt(prepared); },
    ...overrides,
  };
}
const receipt = prepared => ({ record: { ...prepared.record }, commitSha: 'a'.repeat(40) });

test('snapshot restores stable photo identities, names, captions and files without regenerating IDs', async () => {
  const queue = new PhotoQueue(); queue.add([photo('A.jpg'), photo('B.jpg')]);
  queue.items[0].caption = '湖边\r\n风景'; queue.remove(queue.items[1].id);
  const snapshot = structuredClone(queue.snapshot());
  const restored = new PhotoQueue({ randomUUID: () => { throw new Error('must not generate on restore'); } });
  restored.restore(snapshot);
  assert.equal(restored.items[0].uploadId, queue.items[0].uploadId);
  assert.equal(restored.items[0].nameBase, queue.items[0].nameBase);
  assert.equal(restored.items[0].caption, queue.items[0].caption);
  assert.equal(restored.items[0].file.name, 'A.jpg'); assert.equal(await restored.items[0].file.text(), 'synthetic-photo');
  assert.equal('prepared' in snapshot[0], false);
});

test('before remote writes checkpoint contains owner, stable ID and uncertain state; each confirmed receipt persists before next write', async () => {
  const queue = new PhotoQueue(), order = []; queue.add([photo('A.jpg'), photo('B.jpg')]);
  const connection = client({ async save(prepared) { order.push(`save:${prepared.record.id}`); return receipt(prepared); } });
  await queue.run(connection, { checkpoint: async () => {
    const states = queue.snapshot();
    const live = states.find(item => item.status === 'uploading');
    if (live) { assert.equal(live.owner.id, 42); assert.equal(live.uncertain, true); }
    const check = new PhotoQueue(); check.restore(structuredClone(states));
    order.push(states.filter(item => item.status === 'saved').length);
  } });
  assert.deepEqual(order, [0, `save:${queue.items[0].uploadId}`, 1, 1, `save:${queue.items[1].uploadId}`, 2]);
});

test('after suspension prepared buffers are discarded and lookup confirms same ID before attempting another write', async () => {
  const queue = new PhotoQueue(); queue.add([photo('A.jpg')]);
  let persisted;
  await queue.run(client({ async save() { throw new Error('suspended'); } }), {
    checkpoint: async () => { persisted = structuredClone(queue.snapshot()); },
  });
  const restored = new PhotoQueue(); restored.restore(persisted);
  assert.equal(restored.items[0].status, 'uncertain'); assert.equal(restored.items[0].prepared, null);
  const next = client({ async lookup(prepared) { next.calls.push(['lookup', prepared.record.id]); return receipt(prepared); },
    async save() { assert.fail('already committed photo cannot be sent twice'); } });
  assert.deepEqual(await restored.run(next, { checkpoint: async () => {} }), { complete: true });
  assert.deepEqual(next.calls, [['prepare', queue.items[0].uploadId], ['lookup', queue.items[0].uploadId]]);
});

test('a restored uncertain photo cannot be resumed with another GitHub account', async () => {
  const queue = new PhotoQueue(); queue.add([photo('A.jpg')]);
  await queue.run(client({ async save() { throw new Error('suspended'); } }));
  const restored = new PhotoQueue(); restored.restore(structuredClone(queue.snapshot()));
  const other = client({ user: { id: 99, login: 'Other' } });
  assert.equal((await restored.run(other)).error.code, 'ACCOUNT'); assert.deepEqual(other.calls, []);
});

test('saved snapshots release photo bytes, restore display information and never retry confirmed photos', async () => {
  const queue = new PhotoQueue(); queue.add([photo('A.jpg')]); await queue.run(client());
  const snapshots = queue.snapshot(); assert.equal(snapshots[0].file, null);
  const restored = new PhotoQueue(); restored.restore(structuredClone(snapshots));
  assert.equal(restored.items[0].file.name, 'A.jpg'); assert.equal(restored.items[0].file.size, 15);
  assert.equal(restored.items[0].file instanceof Blob, false);
  assert.equal(restored.items[0].receipt.record.fileName, queue.items[0].fileName);
  const next = client(); assert.deepEqual(await restored.run(next), { complete: true }); assert.deepEqual(next.calls, []);
  const appended = restored.add([photo('B.jpg')]).added[0]; assert.equal(appended.sequence, 2);
});

test('checkpoint failure before a network write pauses without making a write', async () => {
  const queue = new PhotoQueue(); queue.add([photo('A.jpg'), photo('B.jpg')]); const connection = client();
  const result = await queue.run(connection, { checkpoint: async () => { throw new PendingStorageError(); } });
  assert.ok(result.error instanceof PendingStorageError);
  assert.deepEqual(connection.calls.map(call => call[0]), ['prepare']);
  assert.equal(queue.items[0].status, 'uncertain'); assert.equal(queue.items[1].status, 'pending');
});

test('checkpoint failure after confirmation stops before the next photo without losing its receipt in memory', async () => {
  const queue = new PhotoQueue(); queue.add([photo('A.jpg'), photo('B.jpg')]); const connection = client();
  let calls = 0;
  const result = await queue.run(connection, { checkpoint: async () => { if (++calls === 2) throw new PendingStorageError(); } });
  assert.ok(result.error instanceof PendingStorageError);
  assert.equal(queue.items[0].status, 'saved'); assert.ok(queue.items[0].receipt);
  assert.equal(queue.items[1].status, 'pending');
  assert.deepEqual(connection.calls.map(call => call[0]), ['prepare', 'save']);
});

test('disconnect while checkpoint is pending prevents stale network submission', async () => {
  const queue = new PhotoQueue(); queue.add([photo('A.jpg')]); const connection = client();
  const entered = later(), resume = later(); let current = true;
  const result = queue.run(connection, { isCurrent: () => current, checkpoint: async () => { entered.resolve(); await resume.promise; } });
  await entered.promise; current = false; queue.interrupt(); resume.resolve();
  assert.deepEqual(await result, { stale: true }); assert.deepEqual(connection.calls.map(call => call[0]), ['prepare']);
});

test('a worker budget stops between photos after persisting the final receipt', async () => {
  const queue = new PhotoQueue(); queue.add([photo('A.jpg'), photo('B.jpg')]);
  let checkpointCount = 0;
  const result = await queue.run(client(), { checkpoint: async () => { checkpointCount++; },
    shouldContinue: () => queue.items.every(item => item.status !== 'saved') });
  assert.deepEqual(result, { paused: true }); assert.equal(checkpointCount, 2);
  assert.deepEqual(queue.items.map(item => item.status), ['saved', 'pending']);
});

test('snapshot validation is atomic and rejects duplicate IDs, invalid names, missing files and ownerless uncertain items', () => {
  const source = new PhotoQueue(); source.add([photo('A.jpg')]);
  const target = new PhotoQueue(); target.add([photo('existing.jpg')]); const original = target.items[0];
  const good = source.snapshot();
  for (const bad of [[good[0], good[0]], [{ ...good[0], uploadId: 'not-a-uuid' }], [{ ...good[0], nameBase: '../bad' }],
    [{ ...good[0], file: null }], [{ ...good[0], uncertain: true }], [{ ...good[0], sequence: 99 }],
    [{ ...good[0], caption: 'x'.repeat(4001) }], [{ ...good[0], owner: { id: '42', login: 'Traveller' } }]]) {
    assert.throws(() => target.restore(bad), error => error.code === 'CONFIG');
    assert.equal(target.items[0], original);
  }
});

test('authentication checkpoint failures keep their code so a background worker can stop retrying', async () => {
  const queue = new PhotoQueue(); queue.add([photo('A.jpg')]); const connection = client();
  const auth = Object.assign(new Error('连接已失效'), { name: 'PhotoError', code: 'AUTH' });
  const result = await queue.run(connection, { checkpoint: async () => { throw auth; } });
  assert.equal(result.error, auth);
  assert.deepEqual(connection.calls.map(call => call[0]), ['prepare']);
});

test('invalid originals are checkpointed so restoring does not retry them repeatedly', async () => {
  const queue = new PhotoQueue(); queue.add([photo('A.jpg')]);
  const invalid = Object.assign(new Error('invalid photo'), { name: 'PhotoError', code: 'INVALID' });
  let snapshot;
  const result = await queue.run(client({ async prepare() { throw invalid; } }), {
    checkpoint: async () => { snapshot = structuredClone(queue.snapshot()); },
  });
  assert.deepEqual(result, { complete: false }); assert.equal(snapshot[0].status, 'invalid');
  const restored = new PhotoQueue(); restored.restore(snapshot);
  const next = client(); await restored.run(next); assert.deepEqual(next.calls, []);
});

test('failed upload state persists without replacing the primary error if storage also fails', async () => {
  const queue = new PhotoQueue(); queue.add([photo('A.jpg')]);
  const denied = Object.assign(new Error('permission denied'), { name: 'PhotoError', code: 'PERMISSION' });
  let checkpoints = 0;
  const result = await queue.run(client({ async save() { throw denied; } }), {
    checkpoint: async () => { if (++checkpoints === 2) throw new PendingStorageError(); },
  });
  assert.equal(result.error, denied); assert.ok(result.checkpointError instanceof PendingStorageError);
  assert.equal(queue.items[0].error, denied.message); assert.equal(queue.items[0].status, 'uncertain');
});

test('restored saved receipts must stay bound to the original owner, photo path and size', async () => {
  const queue = new PhotoQueue(); queue.add([photo('A.jpg')]); await queue.run(client());
  const [saved] = queue.snapshot();
  for (const change of [{ photoPath: 'records/inbox/github-99/other/photo.jpg' }, { byteLength: 99 },
    { mimeType: 'image/svg+xml' }, { sha256: 'bad' }, { schemaVersion: 2 }, { metadataPath: '../other/record.json' }]) {
    const target = new PhotoQueue();
    assert.throws(() => target.restore([{ ...saved, receipt: { ...saved.receipt, record: { ...saved.receipt.record, ...change } } }]),
      error => error.code === 'CONFIG');
  }
});
