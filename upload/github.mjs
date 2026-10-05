import { detectImageType } from './image.mjs?v=20260929-cards';
import { createNameBase, validNameBase } from './naming.mjs?v=20260929-cards';
import { validPhotoPath, validateGallery } from './gallery-data.mjs?v=20261005-duplicates';

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
const CONNECTION_STAGES = { input: '检查令牌格式', identity: '验证 GitHub 账号', repository: '检查照片仓库', branch: '读取照片库分支' };
export function connectionErrorMessage(error) {
  if (!(error instanceof PhotoError)) return '浏览器未能完成连接。请更新 Safari / Chrome 后重试，或使用下方按钮检测 GitHub 网络连接。';
  const stage = CONNECTION_STAGES[error.stage];
  const prefix = stage ? `${stage}时：` : '';
  if (error.code === 'NETWORK') return prefix + '当前网络未能访问 GitHub API（api.github.com）。请点击下方“检测 GitHub 连接”，也可切换 Wi-Fi / 移动网络后重试。';
  if (error.code === 'TIMEOUT') return prefix + '等待 GitHub 响应超时。请切换网络后重试，不需要重新创建令牌。';
  if (error.code === 'RESPONSE') return prefix + 'GitHub 的响应未完整读取。请检查网络后重试；持续出现时请更新浏览器。';
  if (error.code === 'AUTH') return 'GitHub 拒绝了此令牌（401）。请从生成结果复制完整令牌，不要复制“Xinjiang Photos”这个名称，并确认令牌未过期。';
  if (['INVALID', 'PERMISSION', 'PRIVATE', 'CONFIG', 'ACCOUNT', 'CONFLICT', 'COMPAT'].includes(error.code)) return prefix + error.message;
  return prefix + `GitHub 暂未完成请求${error.status ? `（HTTP ${error.status}）` : ''}，请稍后重试。`;
}

export async function probeGitHub({ fetchImpl = globalThis.fetch } = {}) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
  try {
    let response;
    try {
      response = await fetchImpl(`${API}/meta`, { credentials: 'omit', redirect: 'error', cache: 'no-store',
        referrerPolicy: 'no-referrer', signal: controller.signal,
        headers: { Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' } });
    } catch (error) { throw new PhotoError('无法连接 GitHub API。', 0, controller.signal.aborted || error?.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK'); }
    await response.body?.cancel();
    if (!response.ok) throw new PhotoError(`GitHub 已响应，但网络检测接口返回 HTTP ${response.status}；请稍后重试。`, response.status, 'PERMISSION');
    return { reachable: true };
  } finally { clearTimeout(timer); }
}

function sha(value) {
  if (!/^[a-f0-9]{40}$/.test(value || '')) throw new PhotoError('照片库返回了无效的版本信息。', 502, 'RESPONSE');
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
async function json(response, maxBytes = 1024 * 1024) {
  if (!response.body || typeof response.body.getReader !== 'function') throw new PhotoError('照片库暂未返回有效结果。', 502, 'RESPONSE');
  const reader = response.body.getReader(), chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) { await reader.cancel(); throw new PhotoError('照片库返回内容过大。', 502, 'RESPONSE'); }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof PhotoError) throw error;
    throw new PhotoError('读取 GitHub 响应时网络中断。', 502, 'RESPONSE');
  } finally { reader.releaseLock(); }
  const content = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { content.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(content)); }
  catch { throw new PhotoError('照片库暂未返回有效结果。', 502, 'RESPONSE'); }
}

export async function connect(rawToken, { fetchImpl = globalThis.fetch, onProgress = () => {} } = {}) {
  let token = typeof rawToken === 'string' ? rawToken.trim() : '';
  rawToken = null;
  if (!token || token.length > 1024 || /\s/.test(token)) {
    const error = invalid('请复制完整的 GitHub 令牌，不要复制令牌名称或整段说明；内容中不能有空格、换行。');
    error.stage = 'input'; throw error;
  }
  let user, saving = false, gallerySnapshot = null;
  let stage = 'identity';
  const ensureConnected = () => { if (!token) throw new PhotoError('连接已断开，请重新连接。', 401, 'AUTH'); };

  async function request(path, { method = 'GET', body, allow = [], maxJsonBytes = 1024 * 1024 } = {}) {
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
      } catch (error) { throw new PhotoError('暂时无法连接 GitHub，请检查网络后重试。', 0, controller.signal.aborted || error?.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK'); }
      if (response.redirected || (response.url && new URL(response.url).origin !== API)) {
        await response.body?.cancel();
        throw new PhotoError('照片库响应地址无效。', 502, 'RESPONSE');
      }
      if (!response.ok) {
        await response.body?.cancel();
        if (allow.includes(response.status)) return { status: response.status, data: null };
        if (response.status === 401) throw new PhotoError('令牌无效或已过期，请重新连接。', 401, 'AUTH');
        if ([403, 404].includes(response.status)) throw new PhotoError('无法访问照片库，请确认令牌已选择照片仓库并开启 Contents 读写权限；若达到 GitHub 限流，请稍后重试。', response.status, 'PERMISSION');
        throw new PhotoError('GitHub 暂未确认保存，请保留此页并重试核对。', response.status, 'HTTP');
      }
      const data = await json(response, maxJsonBytes);
      ensureConnected();
      return { status: response.status, data };
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
  const badGallery = () => new PhotoError('照片回忆数据无效或不完整，请稍后重新生成。', 502, 'RESPONSE');
  // GitHub wraps binary bytes in base64 JSON (including escaped line breaks).
  // Keep every streaming response bounded, including envelopes for large files.
  const blobJsonLimit = bytes => Math.ceil(bytes * 1.5) + 4096;
  async function readGalleryFile(path, commitSha, maxBytes, { missing = false } = {}) {
    const encoded = path.split('/').map(encodeURIComponent).join('/');
    const { data: entry, status } = await request(`${ROOT}/contents/${encoded}?ref=${sha(commitSha)}`, {
      allow: missing ? [404] : [], maxJsonBytes: blobJsonLimit(Math.min(maxBytes, 1024 * 1024)),
    });
    if (status === 404) return null;
    if (!entry || Array.isArray(entry) || entry.type !== 'file' || entry.path !== path
      || !Number.isSafeInteger(entry.size) || entry.size < 1 || entry.size > maxBytes) throw badGallery();
    const expectedSha = sha(entry.sha);
    // Never use download_url, html_url, or any URL returned in repository data.
    const { data: blob } = await request(`${ROOT}/git/blobs/${expectedSha}`, { maxJsonBytes: blobJsonLimit(maxBytes) });
    if (!blob || blob.sha !== expectedSha || blob.encoding !== 'base64' || blob.size !== entry.size
      || typeof blob.content !== 'string') throw badGallery();
    const encodedContent = blob.content.replace(/[\r\n]/g, '');
    if (encodedContent.length !== 4 * Math.ceil(entry.size / 3) || /[^A-Za-z0-9+/=]/.test(encodedContent)) throw badGallery();
    let bytes;
    try { bytes = Uint8Array.from(atob(encodedContent), char => char.charCodeAt(0)); }
    catch { throw badGallery(); }
    if (bytes.length !== entry.size || bytes.length > maxBytes) throw badGallery();
    const header = encoder.encode(`blob ${bytes.length}\0`), gitBytes = new Uint8Array(header.length + bytes.length);
    gitBytes.set(header); gitBytes.set(bytes, header.length);
    if (await digest('SHA-1', gitBytes) !== expectedSha) throw badGallery();
    ensureConnected();
    return bytes;
  }
  async function gallery() {
    ensureConnected();
    await verifyPrivate();
    const snapshot = await head();
    const bytes = await readGalleryFile('records/derived/index.json', snapshot, 8 * 1024 * 1024, { missing: true });
    if (bytes === null) { gallerySnapshot = snapshot; return null; }
    let result;
    try { result = validateGallery(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))); }
    catch { throw badGallery(); }
    ensureConnected();
    gallerySnapshot = snapshot;
    return { ...result, snapshotCommit: snapshot };
  }
  async function photoBlob(path, { maxBytes = MAX_BYTES } = {}) {
    ensureConnected();
    if (!validPhotoPath(path)) throw invalid('照片路径无效。');
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES) throw invalid('照片大小限制无效。');
    await verifyPrivate();
    const snapshot = gallerySnapshot ?? await head();
    const bytes = await readGalleryFile(path, snapshot, maxBytes);
    const mimeType = detectImageType(bytes);
    if (!mimeType || (path.startsWith('records/derived/previews/') && mimeType !== 'image/jpeg')) throw badGallery();
    ensureConnected();
    return new Blob([bytes], { type: mimeType });
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
      || (stored.fileName !== undefined && stored.fileName !== record.fileName)
      || (stored.displayName !== undefined && stored.displayName !== record.displayName)
      || typeof stored.originalName !== 'string' || stored.originalName.length > 255
      || typeof stored.uploadedAt !== 'string' || !Number.isFinite(Date.parse(stored.uploadedAt))) throw conflict();
    return { record: { ...record, originalName: stored.originalName, uploadedAt: stored.uploadedAt, metadataPath: `${directory}/record.json` }, commitSha, duplicate: true };
  }
  async function lookup(prepared) {
    assertPrepared(prepared);
    await verifyPrivate();
    return atHead(prepared, await head());
  }
  async function prepare(file, rawCaption = '', id = crypto.randomUUID(), options = {}) {
    ensureConnected();
    if (!file || typeof file.arrayBuffer !== 'function' || !file.size) throw invalid('请选择一张有效照片。');
    if (file.size > MAX_BYTES) throw new PhotoError('每张照片不能超过 20 MB。', 413, 'INVALID');
    if (typeof rawCaption !== 'string') throw invalid('附言必须是文字。');
    const caption = rawCaption.replace(/\r\n?/g, '\n');
    if (caption.length > 4000) throw invalid('附言不能超过 4,000 个字符。');
    if (typeof id !== 'string' || !UUID.test(id)) throw invalid('上传编号无效。');
    id = id.toLowerCase();
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw invalid('照片名称设置无效。');
    const nameBase = options.nameBase === undefined ? createNameBase({ id }) : options.nameBase;
    if (!validNameBase(nameBase, id)) throw invalid('照片名称无效，请重新选择照片。');
    const bytes = new Uint8Array(await file.arrayBuffer()), mimeType = detectImageType(bytes);
    if (!mimeType) throw new PhotoError('请选择有效的 JPG、PNG、WebP、HEIC 或 HEIF 照片。', 415, 'INVALID');
    const directory = `records/inbox/github-${user.id}/${id}`;
    const header = encoder.encode(`blob ${bytes.length}\0`), gitBytes = new Uint8Array(header.length + bytes.length);
    gitBytes.set(header); gitBytes.set(bytes, header.length);
    const [sha256, photoGitSha] = await Promise.all([digest('SHA-256', bytes), digest('SHA-1', gitBytes)]);
    const fileName = `${nameBase}.${EXT[mimeType]}`;
    const record = Object.freeze({ schemaVersion: 1, id, photoPath: `${directory}/${fileName}`, fileName, displayName: nameBase,
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
    onProgress(stage);
    const { data } = await request('/user');
    if (!Number.isSafeInteger(data.id) || data.id < 1 || typeof data.login !== 'string' || !/^[A-Za-z0-9-]{1,39}$/.test(data.login)) throw invalid('GitHub 账号资料无效。');
    user = Object.freeze({ id: data.id, login: data.login });
    stage = 'repository'; onProgress(stage);
    await verifyPrivate();
    stage = 'branch'; onProgress(stage);
    await head();
    return Object.freeze({ user, prepare, save, lookup, gallery, photoBlob, disconnect() { token = ''; gallerySnapshot = null; } });
  } catch (error) {
    token = '';
    if (error instanceof PhotoError) error.stage = stage;
    throw error;
  }
}
