import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { PhotoError } from '../upload/github.mjs?v=20260929-cards';
import { PhotoQueue } from '../upload/queue.mjs?v=20260929-cards';

// Exercise the UI with the real queue while stubbing credentials, device storage,
// remote GitHub operations and browser APIs. No real tokens or photos are used.
const source = readFileSync(new URL('../upload/app.mjs', import.meta.url), 'utf8')
  .replace(/^import\s[^;]+;\s*$/gm, '');
const html = readFileSync(new URL('../upload/index.html', import.meta.url), 'utf8');
const TEST_TOKEN = 'test-only-device-token-not-a-real-credential';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function flush() {
  for (let i = 0; i < 100; i++) await Promise.resolve();
}

class Element {
  constructor(id = '', tag = '') {
    this.id = id;
    this.tagName = tag.match(/^<?([a-z]+)/i)?.[1]?.toUpperCase() || '';
    this.hidden = /\bhidden\b/.test(tag);
    this.disabled = /\bdisabled\b/.test(tag);
    this.checked = /\bchecked\b/.test(tag);
    this.indeterminate = false;
    this.value = '';
    this.textContent = '';
    this.dataset = {};
    this.attributes = {};
    this.files = [];
    this.listeners = new Map();
    this.children = [];
  }
  addEventListener(name, listener) {
    const listeners = this.listeners.get(name) || [];
    listeners.push(listener); this.listeners.set(name, listeners);
  }
  emit(name, event = {}) {
    return (this.listeners.get(name) || []).map(listener => listener({
      target: this, currentTarget: this, preventDefault() {}, ...event,
    }));
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  focus() { this.focused = true; }
  click() { if (!this.disabled) this.emit('click'); }
}

function descendants(node) {
  return node.children.flatMap(child => [child, ...descendants(child)]);
}

function hasClass(node, className) {
  return String(node.className || '').split(/\s+/).includes(className);
}

function previewButton(row) {
  return descendants(row).find(node => hasClass(node, 'queue-item'));
}

function fixture(options = {}) {
  const elements = new Map();
  for (const match of html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)) {
    elements.set(match[1], new Element(match[1], match[0]));
  }
  const element = id => {
    assert.ok(elements.has(id), `The UI references missing element #${id}`);
    return elements.get(id);
  };
  const card = index => {
    const row = element('photo-queue').children[index];
    assert.ok(row, `Photo card ${index} must exist`);
    return row;
  };
  const captionField = (index = element('photo-queue').children.findIndex(row => previewButton(row)?.attributes['aria-pressed'] === 'true')) => {
    const field = descendants(card(index)).find(node => node.tagName === 'TEXTAREA');
    assert.ok(field, `Photo card ${index} must have its own caption field`);
    return field;
  };
  const selectCheckbox = index => {
    const checkbox = descendants(card(index)).find(node => hasClass(node, 'batch-photo-select'));
    assert.ok(checkbox, `Photo card ${index} must have a batch selection checkbox`);
    return checkbox;
  };
  const removeButton = index => {
    const button = descendants(card(index)).find(node => String(node.className).split(/\s+/).includes('remove-card-photo'));
    assert.ok(button, `Photo card ${index} must have its own remove button`);
    return button;
  };
  const events = new Map(), documentEvents = new Map(), connections = [], probes = [], storageCalls = [], forgottenListeners = [];
  const pendingCalls = [], lockCalls = [];
  let pendingBatch = options.pendingBatch ?? null;
  let stored = options.stored ?? null, revision = 'revision-0', revisions = 0, previewCount = 0;
  const window = {
    addEventListener(name, listener) {
      const listeners = events.get(name) || [];
      listeners.push(listener); events.set(name, listeners);
    },
  };
  const document = {
    getElementById: element, createElement: tag => new Element('', tag), visibilityState: 'visible',
    addEventListener(name, listener) {
      const listeners = documentEvents.get(name) || [];
      listeners.push(listener); documentEvents.set(name, listeners);
    },
  };
  const navigator = { onLine: true, ...options.navigator };
  const context = vm.createContext({
    document, window, navigator, PhotoError, PhotoQueue,
    PendingStorageError: class PendingStorageError extends Error {
      constructor(message, code = 'STORAGE') { super(message); this.name = 'PendingStorageError'; this.code = code; }
    },
    supportsPendingUploads: () => options.pendingSupported ?? false,
    async loadPendingBatch(...args) {
      pendingCalls.push({ method: 'load', args });
      return options.loadPending ? options.loadPending(...args) : pendingBatch;
    },
    async savePendingBatch(batch, ...args) {
      pendingCalls.push({ method: 'save', batch, args });
      if (options.savePending) await options.savePending(batch, ...args);
      pendingBatch = batch;
      return batch;
    },
    async clearPendingBatch(...args) {
      pendingCalls.push({ method: 'clear', args });
      if (options.clearPending) await options.clearPending(...args);
      pendingBatch = null;
      return true;
    },
    async withUploadLock(...args) {
      lockCalls.push(args);
      if (options.withUploadLock) return options.withUploadLock(...args);
      const operation = args.find(arg => typeof arg === 'function');
      return { acquired: true, value: await operation() };
    },
    MAX_BYTES: 20 * 1024 * 1024,
    connect(token, callbacks = {}) {
      const pending = deferred();
      connections.push({ ...pending, token, callbacks });
      return pending.promise;
    },
    connectionErrorMessage: error => error?.message || 'Connection failed.',
    probeGitHub() { const pending = deferred(); probes.push(pending); return pending.promise; },
    async loadDeviceConnection() {
      storageCalls.push({ method: 'load' });
      if (options.load) return options.load();
      return { token: stored, revision };
    },
    getDeviceRevision() {
      storageCalls.push({ method: 'revision' });
      return revision;
    },
    async rememberDeviceToken(token, { expectedRevision } = {}) {
      storageCalls.push({ method: 'remember', token, expectedRevision });
      if (options.remember) await options.remember(token);
      if (expectedRevision !== undefined && expectedRevision !== revision) {
        const error = new Error('Device changed during connection'); error.code = 'DEVICE_CHANGED'; throw error;
      }
      stored = token;
      revision = `revision-${++revisions}`;
      return revision;
    },
    async forgetDeviceToken({ expectedRevision } = {}) {
      storageCalls.push({ method: 'forget', expectedRevision });
      if (options.forget) await options.forget();
      if (expectedRevision !== undefined && expectedRevision !== revision) return false;
      stored = null;
      revision = `revision-${++revisions}`;
      return true;
    },
    onDeviceForgotten(listener) { forgottenListeners.push(listener); return () => {}; },
    URL: {
      createObjectURL(file) {
        if (options.pendingSupported) assert.ok(file instanceof Blob, 'Restored saved placeholders must never be used as image blobs');
        previewCount++; return 'blob:test-photo';
      },
      revokeObjectURL() {},
    },
    Date, Intl,
    setTimeout(callback, delay) { const timer = setTimeout(callback, delay); timer.unref(); return timer; },
    clearTimeout, queueMicrotask, crypto, Blob,
  });
  vm.runInContext(source, context, { filename: 'upload/app.mjs' });
  return {
    element, card, captionField, selectCheckbox, removeButton, connections, probes, storageCalls, pendingCalls, lockCalls,
    get pendingBatch() { return pendingBatch; },
    get stored() { return stored; },
    get revision() { return revision; },
    get previewCount() { return previewCount; },
    async event(name, detail = {}) {
      for (const listener of events.get(name) || []) listener(detail);
      await flush();
    },
    async visibility(value) {
      document.visibilityState = value;
      for (const listener of documentEvents.get('visibilitychange') || []) listener();
      await flush();
    },
    async submit(token = TEST_TOKEN, remember = true) {
      element('github-token').value = token;
      element('remember-device').checked = remember;
      element('connect-form').emit('submit');
      await flush();
    },
    async click(id) { element(id).click(); await flush(); },
    async selectPhoto(files = [{ name: 'test.jpg', size: 20, type: 'image/jpeg' }]) {
      for (const file of files) if (file && !file.arrayBuffer) file.arrayBuffer = async () => new ArrayBuffer(file.size);
      element('photo-library').files = files;
      element('photo-library').emit('change');
      await flush();
    },
    async selectItem(index) {
      const row = element('photo-queue').children[index];
      assert.ok(row, `Photo queue item ${index} must exist`);
      previewButton(row).click();
      await flush();
    },
    async caption(value, index) {
      const field = captionField(index);
      field.value = value;
      field.emit('input');
      await flush();
    },
    async toggleBulkPhoto(index, checked = true) {
      const checkbox = selectCheckbox(index);
      checkbox.checked = checked;
      checkbox.emit('change');
      await flush();
    },
    async selectAll(checked = true) {
      element('bulk-select-all').checked = checked;
      element('bulk-select-all').emit('change');
      await flush();
    },
    async bulkCaption(value) {
      element('bulk-caption').value = value;
      element('bulk-caption').emit('input');
      await flush();
    },
    async applyRaw() { element('bulk-apply').emit('click'); await flush(); },
    async removeItem(index) { removeButton(index).click(); await flush(); },
    async upload() { element('upload-form').emit('submit'); await flush(); },
    replaceFromOtherTab(token) { stored = token; revision = `revision-${++revisions}`; },
    async forgetFromOtherTab() {
      stored = null; revision = `revision-${++revisions}`;
      for (const listener of forgottenListeners) listener();
      await flush();
    },
  };
}

function client(overrides = {}) {
  const instance = {
    user: { id: 123, login: 'TestTraveller' }, disconnected: 0,
    disconnect() { this.disconnected++; },
    async prepare(file, caption) {
      return { record: { id: `test-upload-${file.name}`, originalName: file.name, fileName: file.name, caption,
        photoPath: `records/inbox/test/${file.name}`,
        uploadedAt: '2026-09-29T12:00:00Z' } };
    },
    async lookup() { return null; },
    async save(prepared) { return { record: prepared.record, commitSha: 'a'.repeat(40) }; },
    ...overrides,
  };
  return instance;
}

async function connected(options = {}, overrides = {}) {
  const f = fixture(options);
  await flush();
  if (!options.stored) await f.submit();
  assert.equal(f.connections.length, 1);
  const connection = client(overrides);
  f.connections[0].resolve(connection);
  await flush();
  return { f, connection };
}

const countStorage = (f, method) => f.storageCalls.filter(call => call.method === method).length;
const status = f => ['connection-status', 'network-status', 'upload-status']
  .map(id => f.element(id).textContent).join('\n');

test('first visit defaults to remember and blocks photo selection before connection', async () => {
  const f = fixture();
  await flush();
  assert.equal(f.element('remember-device').checked, true);
  assert.equal(f.connections.length, 0);
  assert.equal(f.element('photo-library').disabled, true);
  assert.equal(f.element('choose-photo').disabled, true);
  await f.selectPhoto();
  assert.equal(f.previewCount, 0, 'A dispatched change event must also respect the connection guard');
  assert.equal(countStorage(f, 'remember'), 0);
});

test('manual token is cleared immediately and remembered only after successful connection', async () => {
  const f = fixture();
  await flush();
  await f.submit();
  assert.equal(f.element('github-token').value, '');
  assert.equal(f.connections.length, 1);
  assert.equal(countStorage(f, 'remember'), 0);
  f.connections[0].resolve(client());
  await flush();
  assert.equal(countStorage(f, 'remember'), 1);
  assert.equal(f.stored, TEST_TOKEN);
  assert.equal(f.element('choose-photo').disabled, false);
  assert.ok(!status(f).includes(TEST_TOKEN));
});

test('failed manual connection never stores the rejected token', async () => {
  const f = fixture();
  await flush();
  await f.submit();
  f.connections[0].reject(new PhotoError('rejected', 401, 'AUTH'));
  await flush();
  assert.equal(countStorage(f, 'remember'), 0);
  assert.equal(f.stored, null);
  assert.equal(f.element('github-token').value, '');
  assert.equal(f.element('choose-photo').disabled, true);
});

test('opting out does not remember the token', async () => {
  const f = fixture();
  await flush();
  await f.submit(TEST_TOKEN, false);
  f.connections[0].resolve(client());
  await flush();
  assert.equal(countStorage(f, 'remember'), 0);
  assert.equal(f.stored, null);
  assert.equal(f.element('choose-photo').disabled, false);
});

test('storage load failure leaves manual connection usable and hides internal error details', async () => {
  const secretDetail = 'storage-debug-private-value';
  const f = fixture({ load: async () => { throw new Error(secretDetail); } });
  await flush();
  assert.equal(f.element('github-token').disabled, false);
  assert.equal(f.element('connect-button').disabled, false);
  assert.ok(status(f).trim());
  assert.ok(!status(f).includes(secretDetail));
  await f.submit();
  assert.equal(f.connections.length, 1);
});

test('storage save failure keeps the verified connection but does not claim the device is remembered', async () => {
  const { f } = await connected({ remember: async () => { throw new Error('private-storage-error'); } });
  assert.equal(f.stored, null);
  assert.equal(f.element('choose-photo').disabled, false);
  assert.match(status(f), /未|无法|不能|失败/);
  assert.ok(!status(f).includes('private-storage-error'));
  assert.ok(!status(f).includes(TEST_TOKEN));
});

test('stored token connects automatically, survives network failures and can be retried', async () => {
  const f = fixture({ stored: TEST_TOKEN });
  await flush();
  assert.equal(f.connections.length, 1);
  assert.equal(f.connections[0].token, TEST_TOKEN);
  f.connections[0].reject(new PhotoError('offline', 0, 'NETWORK'));
  await flush();
  assert.equal(countStorage(f, 'forget'), 0);
  assert.equal(f.stored, TEST_TOKEN);
  assert.equal(f.element('retry-connection').hidden, false);
  await f.click('retry-connection');
  assert.equal(f.connections.length, 2);
  assert.equal(f.connections[1].token, TEST_TOKEN);
});

test('401 from an automatically loaded token removes the saved credential', async () => {
  const f = fixture({ stored: TEST_TOKEN });
  await flush();
  f.connections[0].reject(new PhotoError('expired', 401, 'AUTH'));
  await flush();
  assert.equal(countStorage(f, 'forget'), 1);
  assert.equal(f.stored, null);
  assert.equal(f.element('choose-photo').disabled, true);
  assert.equal(f.element('github-token').value, '');
});

test('forget waits for deletion before reporting success', async () => {
  const deletion = deferred();
  const { f } = await connected({ stored: TEST_TOKEN, forget: () => deletion.promise });
  await f.click('forget-device');
  assert.equal(countStorage(f, 'forget'), 1);
  assert.equal(f.stored, TEST_TOKEN);
  assert.doesNotMatch(status(f), /已(?:从.*)?(?:清除|删除|忘记)/);
  deletion.resolve();
  await flush();
  assert.equal(f.stored, null);
  assert.match(status(f), /清除|删除|忘记/);
  assert.equal(f.element('choose-photo').disabled, true);
});

test('forget failure never claims deletion and offers a safe error', async () => {
  const { f } = await connected({ stored: TEST_TOKEN, forget: async () => { throw new Error('private-delete-detail'); } });
  await f.click('forget-device');
  assert.equal(f.stored, TEST_TOKEN);
  assert.match(status(f), /未|无法|不能|失败/);
  assert.doesNotMatch(status(f), /已(?:从.*)?(?:清除|删除|忘记)/);
  assert.ok(!status(f).includes('private-delete-detail'));
  assert.ok(!status(f).includes(TEST_TOKEN));
});

test('late connection success after pagehide is discarded and never remembered', async () => {
  const f = fixture();
  await flush();
  await f.submit();
  await f.event('pagehide');
  const old = client();
  f.connections[0].resolve(old);
  await flush();
  assert.equal(old.disconnected, 1);
  assert.equal(countStorage(f, 'remember'), 0);
  assert.equal(f.element('choose-photo').disabled, true);
});

test('late connection failure does not replace a connection made after a bfcache return', async () => {
  const f = fixture({ stored: TEST_TOKEN });
  await flush();
  await f.event('pagehide');
  await f.event('pageshow', { persisted: true });
  assert.equal(f.connections.length, 2);
  const fresh = client();
  f.connections[1].resolve(fresh);
  await flush();
  const previous = status(f);
  f.connections[0].reject(new PhotoError('old auth failure', 401, 'AUTH'));
  await flush();
  assert.equal(status(f), previous);
  assert.equal(f.element('choose-photo').disabled, false);
  assert.equal(fresh.disconnected, 0);
  assert.equal(countStorage(f, 'forget'), 0);
});

test('late preparation result after pagehide cannot revive the obsolete client or replace an automatically resumed receipt', async () => {
  const preparation = deferred();
  let saves = 0;
  const { f } = await connected({ stored: TEST_TOKEN }, {
    prepare: () => preparation.promise,
    save: async () => { saves++; throw new Error('Should not run'); },
  });
  await f.selectPhoto();
  await f.upload();
  await f.event('pagehide');
  await f.event('pageshow', { persisted: true });
  f.connections[1].resolve(client());
  await flush();
  const resumedStatus = status(f);
  preparation.resolve({ record: { id: 'obsolete' } });
  await flush();
  assert.equal(saves, 0);
  assert.equal(status(f), resumedStatus);
  assert.equal(f.element('upload-receipt').hidden, false);
  assert.equal(f.element('upload-form').attributes['aria-busy'], 'false');
});

test('old upload 401 cannot disconnect or erase the credential of a fresh connection', async () => {
  const saving = deferred();
  const { f } = await connected({ stored: TEST_TOKEN }, { save: () => saving.promise });
  await f.selectPhoto();
  await f.upload();
  await f.event('pagehide');
  await f.event('pageshow', { persisted: true });
  const fresh = client();
  f.connections[1].resolve(fresh);
  await flush();
  const previous = status(f);
  saving.reject(new PhotoError('old upload failure', 401, 'AUTH'));
  await flush();
  assert.equal(status(f), previous);
  assert.equal(fresh.disconnected, 0);
  assert.equal(countStorage(f, 'forget'), 0);
  assert.equal(f.stored, TEST_TOKEN);
  assert.equal(f.element('upload-form').attributes['aria-busy'], 'false');
});

test('pending successful remember is ordered before loading on a bfcache return', async () => {
  const remembering = deferred();
  const f = fixture({ remember: () => remembering.promise });
  await flush();
  await f.submit();
  const old = client();
  f.connections[0].resolve(old);
  await flush();
  assert.equal(countStorage(f, 'remember'), 1);
  await f.event('pagehide');
  await f.event('pageshow', { persisted: true });
  assert.equal(countStorage(f, 'load'), 1, 'Restore must not read before the pending write finishes');
  assert.equal(f.connections.length, 1);
  remembering.resolve();
  await flush();
  assert.equal(f.stored, TEST_TOKEN);
  assert.equal(countStorage(f, 'load'), 2);
  assert.equal(f.connections.length, 2);
  const fresh = client();
  f.connections[1].resolve(fresh);
  await flush();
  assert.equal(old.disconnected, 1);
  assert.equal(f.element('choose-photo').disabled, false);
  assert.equal(fresh.disconnected, 0);
});

test('forget finishes after pagehide without allowing automatic restore to revive it', async () => {
  const deletion = deferred();
  const { f } = await connected({ stored: TEST_TOKEN, forget: () => deletion.promise });
  await f.click('forget-device');
  assert.equal(countStorage(f, 'forget'), 1);
  await f.event('pagehide');
  await f.event('pageshow', { persisted: true });
  assert.equal(countStorage(f, 'load'), 1);
  assert.equal(f.connections.length, 1);
  deletion.resolve();
  await flush();
  assert.equal(f.stored, null);
  assert.equal(countStorage(f, 'load'), 1, 'An explicit forget suppresses automatic restoration');
  assert.equal(f.connections.length, 1, 'A forgotten credential must never reconnect');
  assert.equal(f.element('choose-photo').disabled, true);
});

test('401 credential deletion completes before restore load even after pagehide', async () => {
  const deletion = deferred();
  const f = fixture({ stored: TEST_TOKEN, forget: () => deletion.promise });
  await flush();
  f.connections[0].reject(new PhotoError('expired', 401, 'AUTH'));
  await flush();
  assert.equal(countStorage(f, 'forget'), 1);
  await f.event('pagehide');
  await f.event('pageshow', { persisted: true });
  assert.equal(countStorage(f, 'load'), 1);
  deletion.resolve();
  await flush();
  assert.equal(countStorage(f, 'load'), 2);
  assert.equal(f.stored, null);
  assert.equal(f.connections.length, 1);
});

test('401 from an old revision cannot delete a replacement stored by another tab', async () => {
  const f = fixture({ stored: TEST_TOKEN });
  await flush();
  const originalRevision = f.revision;
  const replacement = 'replacement-test-token-not-a-real-credential';
  f.replaceFromOtherTab(replacement);
  f.connections[0].reject(new PhotoError('expired old token', 401, 'AUTH'));
  await flush();
  assert.equal(countStorage(f, 'forget'), 1);
  assert.equal(f.storageCalls.find(call => call.method === 'forget').expectedRevision, originalRevision);
  assert.equal(f.stored, replacement);
  assert.equal(f.element('choose-photo').disabled, true);
});

test('manual connection cannot overwrite a token changed in another tab while verification runs', async () => {
  const f = fixture();
  await flush();
  await f.submit();
  const replacement = 'other-tab-test-token-not-a-real-credential';
  f.replaceFromOtherTab(replacement);
  f.connections[0].resolve(client());
  await flush();
  assert.equal(f.stored, replacement);
  assert.match(status(f), /未|无法|不能|失败|变化|更新/);
  assert.ok(!status(f).includes(replacement));
  assert.ok(!status(f).includes(TEST_TOKEN));
});

test('another-tab forget disconnects and suppresses automatic restoration until manual connection', async () => {
  const { f, connection } = await connected({ stored: TEST_TOKEN });
  await f.forgetFromOtherTab();
  assert.equal(connection.disconnected, 1);
  assert.equal(f.element('choose-photo').disabled, true);
  assert.equal(f.element('github-token').value, '');
  // The other tab may subsequently remember another credential. This tab still
  // honors the forget event instead of silently restoring the newly stored one.
  f.replaceFromOtherTab('other-device-test-token-not-a-real-credential');
  await f.event('pagehide');
  await f.event('pageshow', { persisted: true });
  assert.equal(f.connections.length, 1);
  await f.submit();
  assert.equal(f.connections.length, 2);
  assert.equal(f.connections[1].token, TEST_TOKEN);
});

test('successful connection without remember removes an older stored credential', async () => {
  const f = fixture({ stored: 'old-test-token-not-a-real-credential' });
  await flush();
  f.connections[0].reject(new PhotoError('network unavailable', 0, 'NETWORK'));
  await flush();
  await f.submit(TEST_TOKEN, false);
  assert.equal(countStorage(f, 'forget'), 0, 'Keep the prior record until replacement verification succeeds');
  f.connections[1].resolve(client());
  await flush();
  assert.equal(countStorage(f, 'remember'), 0);
  assert.equal(countStorage(f, 'forget'), 1);
  assert.equal(f.stored, null);
  assert.equal(f.element('choose-photo').disabled, false);
});

test('401 during a current upload clears the saved credential and releases busy UI', async () => {
  const deletion = deferred();
  const { f } = await connected({ stored: TEST_TOKEN, forget: () => deletion.promise }, {
    save: async () => { throw new PhotoError('expired', 401, 'AUTH'); },
  });
  await f.selectPhoto();
  await f.upload();
  assert.equal(countStorage(f, 'forget'), 1);
  assert.equal(f.element('choose-photo').disabled, true);
  assert.equal(f.element('upload-progress-wrap').hidden, true);
  deletion.resolve();
  await flush();
  assert.equal(f.stored, null);
  assert.equal(f.element('github-token').disabled, false);
  assert.equal(f.element('upload-form').attributes['aria-busy'], 'false');
});

test('upload network failure retains the saved connection and allows receipt reconciliation', async () => {
  let lookups = 0;
  const { f } = await connected({ stored: TEST_TOKEN }, {
    save: async () => { throw new PhotoError('offline', 0, 'NETWORK'); },
    lookup: async () => { lookups++; return null; },
  });
  await f.selectPhoto();
  await f.upload();
  assert.equal(lookups, 1);
  assert.equal(countStorage(f, 'forget'), 0);
  assert.equal(f.stored, TEST_TOKEN);
  assert.equal(f.element('upload-submit').disabled, false);
  assert.equal(f.element('choose-photo').disabled, true, 'Uncertain upload must keep its original photo');
  assert.equal(f.element('upload-receipt').hidden, true);
});

test('401 after an opted-out connection does not claim a nonexistent saved token failed to delete', async () => {
  const f = fixture();
  await flush();
  await f.submit(TEST_TOKEN, false);
  f.connections[0].resolve(client({ save: async () => { throw new PhotoError('expired', 401, 'AUTH'); } }));
  await flush();
  const before = countStorage(f, 'forget');
  await f.selectPhoto();
  await f.upload();
  assert.equal(f.stored, null);
  assert.equal(countStorage(f, 'forget'), before, 'No saved connection belongs to this opted-out session');
  assert.doesNotMatch(status(f), /暂未清除|未能清除/);
  assert.equal(f.element('retry-connection').hidden, true);
});

const batchPhotos = () => [
  { name: 'morning.jpg', size: 20, type: 'image/jpg' },
  { name: 'mountain.JPG', size: 20, type: 'image/pjpeg' },
  { name: 'sunset.jpg', size: 20, type: '' },
];
const queueStates = f => f.element('photo-queue').children.map(row => previewButton(row).dataset.state);
const receipt = prepared => ({ record: prepared.record, commitSha: 'b'.repeat(40) });

test('multiple file picker accepts JPG MIME aliases and empty MIME metadata into the batch', async () => {
  assert.match(html.match(/<input[^>]*id="photo-library"[^>]*>/)?.[0] || '', /\bmultiple\b/);
  const { f } = await connected();
  await f.selectPhoto(batchPhotos());
  assert.deepEqual(queueStates(f), ['pending', 'pending', 'pending']);
  assert.equal(f.previewCount, 3);
  assert.equal(f.element('photo-error').textContent, '');
  assert.match(f.element('queue-summary').textContent, /共 3 张/);
  assert.equal(f.element('upload-submit').disabled, false);
});

test('cards and receipt show normalized stored names while retaining original file names', async () => {
  const preparedNames = [];
  const { f } = await connected({}, {
    async prepare(file, caption, uploadId, { nameBase }) {
      const fileName = `${nameBase}.jpg`;
      preparedNames.push(fileName);
      return { record: { id: uploadId, originalName: file.name, fileName, displayName: nameBase, caption,
        photoPath: `records/inbox/test/${uploadId}/${fileName}`, uploadedAt: '2026-09-29T12:00:00Z' } };
    },
  });
  await f.selectPhoto(batchPhotos());
  const names = [0, 1, 2].map(index => descendants(f.card(index)).find(node => node.tagName === 'STRONG').textContent);
  assert.equal(new Set(names).size, 3);
  names.forEach((name, index) => {
    assert.match(name, new RegExp(`^新疆旅行_[0-9]{8}_00${index + 1}_[a-f0-9]{8}\\.jpg$`));
    const original = descendants(f.card(index)).find(node => node.className === 'photo-original-name');
    assert.equal(original?.textContent, `原文件：${batchPhotos()[index].name}`);
  });
  assert.equal(f.element('photo-name').textContent, names[0]);
  await f.caption('第一张照片的回忆', 0);
  await f.upload();
  assert.deepEqual(preparedNames, names, 'Saving must keep the selected names stable');
  assert.equal(f.element('receipt-file').textContent, names.join(' · '));
  assert.equal(f.element('receipt-caption').textContent, `${names[0]}\n第一张照片的回忆`);
});

test('every selected photo exposes its own labelled caption field at the same time', async () => {
  const { f } = await connected();
  await f.selectPhoto(batchPhotos());
  assert.doesNotMatch(html, /id="photo-caption"/, 'Individual fields must not depend on the old single-photo caption box');
  const fields = [0, 1, 2].map(index => f.captionField(index));
  assert.equal(new Set(fields.map(field => field.id)).size, 3);
  fields.forEach((field, index) => {
    assert.equal(f.card(index).className, 'photo-card');
    assert.equal(field.hidden, false);
    assert.equal(field.disabled, false);
    assert.match(field.id, /^photo-caption-/);
    const label = descendants(f.card(index)).find(node => node.tagName === 'LABEL' && node.htmlFor === field.id);
    assert.equal(label?.htmlFor, field.id, 'Each visible caption must have an associated label');
  });
});

test('independent captions submit without selecting a preview and preserve focus while typing', async () => {
  const prepared = [], original = client();
  const { f } = await connected({}, {
    async prepare(file, caption) {
      prepared.push([file.name, caption]);
      return original.prepare(file, caption);
    },
  });
  await f.selectPhoto(batchPhotos());
  const rows = [0, 1, 2].map(index => f.card(index));
  const fields = [0, 1, 2].map(index => f.captionField(index));
  fields[1].focus();
  await f.caption('清晨出发', 0);
  await f.caption('沿途的山', 1);
  await f.caption('落日余晖', 2);
  fields.forEach((field, index) => {
    assert.equal(f.captionField(index), field, 'Typing must retain the same textarea node');
    assert.equal(f.card(index), rows[index], 'Typing must not rebuild the card');
  });
  assert.equal(fields[1].focused, true);
  assert.equal(previewButton(f.card(0)).attributes['aria-pressed'], 'true', 'Writing another caption must not require preview selection');
  await f.upload();
  assert.deepEqual(prepared, [
    ['morning.jpg', '清晨出发'], ['mountain.JPG', '沿途的山'], ['sunset.jpg', '落日余晖'],
  ]);
  assert.deepEqual(queueStates(f), ['saved', 'saved', 'saved']);
});

test('removing a middle photo preserves the first and last caption identity', async () => {
  const prepared = [], original = client();
  const { f } = await connected({}, {
    async prepare(file, caption) {
      prepared.push([file.name, caption]);
      return original.prepare(file, caption);
    },
  });
  await f.selectPhoto(batchPhotos());
  await f.caption('第一张说明', 0);
  await f.caption('第二张将删除', 1);
  await f.caption('第三张说明', 2);
  const firstField = f.captionField(0), lastField = f.captionField(2);
  await f.removeItem(1);
  assert.equal(f.element('photo-queue').children.length, 2);
  assert.equal(f.captionField(0), firstField);
  assert.equal(f.captionField(1), lastField);
  assert.equal(f.captionField(0).value, '第一张说明');
  assert.equal(f.captionField(1).value, '第三张说明');
  await f.caption('第三张补充说明', 1);
  await f.upload();
  assert.deepEqual(prepared, [['morning.jpg', '第一张说明'], ['sunset.jpg', '第三张补充说明']]);
});

test('each selected photo keeps its own optional caption and uploads in selection order', async () => {
  const prepared = [], saved = [], original = client();
  const { f } = await connected({}, {
    async prepare(file, caption) {
      prepared.push([file.name, caption]);
      return original.prepare(file, caption);
    },
    async save(item) { saved.push(item.record.originalName); return receipt(item); },
  });
  await f.selectPhoto(batchPhotos());
  await f.caption('早晨出发');
  await f.selectItem(1);
  assert.equal(f.captionField().value, '');
  await f.caption('山路观景台');
  await f.selectItem(2);
  assert.equal(f.captionField().value, '');
  await f.selectItem(0);
  assert.equal(f.captionField().value, '早晨出发');
  await f.selectItem(1);
  assert.equal(f.captionField().value, '山路观景台');
  await f.upload();
  assert.deepEqual(prepared, [
    ['morning.jpg', '早晨出发'], ['mountain.JPG', '山路观景台'], ['sunset.jpg', ''],
  ]);
  assert.deepEqual(saved, ['morning.jpg', 'mountain.JPG', 'sunset.jpg']);
  assert.deepEqual(queueStates(f), ['saved', 'saved', 'saved']);
  assert.equal(f.element('upload-receipt').hidden, false);
  assert.equal(f.element('upload-form').hidden, true);
  assert.equal(f.element('receipt-title').textContent, '3 张照片已保存');
  assert.match(f.element('receipt-file').textContent, /morning\.jpg.*mountain\.JPG.*sunset\.jpg/);
  assert.equal(f.element('receipt-caption').hidden, false);
  assert.equal(f.element('receipt-caption').textContent, 'morning.jpg\n早晨出发\n\nmountain.JPG\n山路观景台', 'A batch receipt must attribute each caption to its own photo');
});

test('only one photo is prepared or saved at a time and progress identifies the current item', async () => {
  const firstSave = deferred(), prepared = [], saved = [], original = client();
  let firstProgress, firstPrepared;
  const { f } = await connected({}, {
    async prepare(file, caption) { prepared.push(file.name); return original.prepare(file, caption); },
    save(item, onProgress) {
      saved.push(item.record.originalName);
      if (saved.length === 1) { firstProgress = onProgress; firstPrepared = item; return firstSave.promise; }
      return Promise.resolve(receipt(item));
    },
  });
  await f.selectPhoto(batchPhotos());
  await f.upload();
  assert.deepEqual(prepared, ['morning.jpg']);
  assert.deepEqual(saved, ['morning.jpg']);
  assert.deepEqual(queueStates(f), ['uploading', 'pending', 'pending']);
  firstProgress({ percent: 50, label: '正在提交原图' });
  assert.equal(f.element('upload-progress-wrap').hidden, false);
  assert.match(f.element('upload-progress-label').textContent, /第 1 \/ 3 张.*正在提交原图/);
  assert.equal(f.element('upload-submit').disabled, true);
  assert.equal(f.captionField().disabled, true);
  assert.equal(f.element('choose-photo').disabled, true);
  firstSave.resolve(receipt(firstPrepared));
  await flush();
  assert.deepEqual(prepared, ['morning.jpg', 'mountain.JPG', 'sunset.jpg']);
  assert.deepEqual(saved, prepared);
  assert.equal(f.element('upload-progress-wrap').hidden, true);
  assert.equal(f.element('upload-receipt').hidden, false);
});

test('an invalid image is marked in the batch while remaining photos still save', async () => {
  const saved = [], original = client();
  const { f } = await connected({}, {
    async prepare(file, caption) {
      if (file.name === 'mountain.JPG') throw new PhotoError('照片内容不是有效图片', 400, 'INVALID');
      return original.prepare(file, caption);
    },
    async save(item) { saved.push(item.record.originalName); return receipt(item); },
  });
  await f.selectPhoto(batchPhotos());
  await f.upload();
  assert.deepEqual(saved, ['morning.jpg', 'sunset.jpg']);
  assert.deepEqual(queueStates(f), ['saved', 'invalid', 'saved']);
  assert.match(f.element('queue-summary').textContent, /已保存 2 张.*未通过 1 张/);
  assert.equal(f.element('upload-receipt').hidden, true, 'The UI must not claim every photo was saved');
  await f.selectItem(1);
  assert.equal(f.removeButton(1).disabled, false);
  await f.removeItem(1);
  assert.deepEqual(queueStates(f), ['saved', 'saved']);
  assert.equal(f.element('receipt-title').textContent, '2 张照片已保存');
  assert.equal(f.element('upload-receipt').hidden, false);
});

test('an empty selection entry does not block the other selected photos', async () => {
  const { f } = await connected();
  await f.selectPhoto([{ name: 'empty.jpg', size: 0, type: 'image/jpeg' }, ...batchPhotos()]);
  assert.deepEqual(queueStates(f), ['pending', 'pending', 'pending']);
  assert.match(f.element('photo-error').textContent, /empty\.jpg/);
  await f.upload();
  assert.deepEqual(queueStates(f), ['saved', 'saved', 'saved']);
  assert.equal(f.element('upload-receipt').hidden, false);
});

test('retry after the second photo loses network skips saved photos and preserves the unresolved upload', async () => {
  const prepared = [], saved = [], lookups = [], original = client();
  let failed = false, unresolved;
  const { f } = await connected({}, {
    async prepare(file, caption) { prepared.push(file.name); return original.prepare(file, caption); },
    async save(item) {
      saved.push(item.record.originalName);
      if (item.record.originalName === 'mountain.JPG' && !failed) {
        failed = true; unresolved = item;
        throw new PhotoError('offline', 0, 'NETWORK');
      }
      if (item.record.originalName === 'mountain.JPG') assert.equal(item, unresolved, 'Retry must reuse the prepared photo and UUID');
      return receipt(item);
    },
    async lookup(item) { lookups.push(item); return null; },
  });
  await f.selectPhoto(batchPhotos());
  await f.upload();
  assert.deepEqual(queueStates(f), ['saved', 'uncertain', 'pending']);
  assert.deepEqual(saved, ['morning.jpg', 'mountain.JPG']);
  assert.deepEqual(prepared, ['morning.jpg', 'mountain.JPG']);
  assert.equal(f.element('choose-photo').disabled, true);
  assert.equal(f.element('upload-submit').disabled, false);
  assert.match(f.element('upload-submit').textContent, /核对/);
  await f.upload();
  assert.deepEqual(saved, ['morning.jpg', 'mountain.JPG', 'mountain.JPG', 'sunset.jpg']);
  assert.deepEqual(prepared, ['morning.jpg', 'mountain.JPG', 'sunset.jpg']);
  assert.deepEqual(lookups, [unresolved, unresolved]);
  assert.deepEqual(queueStates(f), ['saved', 'saved', 'saved']);
  assert.equal(f.element('upload-receipt').hidden, false);
});

test('prepared captions stay locked during retry while later unprepared photos remain editable', async () => {
  const original = client(), prepared = [], saved = [];
  let interrupted = false, unresolved;
  const { f } = await connected({}, {
    async prepare(file, caption) {
      prepared.push([file.name, caption]);
      return original.prepare(file, caption);
    },
    async save(item) {
      if (item.record.originalName === 'mountain.JPG' && !interrupted) {
        interrupted = true; unresolved = item;
        throw new PhotoError('offline', 0, 'NETWORK');
      }
      if (item.record.originalName === 'mountain.JPG') assert.equal(item, unresolved);
      saved.push([item.record.originalName, item.record.caption]);
      return receipt(item);
    },
  });
  await f.selectPhoto(batchPhotos());
  await f.caption('已保存的说明', 0);
  await f.caption('待核对的原说明', 1);
  await f.caption('未开始的说明', 2);
  await f.upload();
  assert.deepEqual(queueStates(f), ['saved', 'uncertain', 'pending']);
  assert.equal(f.captionField(0).disabled, true);
  assert.equal(f.captionField(1).disabled, true);
  assert.equal(f.captionField(2).disabled, false);
  assert.equal(f.removeButton(0).disabled, true);
  assert.equal(f.removeButton(1).disabled, true);
  await f.caption('已保存照片不能改成此说明', 0);
  await f.caption('待核对照片不能改成此说明', 1);
  await f.caption('继续前补充的说明', 2);
  await f.upload();
  assert.deepEqual(prepared, [
    ['morning.jpg', '已保存的说明'], ['mountain.JPG', '待核对的原说明'], ['sunset.jpg', '继续前补充的说明'],
  ]);
  assert.deepEqual(saved, prepared);
  assert.deepEqual(queueStates(f), ['saved', 'saved', 'saved']);
});

for (const [code, httpStatus] of [['PERMISSION', 403], ['ACCOUNT', 409]]) {
  test(`${code} during batch upload exposes reconnect controls and retains successful and unresolved photos`, async () => {
    const original = client(), saved = [], preparedAfterReconnect = [], lookedUp = [];
    let unresolved;
    const { f, connection } = await connected({ stored: TEST_TOKEN }, {
      async save(item) {
        saved.push(item.record.originalName);
        if (item.record.originalName === 'mountain.JPG') {
          unresolved = item;
          throw new PhotoError('Reconnect required', httpStatus, code);
        }
        return receipt(item);
      },
    });
    await f.selectPhoto(batchPhotos());
    await f.selectItem(1);
    await f.caption('第二张说明应在重连后保留');
    await f.upload();
    assert.equal(connection.disconnected, 1);
    assert.equal(f.element('connect-form').hidden, false);
    assert.equal(f.element('connected-user').hidden, true);
    assert.equal(f.element('github-token').disabled, false);
    assert.equal(f.element('connect-button').disabled, false);
    assert.equal(f.element('upload-submit').disabled, true);
    assert.equal(f.element('upload-form').attributes['aria-busy'], 'false');
    assert.equal(f.element('upload-progress-wrap').hidden, true);
    assert.deepEqual(queueStates(f), ['saved', 'uncertain', 'pending']);
    assert.equal(f.element('upload-receipt').hidden, true);
    assert.equal(f.stored, TEST_TOKEN, 'A permission failure must not erase an otherwise valid saved credential');

    await f.submit();
    assert.equal(f.connections.length, 2);
    f.connections[1].resolve(client({
      async prepare(file, caption) {
        preparedAfterReconnect.push(file.name);
        return original.prepare(file, caption);
      },
      async lookup(item) { lookedUp.push(item); return null; },
      async save(item) {
        saved.push(item.record.originalName);
        if (item.record.originalName === 'mountain.JPG') {
          assert.equal(item, unresolved, 'Reconnection must retain the original prepared upload and UUID');
          assert.equal(item.record.caption, '第二张说明应在重连后保留');
        }
        return receipt(item);
      },
    }));
    await flush();
    assert.equal(f.element('connect-form').hidden, true);
    assert.equal(f.element('upload-submit').disabled, false);
    await f.upload();
    assert.deepEqual(lookedUp, [unresolved]);
    assert.deepEqual(preparedAfterReconnect, ['sunset.jpg']);
    assert.deepEqual(saved, ['morning.jpg', 'mountain.JPG', 'mountain.JPG', 'sunset.jpg']);
    assert.deepEqual(queueStates(f), ['saved', 'saved', 'saved']);
    assert.equal(f.element('receipt-title').textContent, '3 张照片已保存');
    assert.equal(f.element('upload-receipt').hidden, false);
  });
}

test('a late preparation cannot overwrite a new active batch after a pagehide and reconnect', async () => {
  const oldPrepare = deferred(), newPrepare = deferred(), original = client();
  let oldSaves = 0, newSaves = 0;
  const { f } = await connected({ stored: TEST_TOKEN }, {
    prepare: () => oldPrepare.promise,
    async save() { oldSaves++; throw new Error('Stale preparation must not save'); },
  });
  await f.selectPhoto(batchPhotos().slice(0, 1));
  await f.caption('保留这张说明');
  await f.upload();
  await f.event('pagehide');
  await f.event('pageshow', { persisted: true });
  f.connections[1].resolve(client({
    prepare: () => newPrepare.promise,
    async save(item) { newSaves++; return receipt(item); },
  }));
  await flush();
  await f.upload();
  oldPrepare.resolve(await original.prepare(batchPhotos()[0], '旧回调不应覆盖'));
  await flush();
  assert.equal(oldSaves, 0);
  assert.equal(newSaves, 0);
  assert.equal(f.element('upload-form').attributes['aria-busy'], 'true');
  assert.deepEqual(queueStates(f), ['preparing']);
  newPrepare.resolve(await original.prepare(batchPhotos()[0], '保留这张说明'));
  await flush();
  assert.equal(newSaves, 1);
  assert.equal(f.element('receipt-caption').textContent, 'morning.jpg\n保留这张说明');
  assert.equal(f.element('upload-receipt').hidden, false);
});

test('late save completion and progress cannot alter a new reconciliation after pagehide', async () => {
  const oldSave = deferred(), newLookup = deferred();
  let oldPrepared, oldProgress, newSaves = 0;
  const { f } = await connected({ stored: TEST_TOKEN }, {
    save(item, progress) { oldPrepared = item; oldProgress = progress; return oldSave.promise; },
  });
  await f.selectPhoto(batchPhotos().slice(0, 1));
  await f.upload();
  await f.event('pagehide');
  await f.event('pageshow', { persisted: true });
  f.connections[1].resolve(client({
    lookup: () => newLookup.promise,
    async save(item) { newSaves++; return receipt(item); },
  }));
  await flush();
  await f.upload();
  const previous = status(f), progressLabel = f.element('upload-progress-label').textContent;
  oldProgress({ percent: 100, label: '旧连接已保存' });
  oldSave.resolve(receipt(oldPrepared));
  await flush();
  assert.equal(status(f), previous);
  assert.equal(f.element('upload-progress-label').textContent, progressLabel);
  assert.equal(f.element('upload-form').attributes['aria-busy'], 'true');
  assert.equal(f.element('upload-receipt').hidden, true);
  newLookup.resolve(receipt(oldPrepared));
  await flush();
  assert.equal(newSaves, 0, 'A confirmed existing receipt avoids saving the same photo again');
  assert.deepEqual(queueStates(f), ['saved']);
  assert.equal(f.element('upload-receipt').hidden, false);
});

const bulkSelections = f => f.element('photo-queue').children.map((_, index) => f.selectCheckbox(index).checked);

test('bulk captions apply only to the chosen subset and each caption remains independently editable', async () => {
  const prepared = [], original = client();
  const { f } = await connected({}, {
    async prepare(file, caption) {
      prepared.push([file.name, caption]);
      return original.prepare(file, caption);
    },
  });
  await f.selectPhoto(batchPhotos());
  await f.caption('第一张旧说明', 0);
  await f.caption('第二张保留说明', 1);
  await f.caption('第三张旧说明', 2);
  const fields = [0, 1, 2].map(index => f.captionField(index));
  assert.deepEqual(bulkSelections(f), [false, false, false], 'Adding photos must not implicitly select them for replacement');
  assert.equal(f.element('bulk-apply').disabled, true);
  await f.toggleBulkPhoto(0);
  await f.toggleBulkPhoto(2);
  await f.bulkCaption('这两张都在赛里木湖拍摄');
  assert.equal(f.element('bulk-apply').disabled, false);
  await f.click('bulk-apply');
  assert.deepEqual(fields.map(field => field.value), ['这两张都在赛里木湖拍摄', '第二张保留说明', '这两张都在赛里木湖拍摄']);
  fields.forEach((field, index) => assert.equal(f.captionField(index), field, 'Applying a shared caption must preserve the existing per-photo editor'));
  await f.caption('赛里木湖日落，单独补充', 2);
  await f.upload();
  assert.deepEqual(prepared, [
    ['morning.jpg', '这两张都在赛里木湖拍摄'],
    ['mountain.JPG', '第二张保留说明'],
    ['sunset.jpg', '赛里木湖日落，单独补充'],
  ]);
});

test('bulk select-all reflects partial selection and supports clearing the selection', async () => {
  const { f } = await connected();
  await f.selectPhoto(batchPhotos());
  const all = f.element('bulk-select-all');
  assert.equal(all.checked, false);
  assert.equal(all.indeterminate, false);
  await f.toggleBulkPhoto(1);
  assert.equal(all.checked, false);
  assert.equal(all.indeterminate, true);
  await f.selectAll();
  assert.deepEqual(bulkSelections(f), [true, true, true]);
  assert.equal(all.checked, true);
  assert.equal(all.indeterminate, false);
  await f.toggleBulkPhoto(0, false);
  assert.equal(all.checked, false);
  assert.equal(all.indeterminate, true);
  await f.selectAll(false);
  assert.deepEqual(bulkSelections(f), [false, false, false]);
  assert.equal(all.checked, false);
  assert.equal(all.indeterminate, false);
  assert.equal(f.element('bulk-apply').disabled, true);
});

test('a shared caption with no selected photos cannot change any caption, even via a dispatched click', async () => {
  const { f } = await connected();
  await f.selectPhoto(batchPhotos());
  await f.caption('保留第一张', 0);
  await f.bulkCaption('没有选照片不能应用');
  assert.equal(f.element('bulk-apply').disabled, true);
  await f.applyRaw();
  assert.deepEqual([0, 1, 2].map(index => f.captionField(index).value), ['保留第一张', '', '']);
  assert.deepEqual(bulkSelections(f), [false, false, false]);
});

test('bulk selection remains attached to photo identities after a middle removal and an appended photo', async () => {
  const prepared = [], original = client();
  const { f } = await connected({}, {
    async prepare(file, caption) {
      prepared.push([file.name, caption]);
      return original.prepare(file, caption);
    },
  });
  await f.selectPhoto(batchPhotos());
  await f.caption('清晨原说明', 0);
  await f.toggleBulkPhoto(1);
  await f.toggleBulkPhoto(2);
  const retainedCheckbox = f.selectCheckbox(2);
  await f.removeItem(1);
  assert.equal(f.selectCheckbox(1), retainedCheckbox);
  assert.deepEqual(bulkSelections(f), [false, true]);
  await f.selectPhoto([{ name: 'new.jpg', size: 20, type: 'image/jpeg' }]);
  assert.deepEqual(bulkSelections(f), [false, true, false], 'Appending a photo must not inherit a removed photo selection or existing select-all state');
  await f.bulkCaption('仅原来的日落照片');
  await f.click('bulk-apply');
  await f.upload();
  assert.deepEqual(prepared, [['morning.jpg', '清晨原说明'], ['sunset.jpg', '仅原来的日落照片'], ['new.jpg', '']]);
});

test('bulk select-all excludes saved and prepared uncertain photos while allowing remaining captions', async () => {
  const prepared = [], saved = [], original = client();
  let interrupted = false;
  const { f } = await connected({}, {
    async prepare(file, caption) {
      prepared.push([file.name, caption]);
      return original.prepare(file, caption);
    },
    async save(item) {
      if (item.record.originalName === 'mountain.JPG' && !interrupted) {
        interrupted = true;
        throw new PhotoError('offline', 0, 'NETWORK');
      }
      saved.push([item.record.originalName, item.record.caption]);
      return receipt(item);
    },
  });
  await f.selectPhoto(batchPhotos());
  await f.caption('已保存原说明', 0);
  await f.caption('待核对原说明', 1);
  await f.caption('尚未上传原说明', 2);
  await f.selectAll();
  await f.upload();
  assert.deepEqual(queueStates(f), ['saved', 'uncertain', 'pending']);
  assert.deepEqual(bulkSelections(f), [false, false, true], 'Preparing a photo must remove it from future bulk caption changes');
  assert.equal(f.selectCheckbox(0).disabled, true);
  assert.equal(f.selectCheckbox(1).disabled, true);
  assert.equal(f.selectCheckbox(2).disabled, false);
  await f.selectAll(false);
  await f.selectAll();
  assert.deepEqual(bulkSelections(f), [false, false, true]);
  await f.bulkCaption('待上传照片的补充');
  await f.click('bulk-apply');
  assert.deepEqual([0, 1, 2].map(index => f.captionField(index).value), ['已保存原说明', '待核对原说明', '待上传照片的补充']);
  await f.upload();
  assert.deepEqual(prepared, [['morning.jpg', '已保存原说明'], ['mountain.JPG', '待核对原说明'], ['sunset.jpg', '待上传照片的补充']]);
  assert.deepEqual(saved, prepared);
});

test('bulk caption controls and handlers cannot edit queued photos during an active upload', async () => {
  const saving = deferred(), prepared = [], original = client();
  let firstPrepared;
  const { f } = await connected({}, {
    async prepare(file, caption) {
      prepared.push([file.name, caption]);
      return original.prepare(file, caption);
    },
    async save(item) {
      if (!firstPrepared) { firstPrepared = item; return saving.promise; }
      return receipt(item);
    },
  });
  await f.selectPhoto(batchPhotos());
  await f.caption('上传前说明', 2);
  await f.selectAll();
  await f.bulkCaption('上传途中不得替换');
  await f.upload();
  assert.equal(f.element('bulk-apply').disabled, true);
  assert.equal(f.element('bulk-caption').disabled, true);
  assert.equal(f.element('bulk-select-all').disabled, true);
  assert.equal(f.selectCheckbox(2).disabled, true);
  await f.applyRaw();
  saving.resolve(receipt(firstPrepared));
  await flush();
  assert.deepEqual(prepared, [['morning.jpg', ''], ['mountain.JPG', ''], ['sunset.jpg', '上传前说明']]);
});

test('bulk caption application stays guarded without a connection, during reconnect and during device deletion', async () => {
  const deletion = deferred();
  const { f } = await connected({ stored: TEST_TOKEN, forget: () => deletion.promise });
  await f.selectPhoto(batchPhotos());
  await f.caption('连接操作期间保留', 2);
  await f.selectAll();
  await f.bulkCaption('连接操作期间不得应用');
  await f.event('pagehide');
  assert.equal(f.element('bulk-apply').disabled, true);
  await f.applyRaw();
  assert.equal(f.captionField(2).value, '连接操作期间保留');
  await f.event('pageshow', { persisted: true });
  assert.equal(f.connections.length, 2);
  assert.equal(f.element('bulk-apply').disabled, true);
  await f.applyRaw();
  assert.equal(f.captionField(2).value, '连接操作期间保留');
  f.connections[1].resolve(client());
  await flush();
  assert.equal(f.element('bulk-apply').disabled, false);
  await f.click('forget-device');
  assert.equal(f.element('bulk-apply').disabled, true);
  await f.applyRaw();
  assert.equal(f.captionField(2).value, '连接操作期间保留');
  deletion.resolve();
  await flush();
});

test('bulk caption validation rejects blank and overlong values but preserves an accepted 4000-character caption verbatim', async () => {
  const prepared = [], original = client();
  const { f } = await connected({}, {
    async prepare(file, caption) {
      prepared.push([file.name, caption]);
      return original.prepare(file, caption);
    },
  });
  assert.match(html.match(/<textarea[^>]*id="bulk-caption"[^>]*>/)?.[0] || '', /maxlength="4000"/);
  await f.selectPhoto(batchPhotos().slice(0, 1));
  await f.caption('原说明');
  await f.selectAll();
  for (const value of ['', ' \n\t ', '长'.repeat(4001)]) {
    await f.bulkCaption(value);
    assert.equal(f.element('bulk-apply').disabled, true);
    await f.applyRaw();
    assert.equal(f.captionField().value, '原说明', 'Disabled-button guards must prevent programmatic validation bypass');
  }
  const accepted = ` ${'湖'.repeat(3998)} `;
  await f.bulkCaption(accepted);
  assert.equal(f.element('bulk-apply').disabled, false);
  assert.match(f.element('bulk-caption-counter').textContent, /4,?000/);
  await f.click('bulk-apply');
  assert.equal(f.captionField().value, accepted, 'Meaningful spaces must not be stripped when copying the shared caption');
  await f.upload();
  assert.deepEqual(prepared, [['morning.jpg', accepted]]);
});

const durablePhotos = () => ['morning.jpg', 'lake.jpg'].map(name => new File(
  [new Uint8Array([0xff, 0xd8, 0xff, 0xdb])], name,
  { type: 'image/jpeg', lastModified: 1790000000000 },
));

function durableClient(overrides = {}) {
  return client({
    async prepare(file, caption, uploadId, { nameBase }) {
      const fileName = `${nameBase}.jpg`;
      return { record: { id: uploadId, originalName: file.name, fileName, displayName: nameBase,
        caption, photoPath: `records/inbox/github-123/${uploadId}/${fileName}`,
        uploadedAt: '2026-10-09T04:00:00Z' } };
    },
    ...overrides,
  });
}

test('selected drafts never enter persistent upload storage or start automatically on visibility and network events', async () => {
  let saves = 0;
  const { f } = await connected({ pendingSupported: true }, durableClient({
    async save() { saves++; throw new Error('Drafts are not authorized uploads'); },
  }));
  await f.selectPhoto(durablePhotos());
  await f.caption('未点击保存的草稿');
  await f.visibility('hidden');
  await f.visibility('visible');
  await f.event('online');
  assert.equal(saves, 0);
  assert.equal(f.pendingCalls.filter(call => call.method === 'save').length, 0);
  assert.deepEqual(queueStates(f), ['pending', 'pending']);
});

test('first upload waits for durable local storage before any remote photo work', async () => {
  const persisted = deferred();
  let preparations = 0;
  const real = durableClient();
  const { f } = await connected({ pendingSupported: true, savePending: () => persisted.promise }, {
    ...real,
    async prepare(...args) { preparations++; return real.prepare(...args); },
  });
  await f.selectPhoto(durablePhotos());
  await f.upload();
  assert.equal(f.pendingCalls.filter(call => call.method === 'save').length, 1);
  assert.equal(preparations, 0, 'A selected file must not reach GitHub until its recoverable queue is saved');
  persisted.resolve();
  await flush();
  await flush();
  assert.equal(preparations, 2);
  assert.deepEqual(queueStates(f), ['saved', 'saved']);
});

test('quota failure does not silently start a nonrecoverable upload', async () => {
  let preparations = 0;
  const real = durableClient();
  const { f } = await connected({ pendingSupported: true, savePending: async () => {
    const error = new Error('private disk details'); error.name = 'PendingStorageError'; error.code = 'QUOTA'; throw error;
  } }, { ...real, async prepare(...args) { preparations++; return real.prepare(...args); } });
  await f.selectPhoto(durablePhotos());
  await f.upload();
  assert.equal(preparations, 0);
  assert.equal(f.element('upload-current-page').hidden, false);
  assert.match(f.element('pending-storage-status').textContent, /未|无法|不足|失败/);
  assert.ok(!f.element('pending-storage-status').textContent.includes('private disk details'));
  await f.click('upload-current-page');
  await flush();
  assert.equal(preparations, 2, 'The user can explicitly choose current-page-only upload after storage fails');
});

test('switching tabs leaves an active upload connected and able to finish its remaining photos', async () => {
  const firstSave = deferred();
  let saves = 0, firstPrepared;
  const { f, connection } = await connected({ pendingSupported: true }, durableClient({
    async save(prepared) {
      saves++;
      if (saves === 1) { firstPrepared = prepared; return firstSave.promise; }
      return { record: prepared.record, commitSha: 'a'.repeat(40) };
    },
  }));
  await f.selectPhoto(durablePhotos());
  await f.upload();
  await flush();
  assert.equal(saves, 1);
  await f.visibility('hidden');
  assert.equal(connection.disconnected, 0);
  firstSave.resolve({ record: firstPrepared.record, commitSha: 'a'.repeat(40) });
  await flush();
  await flush();
  assert.equal(saves, 2);
  assert.deepEqual(queueStates(f), ['saved', 'saved']);
});

async function interruptedBatch() {
  const queue = new PhotoQueue();
  queue.add(durablePhotos());
  let saves = 0;
  await queue.run(durableClient({
    async save(prepared) {
      if (++saves === 1) return { record: prepared.record, commitSha: 'a'.repeat(40) };
      throw new PhotoError('Network interrupted', 0, 'NETWORK');
    },
  }));
  assert.deepEqual(queue.items.map(item => item.status), ['saved', 'uncertain']);
  return { version: 1, id: crypto.randomUUID(), owner: { id: 123, login: 'TestTraveller' },
    createdAt: '2026-10-09T04:00:00Z', backgroundRevision: 'revision-0', items: queue.snapshot() };
}

test('a restored started batch skips saved photos and reconciles an uncertain photo under its original upload ID', async () => {
  const pendingBatch = await interruptedBatch();
  const preparedIds = [], lookedUp = [];
  let saves = 0;
  const real = durableClient();
  const f = fixture({ pendingSupported: true, pendingBatch, stored: TEST_TOKEN });
  await flush();
  assert.equal(f.connections.length, 1);
  f.connections[0].resolve(durableClient({
    async prepare(...args) { preparedIds.push(args[2]); return real.prepare(...args); },
    async lookup(prepared) {
      lookedUp.push(prepared.record.id);
      return { record: prepared.record, commitSha: 'b'.repeat(40) };
    },
    async save() { saves++; throw new Error('Reconciled photos must not be uploaded twice'); },
  }));
  await flush();
  await flush();
  assert.deepEqual(preparedIds, [pendingBatch.items[1].uploadId]);
  assert.deepEqual(lookedUp, [pendingBatch.items[1].uploadId]);
  assert.equal(saves, 0);
  assert.deepEqual(queueStates(f), ['saved', 'saved']);
});

test('forgetting the device prevents an existing persistent batch from being resumed by lifecycle events', async () => {
  const pendingBatch = await interruptedBatch();
  const f = fixture({ pendingSupported: true, pendingBatch, stored: TEST_TOKEN });
  await flush();
  assert.equal(f.connections.length, 1);
  await f.forgetFromOtherTab();
  const staleConnection = durableClient();
  f.connections[0].resolve(staleConnection);
  await flush();
  await f.visibility('visible');
  await f.event('online');
  await f.event('pageshow', { persisted: true });
  assert.equal(staleConnection.disconnected, 1);
  assert.equal(f.connections.length, 1);
  assert.equal(f.pendingCalls.filter(call => call.method === 'save').length, 0);
  assert.equal(f.element('choose-photo').disabled, true);
});

test('a busy upload lock prevents duplicate remote work and explains that another uploader owns the batch', async () => {
  let preparations = 0;
  const { f } = await connected({ pendingSupported: true, withUploadLock: async () => ({ acquired: false }) }, durableClient({
    async prepare() { preparations++; throw new Error('Lock was not acquired'); },
  }));
  await f.selectPhoto(durablePhotos());
  await f.upload();
  assert.equal(preparations, 0);
  assert.equal(f.pendingCalls.filter(call => call.method === 'save').length, 0);
  assert.match(f.element('upload-status').textContent, /后台|另一个页面/);
  assert.equal(f.element('upload-form').attributes['aria-busy'], 'false');
});

test('wake lock refusal never claims the screen is awake and never blocks photo uploading', async () => {
  let requests = 0;
  const { f } = await connected({ pendingSupported: true, navigator: { wakeLock: {
    async request(kind) { assert.equal(kind, 'screen'); requests++; throw new Error('Device refused'); },
  } } }, durableClient());
  assert.equal(f.element('keep-screen-awake').checked, true);
  await f.selectPhoto(durablePhotos());
  await f.upload();
  await flush();
  assert.equal(requests, 1);
  assert.doesNotMatch(f.element('background-status').textContent, /屏幕保持唤醒中/);
  assert.deepEqual(queueStates(f), ['saved', 'saved']);
});

test('unchecking screen wake releases its lock and immediately stops claiming that the screen remains awake', async () => {
  const save = deferred(), released = [];
  const releaseListeners = [];
  const { f } = await connected({ pendingSupported: true, navigator: { wakeLock: {
    async request() {
      return {
        addEventListener(name, listener) { assert.equal(name, 'release'); releaseListeners.push(listener); },
        async release() { released.push(true); for (const listener of releaseListeners) listener(); },
      };
    },
  } } }, durableClient({ save: () => save.promise }));
  await f.selectPhoto(durablePhotos());
  await f.upload();
  assert.match(f.element('background-status').textContent, /屏幕保持唤醒中/);
  f.element('keep-screen-awake').checked = false;
  f.element('keep-screen-awake').emit('change');
  await flush();
  assert.equal(released.length, 1);
  assert.doesNotMatch(f.element('background-status').textContent, /屏幕保持唤醒中/);
});

test('a browser with service workers but without background sync only promises restoration after returning', async () => {
  const { f } = await connected({ pendingSupported: true, navigator: { serviceWorker: {
    async register() { return { active: { postMessage() {} } }; },
    addEventListener() {},
  } } });
  assert.doesNotMatch(f.element('background-status').textContent, /支持后台同步/);
  assert.match(f.element('background-status').textContent, /切回|返回/);
  assert.match(f.element('background-status').textContent, /可能暂停/);
});

test('current-page fallback waits for removal of a partially persisted batch before any remote save', async () => {
  const removed = deferred();
  let checkpoints = 0, saves = 0;
  const { f } = await connected({ pendingSupported: true,
    async savePending() {
      if (++checkpoints > 1) { const error = new Error('Disk full'); error.name = 'PendingStorageError'; throw error; }
    },
    clearPending: () => removed.promise,
  }, durableClient({ async save(prepared) { saves++; return receipt(prepared); } }));
  await f.selectPhoto(durablePhotos());
  await f.upload();
  assert.equal(f.element('upload-current-page').hidden, false);
  assert.ok(f.pendingBatch);
  assert.equal(saves, 0);
  await f.click('upload-current-page');
  assert.equal(f.pendingCalls.filter(call => call.method === 'clear').length, 1);
  assert.equal(saves, 0, 'Persisted tasks must be disabled before page-only execution can proceed');
  removed.resolve();
  await flush();
  await flush();
  assert.equal(saves, 2);
  assert.equal(f.pendingBatch, null);
});

test('current-page fallback must not bypass a background worker that still owns the upload lock', async () => {
  let locks = 0, saves = 0, checkpoints = 0;
  const { f } = await connected({ pendingSupported: true,
    async withUploadLock(operation) {
      if (++locks > 1) return { acquired: false };
      return { acquired: true, value: await operation() };
    },
    async savePending() {
      if (++checkpoints > 1) { const error = new Error('Disk full'); error.name = 'PendingStorageError'; throw error; }
    },
  }, durableClient({ async save(prepared) { saves++; return receipt(prepared); } }));
  await f.selectPhoto(durablePhotos());
  await f.upload();
  await f.click('upload-current-page');
  assert.equal(saves, 0);
  assert.equal(f.pendingCalls.filter(call => call.method === 'clear').length, 0);
  assert.ok(f.pendingBatch);
  assert.match(f.element('pending-storage-status').textContent, /后台|稍后/);
});

test('invalid photos in a persisted batch can be removed so the completed batch releases storage and accepts a new selection', async () => {
  const real = durableClient();
  const { f } = await connected({ pendingSupported: true }, durableClient({
    async prepare(file, ...args) {
      if (file.name === 'morning.jpg') throw new PhotoError('Invalid image', 415, 'INVALID');
      return real.prepare(file, ...args);
    },
  }));
  await f.selectPhoto(durablePhotos());
  await f.upload();
  await flush();
  assert.deepEqual(queueStates(f), ['invalid', 'saved']);
  assert.ok(f.pendingBatch);
  await f.removeItem(0);
  await flush();
  await flush();
  assert.deepEqual(queueStates(f), ['saved']);
  assert.equal(f.pendingBatch, null);
  assert.equal(f.element('upload-receipt').hidden, false);
  await f.click('upload-next');
  await f.selectPhoto(durablePhotos().slice(0, 1));
  assert.deepEqual(queueStates(f), ['pending']);
});

test('network recovery resumes the previously started batch automatically using its stable upload ID', async () => {
  const real = durableClient(), preparedIds = [], savedIds = [];
  const { f } = await connected({ pendingSupported: true }, durableClient({
    async prepare(...args) { preparedIds.push(args[2]); return real.prepare(...args); },
    async save(prepared) {
      savedIds.push(prepared.record.id);
      if (savedIds.length === 1) throw new PhotoError('Offline', 0, 'NETWORK');
      return receipt(prepared);
    },
  }));
  await f.selectPhoto(durablePhotos().slice(0, 1));
  await f.upload();
  await flush();
  assert.deepEqual(queueStates(f), ['uncertain']);
  assert.equal(savedIds.length, 1);
  await f.event('online');
  await flush();
  assert.deepEqual(queueStates(f), ['saved']);
  assert.equal(savedIds.length, 2);
  assert.equal(savedIds[0], savedIds[1]);
  assert.deepEqual(preparedIds, savedIds);
});

test('retrying the regular upload button after the first local save fails preserves the original batch and photo IDs', async () => {
  const preparedIds = [], real = durableClient();
  let storageAttempts = 0;
  const { f } = await connected({ pendingSupported: true,
    async savePending() {
      if (++storageAttempts === 1) {
        const error = new Error('Disk full'); error.name = 'PendingStorageError'; throw error;
      }
    },
  }, durableClient({
    async prepare(...args) { preparedIds.push(args[2]); return real.prepare(...args); },
  }));
  await f.selectPhoto(durablePhotos());
  await f.upload();
  assert.equal(preparedIds.length, 0);
  assert.equal(f.pendingBatch, null, 'The failed initial write must not masquerade as a saved batch');
  const attemptedBatch = f.pendingCalls.find(call => call.method === 'save').batch;
  assert.equal(f.element('upload-submit').disabled, false);
  await f.upload();
  await flush();
  const persisted = f.pendingCalls.filter(call => call.method === 'save');
  assert.equal(persisted[1].batch.id, attemptedBatch.id);
  assert.deepEqual(preparedIds, attemptedBatch.items.map(item => item.uploadId));
  assert.deepEqual(queueStates(f), ['saved', 'saved']);
  assert.equal(f.element('upload-receipt').hidden, false);
  assert.doesNotMatch(f.element('upload-status').textContent, /上次任务已处理/);
});

test('completed batch cleanup holds the original upload lock and never relies on acquiring a second lock', async () => {
  let lockHeld = false, lockAttempts = 0, clears = 0;
  const { f } = await connected({ pendingSupported: true,
    async withUploadLock(operation) {
      if (++lockAttempts > 1) return { acquired: false };
      lockHeld = true;
      try { return { acquired: true, value: await operation() }; }
      finally { lockHeld = false; }
    },
    async clearPending() {
      assert.equal(lockHeld, true, 'A completed batch must be removed before handing its lock to a background worker');
      clears++;
    },
  }, durableClient());
  await f.selectPhoto(durablePhotos());
  await f.upload();
  await flush();
  assert.equal(lockAttempts, 1);
  assert.equal(clears, 1);
  assert.equal(f.pendingBatch, null);
  assert.deepEqual(queueStates(f), ['saved', 'saved']);
  await f.click('upload-next');
  assert.equal(f.element('choose-photo').disabled, false);
  await f.selectPhoto(durablePhotos().slice(0, 1));
  assert.deepEqual(queueStates(f), ['pending']);
});
