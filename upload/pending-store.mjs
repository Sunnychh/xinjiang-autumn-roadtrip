import { PhotoQueue, validQueueOwner } from './queue.mjs?v=20261009-background';

const DATABASE = 'xinjiang-pending-photos-v1';
const STORE = 'pending';
const LOCK = 'xinjiang-photo-upload-v1';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export class PendingStorageError extends Error {
  constructor() {
    super('本机待传照片未能保存或读取，上传已暂停；请保留当前页面后重试。');
    this.name = 'PendingStorageError'; this.code = 'STORAGE';
  }
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(new PendingStorageError()); return; }
    let settled = false, request;
    const fail = () => { settled = true; clearTimeout(timer); reject(new PendingStorageError()); };
    const timer = setTimeout(fail, 5000);
    try { request = indexedDB.open(DATABASE, 1); } catch { fail(); return; }
    request.onupgradeneeded = () => {
      if (settled) { try { request.transaction.abort(); } catch {} return; }
      request.result.createObjectStore(STORE);
    };
    request.onerror = request.onblocked = fail;
    request.onsuccess = () => {
      clearTimeout(timer);
      if (settled) { request.result.close(); return; }
      settled = true;
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
}

async function transaction(mode, enqueue) {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      let tx, result, failed = false;
      const fail = () => {
        failed = true; clearTimeout(timer);
        try { tx?.abort(); } catch {}
        reject(new PendingStorageError());
      };
      const timer = setTimeout(fail, 10000);
      try {
        tx = database.transaction(STORE, mode);
        tx.oncomplete = () => { clearTimeout(timer); if (!failed) resolve(result); };
        tx.onabort = tx.onerror = fail;
        enqueue(tx.objectStore(STORE), tx, value => { result = value; });
      } catch { fail(); }
    });
  } finally { database.close(); }
}

const browserVault = {
  read: () => transaction('readonly', (store, _tx, done) => {
    const request = store.get('batch'); request.onsuccess = () => done(request.result ?? null);
  }),
  write: batch => transaction('readwrite', (store, tx, done) => {
    const current = store.get('batch');
    current.onsuccess = () => {
      try {
        if (current.result && (current.result.id !== batch.id || current.result.owner?.id !== batch.owner.id)) { tx.abort(); return; }
        store.put(batch, 'batch'); done();
      } catch { tx.abort(); }
    };
  }),
  clear: expectedId => transaction('readwrite', (store, tx, done) => {
    const current = store.get('batch');
    current.onsuccess = () => {
      try {
        if (!current.result || current.result.id !== expectedId) { done(false); return; }
        store.delete('batch'); done(true);
      } catch { tx.abort(); }
    };
  }),
};

// Copy only known queue fields. Originals stay on this device; neither the
// credential nor the temporary base64/decoded upload buffers enter this store.
function normalizeBatch(batch) {
  if (!batch || batch.version !== 1 || typeof batch.id !== 'string' || !UUID.test(batch.id)
    || !validQueueOwner(batch.owner) || typeof batch.createdAt !== 'string' || batch.createdAt.length > 100
    || !Number.isFinite(Date.parse(batch.createdAt))
    || (batch.backgroundRevision != null && (typeof batch.backgroundRevision !== 'string' || !batch.backgroundRevision.length || batch.backgroundRevision.length > 128))) throw new PendingStorageError();
  const queue = new PhotoQueue();
  queue.restore(batch.items);
  if (queue.items.some(item => item.owner && item.owner.id !== batch.owner.id)) throw new PendingStorageError();
  return { version: 1, id: batch.id, owner: { id: batch.owner.id, login: batch.owner.login },
    createdAt: batch.createdAt, backgroundRevision: batch.backgroundRevision ?? null, items: queue.snapshot() };
}

export function createPendingStore({ vault = browserVault, locks = globalThis.navigator?.locks, timeoutMs = 5000 } = {}) {
  const supported = () => typeof locks?.request === 'function' && (vault !== browserVault || !!globalThis.indexedDB);
  let tail = Promise.resolve();
  const serial = operation => {
    const result = tail.then(async () => {
      if (!supported()) throw new PendingStorageError();
      try { return await operation(); } catch { throw new PendingStorageError(); }
    });
    tail = result.catch(() => {});
    return result;
  };
  return {
    supported,
    load: () => serial(async () => {
      const value = await vault.read();
      return value === null ? null : normalizeBatch(value);
    }),
    save: batch => serial(async () => {
      const value = normalizeBatch(batch);
      const previous = await vault.read();
      if (previous && (previous.id !== value.id || previous.owner?.id !== value.owner.id)) throw new PendingStorageError();
      await vault.write(value);
    }),
    clear: expectedId => serial(async () => {
      if (typeof expectedId !== 'string' || !UUID.test(expectedId)) throw new PendingStorageError();
      return vault.clear(expectedId);
    }),
    lock: callback => {
      if (!supported()) return Promise.resolve({ acquired: false });
      return new Promise((resolve, reject) => {
        let entered = false, expired = false;
        const timer = setTimeout(() => {
          if (entered) return;
          expired = true; reject(new PendingStorageError());
        }, timeoutMs);
        try {
          locks.request(LOCK, { ifAvailable: true }, async lock => {
            if (expired) return { acquired: false };
            entered = true; clearTimeout(timer);
            if (!lock) return { acquired: false };
            return { acquired: true, value: await callback() };
          }).then(resolve, error => { clearTimeout(timer); reject(entered ? error : new PendingStorageError()); });
        } catch { clearTimeout(timer); reject(new PendingStorageError()); }
      });
    },
  };
}

const pendingStore = createPendingStore();
export const supportsPendingUploads = () => pendingStore.supported();
export const loadPendingBatch = () => pendingStore.load();
export const savePendingBatch = batch => pendingStore.save(batch);
export const clearPendingBatch = expectedId => pendingStore.clear(expectedId);
export const withUploadLock = callback => pendingStore.lock(callback);
