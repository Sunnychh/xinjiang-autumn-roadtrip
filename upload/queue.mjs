import { MAX_BYTES, PhotoError } from './github.mjs?v=20260929-cards';
import { createNameBase, previewFileName, validNameBase } from './naming.mjs?v=20260929-cards';

const BUSY = new Set(['preparing', 'uploading']);
const NO_RECOVERY_LOOKUP = new Set(['AUTH', 'PERMISSION', 'PRIVATE', 'CONFIG', 'ACCOUNT']);
const knownError = error => error instanceof PhotoError || (error?.name === 'PhotoError' && typeof error.code === 'string');
const safeError = error => knownError(error) ? error : new PhotoError('照片处理未完成，请保留当前页面后重试。');
const errorText = error => safeError(error).message;

function confirmedReceipt(receipt, prepared) {
  const record = receipt?.record;
  if (!/^[a-f0-9]{40}$/i.test(receipt?.commitSha || '') || !record
    || typeof record.originalName !== 'string' || typeof record.caption !== 'string'
    || record.id !== prepared.record.id || record.photoPath !== prepared.record.photoPath
    || (record.fileName !== undefined && record.fileName !== prepared.record.fileName)
    || (record.displayName !== undefined && record.displayName !== prepared.record.displayName)
    || record.caption !== prepared.record.caption) {
    throw new PhotoError('尚未收到完整的照片保存回执，请保留当前页面后重试核对。', 502, 'RESPONSE');
  }
  return receipt;
}

const SNAPSHOT_STATUSES = new Set(['pending', 'preparing', 'uploading', 'failed', 'invalid', 'uncertain', 'saved']);
const invalidSnapshot = () => new PhotoError('本机待传照片记录不完整，请重新选择照片。', 400, 'CONFIG');
const text = (value, max) => typeof value === 'string' && value.length <= max;
export const validQueueOwner = owner => !!owner && Number.isSafeInteger(owner.id) && owner.id > 0
  && typeof owner.login === 'string' && /^[A-Za-z0-9-]{1,39}$/.test(owner.login);
const fileInfo = file => ({ name: file.name, size: file.size, type: file.type || '',
  lastModified: Number.isFinite(file.lastModified) ? file.lastModified : 0 });

function snapshotReceipt(receipt) {
  if (!receipt) return null;
  const fields = ['schemaVersion', 'id', 'photoPath', 'fileName', 'displayName', 'originalName', 'mimeType',
    'byteLength', 'sha256', 'caption', 'uploadedAt', 'metadataPath'];
  const record = Object.fromEntries(fields.filter(key => receipt.record?.[key] !== undefined).map(key => [key, receipt.record[key]]));
  return { commitSha: receipt.commitSha, record, duplicate: receipt.duplicate === true };
}

function restoreItem(value) {
  if (!value || typeof value !== 'object' || !Number.isSafeInteger(value.sequence) || value.sequence < 1 || value.sequence >= Number.MAX_SAFE_INTEGER
    || value.id !== String(value.sequence) || !validNameBase(value.nameBase, value.uploadId)
    || Number(value.nameBase.split('_')[2]) !== value.sequence || !text(value.fileName, 160)
    || (value.fileName !== value.nameBase && !['jpg','png','webp','heic','heif'].some(ext => value.fileName === `${value.nameBase}.${ext}`))
    || !text(value.caption, 4000) || !SNAPSHOT_STATUSES.has(value.status) || typeof value.uncertain !== 'boolean'
    || !text(value.error, 5000) || (value.owner !== null && !validQueueOwner(value.owner))) throw invalidSnapshot();
  const info = value.fileInfo;
  if (!info || !text(info.name, 4096) || !info.name || !Number.isSafeInteger(info.size) || info.size < 1 || info.size > MAX_BYTES
    || !text(info.type, 255) || !Number.isFinite(info.lastModified) || info.lastModified < 0) throw invalidSnapshot();
  let file;
  if (value.status === 'saved') {
    const record = value.receipt?.record;
    if (value.file !== null || !value.owner || value.uncertain || !/^[a-f0-9]{40}$/i.test(value.receipt?.commitSha || '')
      || record?.id !== value.uploadId || record.fileName !== value.fileName || record.displayName !== value.nameBase
      || record.photoPath !== `records/inbox/github-${value.owner.id}/${value.uploadId}/${value.fileName}`
      || record.caption !== value.caption.replace(/\r\n?/g, '\n') || !text(record.originalName, 255)
      || !record.originalName || !text(record.uploadedAt, 100) || !Number.isFinite(Date.parse(record.uploadedAt))
      || (record.schemaVersion !== undefined && record.schemaVersion !== 1)
      || (record.byteLength !== undefined && record.byteLength !== info.size)
      || (record.sha256 !== undefined && (typeof record.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(record.sha256)))
      || (record.mimeType !== undefined && !['image/jpeg','image/png','image/webp','image/heic','image/heif'].includes(record.mimeType))
      || (record.metadataPath !== undefined && record.metadataPath !== `records/inbox/github-${value.owner.id}/${value.uploadId}/record.json`)) throw invalidSnapshot();
    file = { ...info };
  } else {
    if (!(value.file instanceof Blob) || value.file.size !== info.size || value.file.type !== info.type || value.receipt !== null) throw invalidSnapshot();
    file = typeof File === 'function' ? new File([value.file], info.name, { type: info.type, lastModified: info.lastModified }) : value.file;
    if (typeof File !== 'function') Object.defineProperties(file, { name: { value: info.name, configurable: true }, lastModified: { value: info.lastModified, configurable: true } });
  }
  const uncertain = value.uncertain || value.status === 'uploading' || value.status === 'uncertain';
  if (uncertain && !value.owner) throw invalidSnapshot();
  return { id: value.id, sequence: value.sequence, uploadId: value.uploadId, nameBase: value.nameBase,
    fileName: value.fileName, file, caption: value.caption, owner: value.owner ? { ...value.owner } : null,
    receipt: snapshotReceipt(value.receipt), prepared: null, uncertain,
    status: value.status === 'saved' ? 'saved' : uncertain ? 'uncertain' : value.status === 'preparing' ? 'pending' : value.status,
    error: value.error };
}

// One original is prepared at a time, so a large selection does not expand all
// files into memory. The prepared UUID stays attached until storage is confirmed.
export class PhotoQueue {
  items = [];
  #nextId = 1;
  #run = null;
  #now;
  #randomUUID;

  constructor({ now = () => new Date(), randomUUID = () => crypto.randomUUID() } = {}) {
    this.#now = now; this.#randomUUID = randomUUID;
  }

  get uncertain() { return this.items.some(item => item.uncertain); }
  get pending() { return this.items.filter(item => !['saved', 'invalid'].includes(item.status)).length; }
  get complete() { return this.items.length > 0 && this.items.every(item => item.status === 'saved'); }

  snapshot() {
    return this.items.map(item => ({ id: item.id, uploadId: item.uploadId, sequence: item.sequence,
      nameBase: item.nameBase, fileName: item.fileName, caption: item.caption, status: item.status, error: item.error,
      owner: item.owner ? { id: item.owner.id, login: item.owner.login } : null,
      uncertain: item.uncertain || !!item.prepared, receipt: snapshotReceipt(item.receipt),
      file: item.status === 'saved' ? null : item.file, fileInfo: fileInfo(item.file) }));
  }

  restore(items) {
    if (this.#run || !Array.isArray(items) || items.length > 10000) throw invalidSnapshot();
    const restored = items.map(restoreItem);
    if (new Set(restored.map(item => item.id)).size !== restored.length
      || new Set(restored.map(item => item.uploadId.toLowerCase())).size !== restored.length) throw invalidSnapshot();
    this.items = restored;
    this.#nextId = Math.max(0, ...restored.map(item => item.sequence)) + 1;
  }

  add(files) {
    const added = [], errors = [];
    for (const file of Array.from(files || [])) {
      let error;
      if (!file || !Number.isFinite(file.size) || file.size <= 0) error = new PhotoError('请选择非空的照片文件。', 400, 'INVALID');
      else if (file.size > MAX_BYTES) error = new PhotoError('每张照片不能超过 20 MB。', 413, 'INVALID');
      if (error) { errors.push({ file, error }); continue; }
      const sequence = this.#nextId++, uploadId = this.#randomUUID();
      const nameBase = createNameBase({ id: uploadId, sequence, date: this.#now() });
      const item = { id: String(sequence), uploadId, sequence, nameBase, fileName: previewFileName(nameBase, file.name), file, caption: '', status: 'pending', error: '',
        prepared: null, owner: null, receipt: null, uncertain: false };
      this.items.push(item); added.push(item);
    }
    return { added, errors };
  }

  remove(id) {
    const index = this.items.findIndex(item => item.id === id), item = this.items[index];
    if (!item || item.prepared || item.uncertain || item.status === 'saved' || BUSY.has(item.status)) return false;
    this.items.splice(index, 1); return true;
  }

  clear() {
    if (this.#run || this.items.some(item => item.uncertain || item.prepared)) return false;
    this.items.length = 0; return true;
  }

  interrupt() {
    this.#run = null;
    for (const item of this.items) {
      if (item.status === 'preparing') item.status = 'pending';
      else if (item.status === 'uploading') {
        item.status = 'uncertain'; item.uncertain = true;
        item.error = '连接已中断，请重新连接后核对这张照片是否已保存。';
      }
    }
  }

  async run(client, { isCurrent = () => true, onChange = () => {}, onProgress = () => {}, checkpoint, shouldContinue = () => true } = {}) {
    if (this.#run) return { error: new PhotoError('上一批照片仍在处理中，请稍候。', 409, 'BUSY') };
    const run = {};
    this.#run = run;
    const current = () => this.#run === run && isCurrent();
    const changed = () => { if (current()) onChange(); };
    const persist = async (item, originalError) => {
      try { await checkpoint(); return null; }
      catch (failure) {
        if (!current()) return { stale: true };
        const storageError = knownError(failure) || failure?.name === 'PendingStorageError' ? failure
          : new PhotoError('本机上传进度未能保存，已暂停；请保留当前页面后重试。', 0, 'STORAGE');
        const error = originalError || storageError;
        item.error = error.message;
        changed();
        return { error, item, ...(originalError ? { checkpointError: storageError } : {}) };
      }
    };
    const saved = (item, receipt) => {
      item.receipt = confirmedReceipt(receipt, item.prepared);
      item.status = 'saved'; item.error = ''; item.uncertain = false;
      item.prepared = null;
      changed();
    };
    try {
      // Capture this batch. Photos added while a run is in flight stay queued for
      // the next explicit run rather than extending a batch without a boundary.
      for (const item of [...this.items]) {
        if (!current()) return { stale: true };
        if (!this.items.includes(item) || ['saved', 'invalid'].includes(item.status)) continue;
        if (!shouldContinue()) return { paused: true };
        if (item.owner && String(item.owner.id) !== String(client.user.id)) {
          const error = new PhotoError('这张照片由另一个 GitHub 账号发起，请使用原账号重新连接后核对。', 409, 'ACCOUNT');
          item.error = error.message; changed(); return { error, item };
        }
        if (!item.prepared) {
          item.status = 'preparing'; item.error = ''; changed();
          if (!current()) return { stale: true };
          try {
            const prepared = await client.prepare(item.file, item.caption, item.uploadId, { nameBase: item.nameBase });
            if (!current()) return { stale: true };
            item.prepared = prepared;
            if (typeof prepared.record.fileName === 'string') item.fileName = prepared.record.fileName;
            item.owner = { id: client.user.id, login: client.user.login };
          } catch (failure) {
            if (!current()) return { stale: true };
            const error = safeError(failure);
            item.error = errorText(error); item.status = error.code === 'INVALID' ? 'invalid' : 'failed';
            changed();
            if (checkpoint) { const failure = await persist(item, error); if (failure) return failure; }
            if (!current()) return { stale: true };
            if (error.code === 'INVALID') continue;
            return { error, item };
          }
        }
        item.status = 'uploading'; item.error = ''; changed();
        if (!current()) return { stale: true };
        if (item.uncertain) {
          try {
            const receipt = await client.lookup(item.prepared);
            if (!current()) return { stale: true };
            if (receipt) {
              saved(item, receipt);
              if (checkpoint) { const failure = await persist(item); if (failure) return failure; }
              if (!current()) return { stale: true };
              continue;
            }
          } catch (failure) {
            if (!current()) return { stale: true };
            const error = safeError(failure);
            item.status = 'uncertain'; item.error = errorText(error); changed();
            if (checkpoint) { const failure = await persist(item, error); if (failure) return failure; }
            if (!current()) return { stale: true };
            return { error, item };
          }
        }
        if (checkpoint) {
          item.uncertain = true;
          const failure = await persist(item);
          if (failure) { if (current()) { item.status = 'uncertain'; changed(); } return failure; }
          if (!current()) return { stale: true };
        }
        try {
          const receipt = await client.save(item.prepared, progress => {
            if (current()) onProgress(item, progress);
          });
          if (!current()) return { stale: true };
          saved(item, receipt);
          if (checkpoint) { const failure = await persist(item); if (failure) return failure; }
          if (!current()) return { stale: true };
        } catch (failure) {
          if (!current()) return { stale: true };
          let error = safeError(failure);
          item.uncertain = true; item.status = 'uncertain'; item.error = errorText(error); changed();
          if (!current()) return { stale: true };
          if (!NO_RECOVERY_LOOKUP.has(error.code)) {
            try {
              const receipt = await client.lookup(item.prepared);
              if (!current()) return { stale: true };
              if (receipt) {
                saved(item, receipt);
                if (checkpoint) { const failure = await persist(item); if (failure) return failure; }
                if (!current()) return { stale: true };
                continue;
              }
            } catch (lookupFailure) {
              if (!current()) return { stale: true };
              error = safeError(lookupFailure);
              item.error = errorText(error); changed();
            }
          }
          if (checkpoint) { const failure = await persist(item, error); if (failure) return failure; }
          if (!current()) return { stale: true };
          return { error, item };
        }
      }
      return { complete: this.complete };
    } finally {
      // A disconnected run may finish after a new connection already started.
      if (this.#run === run) this.#run = null;
    }
  }
}
