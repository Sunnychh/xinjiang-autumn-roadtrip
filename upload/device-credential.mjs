const DATABASE = 'xinjiang-photo-device-v1';
const STORE = 'connection';
const AAD = new TextEncoder().encode('Sunnychh/xinjiang-trip-memories/device-v1');
const validToken = value => typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/\s/.test(value);
export class DeviceStorageError extends Error {
  constructor() { super('此浏览器未能保存或读取设备连接，请重新连接；当前页面仍可使用。'); this.name = 'DeviceStorageError'; }
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(new DeviceStorageError()); return; }
    let finished = false;
    const request = indexedDB.open(DATABASE, 1);
    const timer = setTimeout(() => { finished = true; reject(new DeviceStorageError()); }, 5000);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onerror = () => { clearTimeout(timer); reject(new DeviceStorageError()); };
    request.onblocked = () => { finished = true; clearTimeout(timer); reject(new DeviceStorageError()); };
    request.onsuccess = () => {
      clearTimeout(timer);
      if (finished) { request.result.close(); return; }
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
}

async function transaction(mode, enqueue) {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const tx = database.transaction(STORE, mode);
      let result, failed = false;
      const timer = setTimeout(() => { failed = true; try { tx.abort(); } catch {} reject(new DeviceStorageError()); }, 5000);
      tx.oncomplete = () => { clearTimeout(timer); if (!failed) resolve(result); };
      tx.onabort = tx.onerror = () => { clearTimeout(timer); reject(new DeviceStorageError()); };
      // Enqueue requests synchronously; never await WebCrypto inside a transaction.
      try { enqueue(tx.objectStore(STORE), tx, value => { result = value; }); }
      catch { clearTimeout(timer); try { tx.abort(); } catch {} reject(new DeviceStorageError()); }
    });
  } finally { database.close(); }
}

const browserVault = {
  async read() {
    return transaction('readonly', (store, _tx, done) => {
      const revision = store.get('revision'), record = store.get('record');
      record.onsuccess = () => done({ revision: revision.result ?? 'initial', record: record.result ?? null });
    });
  },
  async write(record, expectedRevision) {
    return transaction('readwrite', (store, tx, done) => {
      const current = store.get('revision');
      current.onsuccess = () => {
        try {
          if ((current.result ?? 'initial') !== expectedRevision) { tx.abort(); return; }
          const revision = crypto.randomUUID();
          store.put(record, 'record'); store.put(revision, 'revision'); done(revision);
        } catch { tx.abort(); }
      };
    });
  },
  async forget(expectedRevision) {
    return transaction('readwrite', (store, tx, done) => {
      const current = store.get('revision');
      current.onsuccess = () => {
        try {
          if (expectedRevision !== undefined && (current.result ?? 'initial') !== expectedRevision) { done(false); return; }
          store.delete('record'); store.put(crypto.randomUUID(), 'revision'); done(true);
        } catch { tx.abort(); }
      };
    });
  },
};

export function createDeviceCredentialStore({ vault = browserVault, cryptoApi = globalThis.crypto } = {}) {
  let tail = Promise.resolve();
  const serial = operation => {
    const result = tail.then(operation).catch(() => { throw new DeviceStorageError(); });
    tail = result.catch(() => {});
    return result;
  };
  async function decrypt(record) {
    if (!record) return null;
    if (record.version !== 1 || record.key?.extractable !== false || record.key?.algorithm?.name !== 'AES-GCM'
      || record.key.algorithm.length !== 256 || !(record.iv instanceof Uint8Array) || record.iv.length !== 12
      || !(record.ciphertext instanceof ArrayBuffer) || record.ciphertext.byteLength > 4096) throw new DeviceStorageError();
    const bytes = new Uint8Array(await cryptoApi.subtle.decrypt({ name: 'AES-GCM', iv: record.iv, additionalData: AAD }, record.key, record.ciphertext));
    try {
      const token = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (!validToken(token)) throw new DeviceStorageError();
      return token;
    } finally { bytes.fill(0); }
  }
  return {
    load: () => serial(async () => decrypt((await vault.read()).record)),
    snapshot: () => serial(async () => {
      const state = await vault.read();
      return { token: await decrypt(state.record), revision: state.revision };
    }),
    revision: () => serial(async () => (await vault.read()).revision),
    remember: (token, { expectedRevision } = {}) => serial(async () => {
      if (!validToken(token) || !cryptoApi?.subtle) throw new DeviceStorageError();
      const before = await vault.read();
      if (expectedRevision !== undefined && before.revision !== expectedRevision) throw new DeviceStorageError();
      const key = await cryptoApi.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      const iv = cryptoApi.getRandomValues(new Uint8Array(12)), bytes = new TextEncoder().encode(token);
      let ciphertext;
      try { ciphertext = await cryptoApi.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: AAD }, key, bytes); }
      finally { bytes.fill(0); }
      const revision = await vault.write({ version: 1, key, iv, ciphertext }, before.revision);
      const after = await vault.read();
      if (after.revision !== revision || await decrypt(after.record) !== token) throw new DeviceStorageError();
      return revision;
    }),
    forget: ({ expectedRevision } = {}) => serial(() => vault.forget(expectedRevision)),
  };
}

const deviceStore = createDeviceCredentialStore();
let channel;
const listeners = new Set();
function deviceChannel() {
  if (!channel && typeof BroadcastChannel === 'function') {
    try {
      channel = new BroadcastChannel(DATABASE);
      channel.onmessage = event => { if (event.data === 'forgotten') for (const listener of listeners) listener(); };
    } catch { return null; }
  }
  return channel;
}
export const loadDeviceToken = () => deviceStore.load();
export const loadDeviceConnection = () => deviceStore.snapshot();
export const getDeviceRevision = () => deviceStore.revision();
export const rememberDeviceToken = (token, options) => deviceStore.remember(token, options);
export async function forgetDeviceToken(options) {
  const removed = await deviceStore.forget(options);
  if (removed) deviceChannel()?.postMessage('forgotten');
  return removed;
}
export function onDeviceForgotten(listener) {
  listeners.add(listener); deviceChannel();
  return () => listeners.delete(listener);
}
