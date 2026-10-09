import { PhotoError, connect } from './github.mjs?v=20261009-background';
import { PhotoQueue } from './queue.mjs?v=20261009-background';
import { loadPendingBatch, savePendingBatch, withUploadLock, supportsPendingUploads } from './pending-store.mjs?v=20261009-background';
import { loadDeviceConnection, getDeviceRevision, onDeviceForgotten } from './device-credential.mjs';

export const UPLOAD_SYNC_TAG = 'xinjiang-photo-uploads';
const RETRYABLE = new Set(['NETWORK', 'TIMEOUT', 'RESPONSE', 'CONFLICT', 'BUSY']);
const pendingCount = items => items.filter(item => !['saved', 'invalid'].includes(item.status)).length;

// Deliberately contains no request, token, caption or filename. A rejected sync
// event asks the browser for its bounded retry policy, rather than a JS loop.
export class BackgroundUploadRetryError extends Error {
  constructor() { super('后台上传暂未完成，等待浏览器重试。'); this.name = 'BackgroundUploadRetryError'; }
}

export function createBackgroundUploadRunner({
  store = { loadPendingBatch, savePendingBatch, withUploadLock, supportsPendingUploads },
  credentials = { loadDeviceConnection, getDeviceRevision, onDeviceForgotten },
  connectClient = connect,
  makeQueue = () => new PhotoQueue(),
  canLock = () => typeof globalThis.navigator?.locks?.request === 'function',
  now = () => Date.now(),
  budgetMs = 75000,
  notify = async () => {},
} = {}) {
  const announce = async id => {
    try { await notify({ type: 'upload-queue-changed', id }); } catch { /* UI notifications are best effort. */ }
  };
  return async function runBackgroundUploads() {
    // Without a cross-context lock, a sleeping page and worker could both send
    // the same batch. The foreground-only fallback is intentionally conservative.
    if (!canLock() || !store.supportsPendingUploads()) return { status: 'unavailable' };
    const locked = await store.withUploadLock(async () => {
      const batch = await store.loadPendingBatch();
      if (!batch) return { status: 'empty' };
      if (!pendingCount(batch.items)) return { status: 'complete', id: batch.id };
      if (typeof batch.backgroundRevision !== 'string' || !batch.backgroundRevision) return { status: 'foreground-only', id: batch.id };

      let client = null, authorized = true, unsubscribe = () => {};
      const stop = () => { authorized = false; client?.disconnect(); };
      const ensureAuthorized = async () => {
        if (!authorized || await credentials.getDeviceRevision() !== batch.backgroundRevision) {
          stop();
          throw new PhotoError('设备连接已变化，请打开上传页重新连接。', 401, 'AUTH');
        }
      };
      try {
        unsubscribe = credentials.onDeviceForgotten(stop);
        const connection = await credentials.loadDeviceConnection();
        if (!authorized || !connection?.token || connection.revision !== batch.backgroundRevision) return { status: 'reconnect', id: batch.id };
        await ensureAuthorized();
        client = await connectClient(connection.token);
        await ensureAuthorized();
        if (String(client.user.id) !== String(batch.owner.id)) return { status: 'account', id: batch.id };

        const queue = makeQueue();
        queue.restore(batch.items);
        const deadline = now() + Math.min(90000, Math.max(1000, budgetMs));
        let changedVersion = 0, savedVersion = 0;
        const checkpoint = async () => {
          await ensureAuthorized();
          await store.savePendingBatch({ ...batch, items: queue.snapshot() });
          savedVersion = changedVersion;
          await announce(batch.id);
        };
        const result = await queue.run(client, {
          isCurrent: () => authorized,
          onChange: () => { changedVersion++; },
          // The queue checks this only BETWEEN photos. Never interrupt a commit
          // because our time budget expires: its receipt must be checkpointed.
          shouldContinue: () => now() < deadline,
          checkpoint,
        });
        if (!authorized || result.stale) return { status: 'stopped', id: batch.id };
        // Invalid originals and a failed prepare/lookup never reach the commit
        // checkpoint, but their final status must still be visible to the page.
        if (savedVersion !== changedVersion && result.error?.code !== 'STORAGE') await checkpoint();
        if (result.error) {
          if (RETRYABLE.has(result.error.code)) throw new BackgroundUploadRetryError();
          return { status: 'attention', id: batch.id };
        }
        const pending = pendingCount(queue.items);
        return { status: pending ? 'paused' : 'complete', id: batch.id, pending };
      } catch (error) {
        if (error instanceof BackgroundUploadRetryError || (authorized && RETRYABLE.has(error?.code))) throw new BackgroundUploadRetryError();
        // Expired/forgotten keys, account mismatch, denied access, unsupported
        // storage and malformed queues require foreground attention, not retries.
        return { status: authorized ? 'attention' : 'stopped', id: batch.id };
      } finally {
        unsubscribe?.();
        client?.disconnect();
        await announce(batch.id);
      }
    });
    if (!locked.acquired) throw new BackgroundUploadRetryError();
    return locked.value;
  };
}

export const runBackgroundUploads = createBackgroundUploadRunner({
  notify: async message => {
    if (!globalThis.clients?.matchAll) return;
    const windows = await globalThis.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const window of windows) window.postMessage(message);
  },
});
