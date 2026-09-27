const API = 'https://api.github.com';
const REPOSITORY = 'Sunnychh/xinjiang-trip-memories';
const ROOT = `/repos/${REPOSITORY}`;
const BRANCH = 'main';
const SHA = /^[a-f0-9]{40}$/;
const RESPONSE_LIMIT = 1024 * 1024;

async function boundedJson(response, HttpError) {
  if (!response.body) throw new HttpError(502, '照片存储服务返回了无效结果，请稍后重试。');
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > RESPONSE_LIMIT) {
        await reader.cancel();
        throw new HttpError(502, '照片存储服务返回内容过大，请稍后重试。');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks, size).toString('utf8')); }
  catch { throw new HttpError(502, '照片存储服务返回了无效结果，请稍后重试。'); }
}

export class GitHubStorage {
  constructor({ env, HttpError, requireCurrentUser }) {
    if (typeof env.GITHUB_TOKEN !== 'string' || !env.GITHUB_TOKEN.trim()) {
      throw new HttpError(503, '照片上传入口尚未配置，请稍后再试。');
    }
    this.token = env.GITHUB_TOKEN;
    this.HttpError = HttpError;
    this.requireCurrentUser = requireCurrentUser;
  }

  async request(path, { method = 'GET', body, stream, allow = [] } = {}) {
    // Host and repository cannot be supplied by the browser or API response.
    if (!path.startsWith(ROOT) || path.includes('\\')) throw new this.HttpError(500, '存储路径无效。');
    if (method !== 'GET') await this.requireCurrentUser();
    let response;
    try {
      response = await fetch(`${API}${path}`, {
        method, redirect: 'manual', signal: AbortSignal.timeout(25000),
        ...(stream ? { duplex: 'half' } : {}),
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'Xinjiang-Private-Memories',
        },
        body: stream || (body === undefined ? undefined : JSON.stringify(body)),
      });
    } catch { throw new this.HttpError(503, '照片存储服务暂时无法连接，请保留照片并重试。'); }
    if (!response.ok) {
      await response.body?.cancel();
      if (allow.includes(response.status)) return { status: response.status, data: null };
      if ([401, 403, 404].includes(response.status)) {
        throw new this.HttpError(503, '照片存储权限不可用，请联系管理员。');
      }
      if (response.status === 429) throw new this.HttpError(503, '照片存储服务繁忙，请稍后重试。');
      throw new this.HttpError(503, '照片暂未确认保存，请查询上传状态后重试。');
    }
    return { status: response.status, data: await boundedJson(response, this.HttpError) };
  }

  async verifyPrivate() {
    const { data } = await this.request(ROOT);
    if (data.private !== true || String(data.full_name).toLowerCase() !== REPOSITORY.toLowerCase()) {
      throw new this.HttpError(503, '照片仓库必须保持私有，当前已暂停上传与读取。');
    }
  }

  sha(value) {
    if (!SHA.test(value || '')) throw new this.HttpError(502, '照片存储服务返回了无效版本，请稍后重试。');
    return value;
  }

  async head() {
    const { data } = await this.request(`${ROOT}/git/ref/heads/${BRANCH}`);
    if (data.object?.type !== 'commit') throw new this.HttpError(503, '照片仓库分支尚未就绪。');
    return this.sha(data.object.sha);
  }

  async recordAt(directory, head, validateRecord) {
    const path = directory.split('/').map(encodeURIComponent).join('/');
    const result = await this.request(`${ROOT}/contents/${path}?ref=${this.sha(head)}`, { allow: [404] });
    if (result.status === 404) return null;
    const entries = result.data;
    if (!Array.isArray(entries)) throw new this.HttpError(409, '此上传编号的存储目录已存在，请使用新的上传编号。');
    const entry = entries.find(file => file.name === 'record.json' && file.type === 'file');
    if (!entry || !SHA.test(entry.sha || '')) throw new this.HttpError(409, '此上传编号已有未完整的记录，请联系管理员。');
    const { data: blob } = await this.request(`${ROOT}/git/blobs/${entry.sha}`);
    if (blob.encoding !== 'base64' || typeof blob.content !== 'string' || blob.content.length > 48000) {
      throw new this.HttpError(409, '此上传编号的记录内容无效，请联系管理员。');
    }
    let record;
    try { record = JSON.parse(Buffer.from(blob.content, 'base64').toString('utf8')); }
    catch { throw new this.HttpError(409, '此上传编号的记录内容无效，请联系管理员。'); }
    record = validateRecord(record);
    const photo = entries.find(file => file.path === record.photoPath && file.type === 'file');
    if (!photo || !SHA.test(photo.sha || '') || photo.size !== record.byteLength) {
      throw new this.HttpError(409, '此上传编号的照片与记录不完整，请联系管理员。');
    }
    return { record, photoSha: photo.sha };
  }

  async lookup(directory, validateRecord) {
    await this.verifyPrivate();
    const head = await this.head();
    const result = await this.recordAt(directory, head, validateRecord);
    await this.requireCurrentUser();
    return result ? { record: result.record, commitSha: head } : null;
  }

  photoStream(bytes) {
    // Multiples of three keep each base64 chunk independently concatenable.
    // Streaming avoids simultaneously retaining a 28 MiB string and JSON copy.
    const chunkSize = 48 * 1024, encoder = new TextEncoder();
    let offset = -1;
    return new ReadableStream({
      pull(controller) {
        if (offset === -1) {
          controller.enqueue(encoder.encode('{"encoding":"base64","content":"'));
          offset = 0;
        } else if (offset < bytes.length) {
          const end = Math.min(offset + chunkSize, bytes.length);
          controller.enqueue(encoder.encode(bytes.subarray(offset, end).toString('base64')));
          offset = end;
        } else {
          controller.enqueue(encoder.encode('"}'));
          controller.close();
        }
      },
    });
  }

  async save({ bytes, record, photoGitSha, directory, validateRecord }) {
    await this.verifyPrivate();
    let photoBlob, recordBlob;
    for (let attempt = 0; attempt < 3; attempt++) {
      const head = await this.head();
      const existing = await this.recordAt(directory, head, validateRecord);
      if (existing) {
        await this.requireCurrentUser();
        const current = existing.record;
        if (current.sha256 !== record.sha256 || current.caption !== record.caption
          || current.mimeType !== record.mimeType || current.byteLength !== record.byteLength
          || current.photoPath !== record.photoPath || existing.photoSha !== photoGitSha) {
          throw new this.HttpError(409, '此上传编号已用于其他照片或说明，请使用新的上传编号。');
        }
        return { record: current, commitSha: head, duplicate: true };
      }
      await this.requireCurrentUser();
      if (!photoBlob) {
        // Encode only after the bounded read. No transcoding means original EXIF
        // and image bytes remain intact; the browser can safely retry the UUID.
        const { data } = await this.request(`${ROOT}/git/blobs`, {
          method: 'POST', stream: this.photoStream(bytes),
        });
        photoBlob = this.sha(data.sha);
        if (photoBlob !== photoGitSha) throw new this.HttpError(502, '照片校验未通过，请重新上传。');
        const metadata = await this.request(`${ROOT}/git/blobs`, {
          method: 'POST', body: { content: `${JSON.stringify(record, null, 2)}\n`, encoding: 'utf-8' },
        });
        recordBlob = this.sha(metadata.data.sha);
      }
      const { data: parent } = await this.request(`${ROOT}/git/commits/${head}`);
      const { data: tree } = await this.request(`${ROOT}/git/trees`, {
        method: 'POST', body: { base_tree: this.sha(parent.tree?.sha), tree: [
          { path: record.photoPath, mode: '100644', type: 'blob', sha: photoBlob },
          { path: `${directory}/record.json`, mode: '100644', type: 'blob', sha: recordBlob },
        ] },
      });
      const { data: commit } = await this.request(`${ROOT}/git/commits`, {
        method: 'POST', body: { message: `Add private travel photo ${record.id}`,
          tree: this.sha(tree.sha), parents: [head] },
      });
      // Recheck privacy and the live session immediately before publishing the
      // atomic pair. force:false prevents overwriting another upload's commit.
      await this.verifyPrivate();
      await this.requireCurrentUser();
      const advanced = await this.request(`${ROOT}/git/refs/heads/${BRANCH}`, {
        method: 'PATCH', body: { sha: this.sha(commit.sha), force: false }, allow: [409, 422],
      });
      if (advanced.status === 200) return { record, commitSha: commit.sha, duplicate: false };
    }
    throw new this.HttpError(503, '同时上传较多，暂未确认保存；请查询上传状态后使用原编号重试。');
  }
}
