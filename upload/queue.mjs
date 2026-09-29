import { MAX_BYTES, PhotoError } from './github.mjs?v=20260929-batch';

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
    || record.caption !== prepared.record.caption) {
    throw new PhotoError('尚未收到完整的照片保存回执，请保留当前页面后重试核对。', 502, 'RESPONSE');
  }
  return receipt;
}

// One original is prepared at a time, so a large selection does not expand all
// files into memory. The prepared UUID stays attached until storage is confirmed.
export class PhotoQueue {
  items = [];
  #nextId = 1;
  #run = null;

  get uncertain() { return this.items.some(item => item.uncertain); }
  get pending() { return this.items.filter(item => !['saved', 'invalid'].includes(item.status)).length; }
  get complete() { return this.items.length > 0 && this.items.every(item => item.status === 'saved'); }

  add(files) {
    const added = [], errors = [];
    for (const file of Array.from(files || [])) {
      let error;
      if (!file || !Number.isFinite(file.size) || file.size <= 0) error = new PhotoError('请选择非空的照片文件。', 400, 'INVALID');
      else if (file.size > MAX_BYTES) error = new PhotoError('每张照片不能超过 20 MB。', 413, 'INVALID');
      if (error) { errors.push({ file, error }); continue; }
      const item = { id: String(this.#nextId++), file, caption: '', status: 'pending', error: '',
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

  async run(client, { isCurrent = () => true, onChange = () => {}, onProgress = () => {} } = {}) {
    if (this.#run) return { error: new PhotoError('上一批照片仍在处理中，请稍候。', 409, 'BUSY') };
    const run = {};
    this.#run = run;
    const current = () => this.#run === run && isCurrent();
    const changed = () => { if (current()) onChange(); };
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
        if (item.owner && String(item.owner.id) !== String(client.user.id)) {
          const error = new PhotoError('这张照片由另一个 GitHub 账号发起，请使用原账号重新连接后核对。', 409, 'ACCOUNT');
          item.error = error.message; changed(); return { error, item };
        }
        if (!item.prepared) {
          item.status = 'preparing'; item.error = ''; changed();
          if (!current()) return { stale: true };
          try {
            const prepared = await client.prepare(item.file, item.caption);
            if (!current()) return { stale: true };
            item.prepared = prepared;
            item.owner = { id: client.user.id, login: client.user.login };
          } catch (failure) {
            if (!current()) return { stale: true };
            const error = safeError(failure);
            item.error = errorText(error); item.status = error.code === 'INVALID' ? 'invalid' : 'failed';
            changed();
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
            if (receipt) { saved(item, receipt); continue; }
          } catch (failure) {
            if (!current()) return { stale: true };
            const error = safeError(failure);
            item.status = 'uncertain'; item.error = errorText(error); changed();
            return { error, item };
          }
        }
        try {
          const receipt = await client.save(item.prepared, progress => {
            if (current()) onProgress(item, progress);
          });
          if (!current()) return { stale: true };
          saved(item, receipt);
        } catch (failure) {
          if (!current()) return { stale: true };
          let error = safeError(failure);
          item.uncertain = true; item.status = 'uncertain'; item.error = errorText(error); changed();
          if (!current()) return { stale: true };
          if (!NO_RECOVERY_LOOKUP.has(error.code)) {
            try {
              const receipt = await client.lookup(item.prepared);
              if (!current()) return { stale: true };
              if (receipt) { saved(item, receipt); continue; }
            } catch (lookupFailure) {
              if (!current()) return { stale: true };
              error = safeError(lookupFailure);
              item.error = errorText(error); changed();
            }
          }
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
