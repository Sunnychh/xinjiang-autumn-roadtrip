import assert from 'node:assert/strict';
import test from 'node:test';
import { createBackgroundUploadRunner, BackgroundUploadRetryError, UPLOAD_SYNC_TAG } from '../upload/background-runner.mjs';
import { PhotoQueue } from '../upload/queue.mjs';
import { PhotoError } from '../upload/github.mjs';

const USER = { id: 71, login: 'SyntheticTraveller' };
const BATCH = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REVISION = 'remembered-synthetic-revision';
const TOKEN = 'LOCAL_TEST_ONLY_NOT_A_REAL_CREDENTIAL';
const DATE = '2026-10-09T08:00:00.000Z';
const photoId = index => `${String(index).padStart(8, '0')}-1111-4111-8111-111111111111`;

function fixture(count = 2, options = {}) {
  let next = 1;
  const original = new PhotoQueue({ now: () => new Date(DATE), randomUUID: () => photoId(next++) });
  original.add(Array.from({ length: count }, (_, index) => new File([`synthetic-image-${index}`], `test-${index}.jpg`, { type: 'image/jpeg' })));
  const state = {
    batch: { version: 1, id: BATCH, owner: USER, createdAt: DATE, backgroundRevision: REVISION, items: original.snapshot() },
    revision: REVISION, token: TOKEN, locked: false, connected: 0, disconnected: 0, writes: [],
    checkpoints: [], notifications: [], receipts: new Map(), clock: 0, listeners: new Set(),
  };
  const store = {
    supportsPendingUploads: () => options.supported !== false,
    loadPendingBatch: async () => state.batch && structuredClone(state.batch),
    savePendingBatch: async value => { await options.beforeCheckpoint?.(value, state); state.batch = structuredClone(value); state.checkpoints.push(structuredClone(value)); },
    withUploadLock: async callback => {
      if (state.locked) return { acquired: false };
      state.locked = true;
      try { return { acquired: true, value: await callback() }; } finally { state.locked = false; }
    },
  };
  const credentials = {
    loadDeviceConnection: async () => ({ token: state.token, revision: state.revision }),
    getDeviceRevision: async () => state.revision,
    onDeviceForgotten: listener => { state.listeners.add(listener); return () => state.listeners.delete(listener); },
  };
  state.forget = () => { state.token = null; state.revision = 'forgotten'; for (const listener of state.listeners) listener(); };
  const connectClient = async token => {
    assert.equal(token, TOKEN);
    state.connected++;
    await options.beforeConnect?.(state);
    let disconnected = false;
    const connected = () => { assert.equal(disconnected, false, 'no authenticated request after disconnect'); };
    return {
      user: options.user || USER,
      async prepare(file, caption, id, { nameBase }) {
        connected();
        await options.beforePrepare?.(state);
        return { record: { schemaVersion: 1, id, originalName: file.name, caption,
          fileName: `${nameBase}.jpg`, displayName: nameBase, uploadedAt: DATE,
          photoPath: `records/inbox/github-${USER.id}/${id}/${nameBase}.jpg` } };
      },
      async save(prepared) {
        connected();
        assert.ok(state.checkpoints.some(batch => batch.items.some(item => item.uploadId === prepared.record.id && item.uncertain)), 'stable upload identity is saved before writes');
        state.writes.push(prepared.record.id);
        const receipt = { record: structuredClone(prepared.record), commitSha: '1'.repeat(40) };
        await options.beforeSave?.(state, receipt);
        state.receipts.set(prepared.record.id, receipt);
        await options.afterSave?.(state, receipt);
        return receipt;
      },
      async lookup(prepared) {
        connected(); await options.beforeLookup?.(state);
        return state.receipts.get(prepared.record.id) || null;
      },
      disconnect() { disconnected = true; state.disconnected++; },
    };
  };
  state.run = createBackgroundUploadRunner({ store, credentials, connectClient,
    canLock: () => options.canLock !== false, now: () => state.clock, budgetMs: options.budgetMs || 1000,
    notify: async value => state.notifications.push(value) });
  return state;
}

test('background runs require durable storage and a cross-context lock', async () => {
  for (const options of [{ supported: false }, { canLock: false }]) {
    const state = fixture(1, options);
    assert.deepEqual(await state.run(), { status: 'unavailable' });
    assert.equal(state.connected, 0);
  }
});

test('empty and completed queues do not open credentials or upload again', async () => {
  const state = fixture(1);
  assert.equal((await state.run()).status, 'complete');
  assert.equal((await state.run()).status, 'complete');
  assert.equal(state.connected, 1);
  assert.equal(state.writes.length, 1);
  state.batch = null;
  assert.deepEqual(await state.run(), { status: 'empty' });
});

test('a batch needs explicit background authorization for the same device revision', async () => {
  for (const kind of ['no-consent', 'no-key', 'changed-key']) {
    const state = fixture(1);
    if (kind === 'no-consent') state.batch.backgroundRevision = null;
    else if (kind === 'no-key') state.token = null;
    else state.revision = 'new-key';
    assert.equal((await state.run()).status, kind === 'no-consent' ? 'foreground-only' : 'reconnect');
    assert.equal(state.connected, 0);
    assert.equal(state.writes.length, 0);
  }
});

test('account mismatch never prepares or writes photos', async () => {
  const state = fixture(1, { user: { id: 99, login: 'DifferentTraveller' } });
  assert.equal((await state.run()).status, 'account');
  assert.equal(state.writes.length, 0);
  assert.equal(state.disconnected, 1);
});

test('expired keys and denied permissions do not request automatic retries', async () => {
  for (const code of ['AUTH', 'PERMISSION', 'PRIVATE', 'CONFIG', 'ACCOUNT']) {
    const state = fixture(1, { beforeConnect: () => { throw new PhotoError('Synthetic failure', 401, code); } });
    assert.equal((await state.run()).status, 'attention');
    assert.equal(state.writes.length, 0);
    assert.equal(state.listeners.size, 0);
  }
});

test('transient connection failures ask the browser to retry without leaking error content', async () => {
  const state = fixture(1, { beforeConnect: () => { throw new PhotoError(TOKEN, 0, 'NETWORK'); } });
  await assert.rejects(state.run(), error => error instanceof BackgroundUploadRetryError && !error.message.includes(TOKEN));
  assert.equal(state.writes.length, 0);
  assert.equal(state.locked, false);
});

test('forgetting the device during connection prevents any preparation or writes', async () => {
  const state = fixture(1, { beforeConnect: current => current.forget() });
  assert.equal((await state.run()).status, 'stopped');
  assert.equal(state.writes.length, 0);
  assert.equal(state.disconnected, 2);
  assert.equal(state.listeners.size, 0);
});

test('revision is checked again immediately before each commit even without broadcast', async () => {
  const state = fixture(1, { beforePrepare: current => { current.revision = 'changed-in-another-tab'; } });
  assert.equal((await state.run()).status, 'stopped');
  assert.equal(state.writes.length, 0);
  assert.equal(state.checkpoints.length, 0);
});

test('successful receipts and originals are checkpointed using stable identities', async () => {
  const state = fixture(2);
  assert.deepEqual(await state.run(), { status: 'complete', id: BATCH, pending: 0 });
  assert.equal(state.checkpoints.length, 4);
  assert.deepEqual(state.writes, [photoId(1), photoId(2)]);
  assert.ok(state.batch.items.every(item => item.status === 'saved' && item.file === null && item.receipt));
  assert.ok(state.notifications.every(message => JSON.stringify(message) === JSON.stringify({ type: 'upload-queue-changed', id: BATCH })));
  assert.equal(state.listeners.size, 0);
  assert.equal(state.disconnected, 1);
});

test('a lost acknowledgement is recovered by lookup on retry without a second write', async () => {
  let lose = true;
  const state = fixture(1, {
    afterSave: () => { if (lose) throw new PhotoError('Synthetic lost acknowledgement', 0, 'NETWORK'); },
    beforeLookup: () => { if (lose) throw new PhotoError('Synthetic unavailable lookup', 0, 'NETWORK'); },
  });
  await assert.rejects(state.run(), BackgroundUploadRetryError);
  assert.equal(state.batch.items[0].uncertain, true);
  const originalId = state.batch.items[0].uploadId;
  lose = false;
  assert.equal((await state.run()).status, 'complete');
  assert.equal(state.writes.length, 1);
  assert.equal(state.batch.items[0].uploadId, originalId);
  assert.equal(state.batch.items[0].status, 'saved');
});

test('storage failure before a commit prevents remote writes and automatic retry', async () => {
  const state = fixture(1, { beforeCheckpoint: () => { throw new Error('synthetic storage failure'); } });
  assert.equal((await state.run()).status, 'attention');
  assert.equal(state.writes.length, 0);
});

test('invalid originals remain marked invalid after restoring the background queue', async () => {
  const state = fixture(1, { beforePrepare: () => { throw new PhotoError('Synthetic invalid image', 400, 'INVALID'); } });
  assert.equal((await state.run()).status, 'complete');
  assert.equal(state.batch.items[0].status, 'invalid');
  assert.equal(state.writes.length, 0);
  assert.equal((await state.run()).status, 'complete');
  assert.equal(state.connected, 1);
});

test('one worker or tab owns the batch; a competing run asks for later retry', async () => {
  let release, began;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { began = resolve; });
  const state = fixture(1, { beforeSave: async () => { began(); await gate; } });
  const first = state.run();
  await started;
  await assert.rejects(state.run(), BackgroundUploadRetryError);
  assert.equal(state.connected, 1);
  release();
  assert.equal((await first).status, 'complete');
  assert.equal(state.writes.length, 1);
});

test('time budget pauses between photos while checkpointing the in-flight receipt', async () => {
  const state = fixture(2, { afterSave: current => { current.clock += 2000; } });
  assert.deepEqual(await state.run(), { status: 'paused', id: BATCH, pending: 1 });
  assert.equal(state.batch.items[0].status, 'saved');
  assert.equal(state.batch.items[1].status, 'pending');
  assert.equal((await state.run()).status, 'complete');
  assert.deepEqual(state.writes, [photoId(1), photoId(2)]);
});

test('forgetting during a write leaves durable uncertainty for later foreground recovery', async () => {
  const state = fixture(2, { afterSave: current => current.forget() });
  assert.equal((await state.run()).status, 'stopped');
  assert.equal(state.writes.length, 1);
  assert.equal(state.batch.items[0].uncertain, true);
  assert.equal(state.batch.items[1].status, 'pending');
  assert.equal((await state.run()).status, 'reconnect');
});

test('service worker activates and ignores untrusted messages and unrelated sync tags', async () => {
  const previous = globalThis.self, listeners = new Map(), waits = [];
  let skipped = false, claimed = false;
  globalThis.self = {
    registration: { scope: 'https://example.test/trip/upload/' },
    clients: { claim: async () => { claimed = true; } },
    skipWaiting: async () => { skipped = true; },
    addEventListener: (name, listener) => listeners.set(name, listener),
  };
  try {
    await import('../upload/sw.mjs');
    const waitUntil = task => waits.push(task);
    listeners.get('install')({ waitUntil }); listeners.get('activate')({ waitUntil });
    await Promise.all(waits);
    assert.equal(skipped, true); assert.equal(claimed, true);
    assert.equal(listeners.has('fetch'), false, 'never cache private API responses');
    const never = () => assert.fail('untrusted message must not start uploading');
    for (const url of ['https://evil.test/trip/upload/', 'https://example.test/trip/', 'https://example.test/trip/upload-other/']) {
      listeners.get('message')({ data: { type: 'resume-uploads' }, source: { url }, waitUntil: never });
    }
    listeners.get('message')({ data: { type: 'wrong' }, source: { url: 'https://example.test/trip/upload/' }, waitUntil: never });
    listeners.get('sync')({ tag: 'unrelated', waitUntil: never });
    assert.equal(UPLOAD_SYNC_TAG, 'xinjiang-photo-uploads');
  } finally { globalThis.self = previous; }
});
