import { detectImageType } from './image.mjs';

export const MAX_BYTES = 20 * 1024 * 1024;
const API = 'https://api.github.com';
const REPO = 'Sunnychh/xinjiang-trip-memories';
const ROOT = `/repos/${REPO}`;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif' };
const encoder = new TextEncoder();
const preparedUploads = new WeakSet();

export class PhotoError extends Error {
  constructor(message, status = 0, code = 'NETWORK') {
    super(message); this.name = 'PhotoError'; this.status = status; this.code = code;
  }
}

const invalid = message => new PhotoError(message, 400, 'INVALID');
function sha(value) {
  if (!/^[a-f0-9]{40}$/.test(value || '')) throw new PhotoError('照片库返回了无效的版本信息。', 502);
  return value;
}
async function digest(kind, bytes) {
  return [...new Uint8Array(await crypto.subtle.digest(kind, bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
}
function base64(bytes) {
  // Chunk on a multiple of three so large originals do not overflow the JS call stack.
  const parts = [];
  for (let at = 0; at < bytes.length; at += 24576) parts.push(btoa(String.fromCharCode(...bytes.subarray(at, at + 24576))));
  return parts.join('');
}
async function json(response) {
  if (!response.body) throw new PhotoError('照片库暂未返回有效结果。', 502);
  const reader = response.body.getReader(), chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > 1024 * 1024) { await reader.cancel(); throw new PhotoError('照片库返回内容过大。', 502); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const content = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { content.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(content)); }
  catch { throw new PhotoError('照片库暂未返回有效结果。', 502); }
}

export async function connect(rawToken, { fetchImpl = globalThis.fetch } = {}) {
  let token = typeof rawToken === 'string' ? rawToken.trim() : '';
  rawToken = null;
  if (!token || token.length > 1024 || /\s/.test(token)) throw invalid('请粘贴有效的 GitHub 令牌。');
  let user, saving = false;
  const ensureConnected = () => { if (!token) throw new PhotoError('连接已断开，请重新连接。', 401, 'AUTH'); };

  async function request(path, { method = 'GET', body, allow = [] } = {}) {
    ensureConnected();
    if (path !== '/user' && path !== ROOT && !path.startsWith(`${ROOT}/`)) throw invalid('照片库路径无效。');
    const url = new URL(path, API);
    if (url.origin !== API || path.includes('\\') || path.includes('..')) throw invalid('照片库地址无效。');
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), method === 'POST' ? 120000 : 30000);
    try {
      let response;
      try {
        response = await fetchImpl(url.href, {
          method, credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer', signal: controller.signal,
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
            'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch { throw new PhotoError('暂时无法连接 GitHub，请检查网络后重试。'); }
      if (!response.ok) {
        await response.body?.cancel();
        if (allow.includes(response.status)) return { status: response.status, data: null };
        if (response.status === 401) throw new PhotoError('令牌无效或已过期，请重新连接。', 401, 'AUTH');
        if ([403, 404].includes(response.status)) throw new PhotoError('无法访问照片库，请确认令牌已选择照片仓库并开启 Contents 读写权限；若达到 GitHub 限流，请稍后重试。', response.status, 'PERMISSION');
        throw new PhotoError('GitHub 暂未确认保存，请保留此页并重试核对。', response.status);
      }
      return { status: response.status, data: await json(response) };
    } finally { clearTimeout(timer); }
  }
  async function verifyPrivate() {
    const { data } = await request(ROOT);
    if (data.private !== true || String(data.full_name).toLowerCase() !== REPO.toLowerCase()) {
      throw new PhotoError('照片仓库必须保持私有，当前已暂停上传。', 403, 'PRIVATE');
    }
    if (data.permissions?.push !== true) throw new PhotoError('当前 GitHub 账号没有照片仓库的写入权限。', 403, 'PERMISSION');
    if (data.default_branch !== 'main') throw new PhotoError('照片库的 main 分支配置已改变，请联系维护者。', 409, 'CONFIG');
  }
  async function head() {
    const { data } = await request(`${ROOT}/git/ref/heads/main`);
    if (data.object?.type !== 'commit') throw new PhotoError('照片库 main 分支尚未就绪。', 409, 'CONFIG');
    return sha(data.object.sha);
  }
  function assertPrepared(prepared) {
    ensureConnected();
    if (!preparedUploads.has(prepared)) throw invalid('请重新选择照片。');
    if (prepared.record.uploader.id !== `github-${user.id}`) throw new PhotoError('这张照片由另一个 GitHub 账号发起，请用原账号的令牌重新连接后核对。', 409, 'ACCOUNT');
  }
  async function atHead(prepared, commitSha) {
    assertPrepared(prepared);
    const { directory, record, photoGitSha } = prepared;
    const path = directory.split('/').map(encodeURIComponent).join('/');
    const { data: entries, status } = await request(`${ROOT}/contents/${path}?ref=${sha(commitSha)}`, { allow: [404] });
    if (status === 404) return null;
    const conflict = () => new PhotoError('此上传编号已有不匹配或不完整的记录，请保留原图并联系维护者核对。', 409, 'CONFLICT');
    if (!Array.isArray(entries)) throw conflict();
    const metadata = entries.find(entry => entry.name === 'record.json' && entry.type === 'file');
    const photo = entries.find(entry => entry.path === record.photoPath && entry.type === 'file');
    if (!metadata || !photo || photo.sha !== photoGitSha || photo.size !== record.byteLength) throw conflict();
    const { data: blob } = await request(`${ROOT}/git/blobs/${sha(metadata.sha)}`);
    if (blob.encoding !== 'base64' || typeof blob.content !== 'string' || blob.content.length > 48000) throw conflict();
    let stored;
    try { stored = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(blob.content.replace(/\s/g, '')), char => char.charCodeAt(0)))); }
    catch { throw conflict(); }
    if (!stored || stored.schemaVersion !== 1 || stored.id !== record.id || stored.uploader?.id !== record.uploader.id
      || stored.sha256 !== record.sha256 || stored.photoPath !== record.photoPath || stored.caption !== record.caption
      || stored.mimeType !== record.mimeType || stored.byteLength !== record.byteLength
      || typeof stored.originalName !== 'string' || stored.originalName.length > 255
      || typeof stored.uploadedAt !== 'string' || !Number.isFinite(Date.parse(stored.uploadedAt))) throw conflict();
    return { record: { ...record, originalName: stored.originalName, uploadedAt: stored.uploadedAt, metadataPath: `${directory}/record.json` }, commitSha, duplicate: true };
  }
  async function lookup(prepared) {
    assertPrepared(prepared);
    await verifyPrivate();
    return atHead(prepared, await head());
  }
  async function prepare(file, rawCaption = '', id = crypto.randomUUID()) {
    ensureConnected();
    if (!file || typeof file.arrayBuffer !== 'function' || !file.size) throw invalid('请选择一张有效照片。');
    if (file.size > MAX_BYTES) throw new PhotoError('每张照片不能超过 20 MB。', 413, 'INVALID');
    if (typeof rawCaption !== 'string') throw invalid('附言必须是文字。');
    const caption = rawCaption.replace(/\r\n?/g, '\n');
    if (caption.length > 4000) throw invalid('附言不能超过 4,000 个字符。');
    if (!UUID.test(id)) throw invalid('上传编号无效。');
    id = id.toLowerCase();
    const bytes = new Uint8Array(await file.arrayBuffer()), mimeType = detectImageType(bytes);
    if (!mimeType) throw new PhotoError('请选择有效的 JPG、PNG、WebP、HEIC 或 HEIF 照片。', 415, 'INVALID');
    const directory = `records/inbox/github-${user.id}/${id}`;
    const header = encoder.encode(`blob ${bytes.length}\0`), gitBytes = new Uint8Array(header.length + bytes.length);
    gitBytes.set(header); gitBytes.set(bytes, header.length);
    const [sha256, photoGitSha] = await Promise.all([digest('SHA-256', bytes), digest('SHA-1', gitBytes)]);
    const record = Object.freeze({ schemaVersion: 1, id, photoPath: `${directory}/photo.${EXT[mimeType]}`,
      originalName: String(file.name || 'photo').split(/[\\/]/).at(-1).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 255) || 'photo',
      mimeType, byteLength: bytes.length, sha256, caption, uploadedAt: new Date().toISOString(),
      uploader: Object.freeze({ id: `github-${user.id}`, username: user.login, provider: 'github' }), captureTime: null, location: null });
    const prepared = Object.freeze({ record, bytes, directory, photoGitSha });
    preparedUploads.add(prepared);
    return prepared;
  }
  async function save(prepared, onProgress = () => {}) {
    assertPrepared(prepared);
    if (saving) throw new PhotoError('上一张照片还在保存，请稍候。', 409, 'BUSY');
    saving = true;
    const { bytes, record, directory, photoGitSha } = prepared;
    let photoBlob, recordBlob;
    try {
      await verifyPrivate();
      for (let attempt = 0; attempt < 3; attempt++) {
        onProgress({ percent: 10, label: attempt ? '正在合并照片库的新记录…' : '正在核对照片库…' });
        const parentSha = await head();
        const existing = await atHead(prepared, parentSha);
        if (existing) return existing;
        if (!photoBlob) {
          onProgress({ percent: 25, label: '正在上传原图…' });
          const { data } = await request(`${ROOT}/git/blobs`, { method: 'POST', body: { content: base64(bytes), encoding: 'base64' } });
          photoBlob = sha(data.sha);
          if (photoBlob !== photoGitSha) throw new PhotoError('原图完整性校验未通过，请重新核对。', 502);
          const metadata = await request(`${ROOT}/git/blobs`, { method: 'POST', body: { content: JSON.stringify(record, null, 2) + '\n', encoding: 'utf-8' } });
          recordBlob = sha(metadata.data.sha);
        }
        onProgress({ percent: 65, label: '原图已传送，正在保存附言…' });
        const { data: parent } = await request(`${ROOT}/git/commits/${parentSha}`);
        const { data: tree } = await request(`${ROOT}/git/trees`, { method: 'POST', body: { base_tree: sha(parent.tree?.sha), tree: [
          { path: record.photoPath, mode: '100644', type: 'blob', sha: photoBlob },
          { path: `${directory}/record.json`, mode: '100644', type: 'blob', sha: recordBlob },
        ] } });
        const { data: commit } = await request(`${ROOT}/git/commits`, { method: 'POST', body: {
          message: `Add private travel photo ${record.id}`, tree: sha(tree.sha), parents: [parentSha],
        } });
        // Keep photos and metadata atomic, and never overwrite another traveller's newer commit.
        await verifyPrivate();
        onProgress({ percent: 85, label: '正在确认照片与附言一起保存…' });
        const result = await request(`${ROOT}/git/refs/heads/main`, { method: 'PATCH', body: { sha: sha(commit.sha), force: false }, allow: [409, 422] });
        if ([409, 422].includes(result.status)) continue;
        const saved = await lookup(prepared);
        if (!saved) throw new PhotoError('照片已提交，但还没有收到保存回执，请重试核对。');
        onProgress({ percent: 100, label: '照片已保存' });
        return { ...saved, duplicate: false };
      }
      throw new PhotoError('照片库正在更新，请重试核对同一张照片。', 409);
    } finally { saving = false; }
  }
  try {
    const { data } = await request('/user');
    if (!Number.isSafeInteger(data.id) || data.id < 1 || typeof data.login !== 'string' || !/^[A-Za-z0-9-]{1,39}$/.test(data.login)) throw invalid('GitHub 账号资料无效。');
    user = Object.freeze({ id: data.id, login: data.login });
    await verifyPrivate();
    await head();
    return Object.freeze({ user, prepare, save, lookup, disconnect() { token = ''; } });
  } catch (error) { token = ''; throw error; }
}
