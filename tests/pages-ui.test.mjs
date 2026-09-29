import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

// Only the UI source and its HTML are read. Imports are removed before execution;
// credentials, device storage, GitHub and browser APIs are all independent stubs.
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
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

class PhotoError extends Error {
  constructor(message, status = 0, code = 'NETWORK') {
    super(message); this.status = status; this.code = code;
  }
}

class Element {
  constructor(id, tag) {
    this.id = id;
    this.hidden = /\bhidden\b/.test(tag);
    this.disabled = /\bdisabled\b/.test(tag);
    this.checked = /\bchecked\b/.test(tag);
    this.value = '';
    this.textContent = '';
    this.dataset = {};
    this.attributes = {};
    this.files = [];
    this.listeners = new Map();
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
  focus() { this.focused = true; }
  click() { if (!this.disabled) this.emit('click'); }
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
  const events = new Map(), connections = [], probes = [], storageCalls = [], forgottenListeners = [];
  let stored = options.stored ?? null, revision = 'revision-0', revisions = 0, previewCount = 0;
  const window = {
    addEventListener(name, listener) {
      const listeners = events.get(name) || [];
      listeners.push(listener); events.set(name, listeners);
    },
  };
  const context = vm.createContext({
    document: { getElementById: element }, window, PhotoError,
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
      createObjectURL() { previewCount++; return 'blob:test-photo'; },
      revokeObjectURL() {},
    },
    Date, Intl, setTimeout, clearTimeout,
  });
  vm.runInContext(source, context, { filename: 'upload/app.mjs' });
  return {
    element, connections, probes, storageCalls,
    get stored() { return stored; },
    get revision() { return revision; },
    get previewCount() { return previewCount; },
    async event(name, detail = {}) {
      for (const listener of events.get(name) || []) listener(detail);
      await flush();
    },
    async submit(token = TEST_TOKEN, remember = true) {
      element('github-token').value = token;
      element('remember-device').checked = remember;
      element('connect-form').emit('submit');
      await flush();
    },
    async click(id) { element(id).click(); await flush(); },
    async selectPhoto() {
      element('photo-library').files = [{ name: 'test.jpg', size: 20, type: 'image/jpeg' }];
      element('photo-library').emit('change');
      await flush();
    },
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
      return { record: { id: 'test-upload', originalName: file.name, caption,
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

test('late preparation result after pagehide cannot revive an upload', async () => {
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
  preparation.resolve({ record: { id: 'obsolete' } });
  await flush();
  assert.equal(saves, 0);
  assert.equal(f.element('upload-receipt').hidden, true);
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
