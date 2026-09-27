import { createHash } from 'node:crypto';
import { GitHubStorage } from './github-storage.mjs';

export const MAX_PHOTO_BYTES = 20 * 1024 * 1024;
const MAX_BODY_BYTES = MAX_PHOTO_BYTES + 64 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const USER_ID = /^[A-Za-z0-9_-]{1,128}$/;
const TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
const EXTENSIONS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif' };

async function boundedBody(request, HttpError) {
  const declared = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new HttpError(413, '每张照片不能超过 20 MiB。');
  if (!request.body) throw new HttpError(400, '请选择照片后再上传。');
  const reader = request.body.getReader(), chunks = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new HttpError(413, '每张照片不能超过 20 MiB。');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, total);
}

function jpeg(bytes) {
  if (bytes.length < 20 || bytes[0] !== 0xff || bytes[1] !== 0xd8
    || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) return false;
  let at = 2, frame = false;
  while (at < bytes.length - 2) {
    if (bytes[at++] !== 0xff) return false;
    while (bytes[at] === 0xff) at++;
    const marker = bytes[at++];
    if (at + 2 > bytes.length || marker === 0 || marker === 0xd8 || marker === 0xd9) return false;
    const length = bytes.readUInt16BE(at);
    if (length < 2 || at + length > bytes.length - 2) return false;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (length < 8 || !bytes.readUInt16BE(at + 3) || !bytes.readUInt16BE(at + 5)) return false;
      frame = true;
    }
    if (marker === 0xda) return frame && length >= 6 && at + length < bytes.length - 2;
    at += length;
  }
  return false;
}

function png(bytes) {
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return false;
  let at = 8, header = false, pixels = false;
  while (at + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(at), kind = bytes.toString('ascii', at + 4, at + 8);
    if (length > bytes.length - at - 12) return false;
    if (!header) {
      if (kind !== 'IHDR' || length !== 13 || !bytes.readUInt32BE(at + 8) || !bytes.readUInt32BE(at + 12)) return false;
      header = true;
    } else if (kind === 'IHDR') return false;
    if (kind === 'IDAT' && length > 0) pixels = true;
    if (kind === 'IEND') return pixels && length === 0 && at + 12 === bytes.length;
    at += 12 + length;
  }
  return false;
}

function webp(bytes) {
  if (bytes.length < 26 || bytes.toString('ascii', 0, 4) !== 'RIFF'
    || bytes.toString('ascii', 8, 12) !== 'WEBP' || bytes.readUInt32LE(4) + 8 !== bytes.length) return false;
  let at = 12, pixels = false;
  while (at + 8 <= bytes.length) {
    const kind = bytes.toString('ascii', at, at + 4), length = bytes.readUInt32LE(at + 4), start = at + 8;
    if (length > bytes.length - start) return false;
    if (kind === 'VP8 ') pixels ||= length >= 10 && bytes.subarray(start + 3, start + 6).equals(Buffer.from([0x9d, 0x01, 0x2a]));
    if (kind === 'VP8L') pixels ||= length >= 5 && bytes[start] === 0x2f;
    if (kind === 'ANMF') pixels ||= length > 16;
    if (kind === 'VP8X' && length !== 10) return false;
    at = start + length + (length % 2);
  }
  return pixels && at === bytes.length;
}

function heif(bytes) {
  if (bytes.length < 24 || bytes.toString('ascii', 4, 8) !== 'ftyp') return null;
  let at = 0, brands = [], metadata = false, media = false;
  while (at + 8 <= bytes.length) {
    let length = bytes.readUInt32BE(at), header = 8;
    const kind = bytes.toString('ascii', at + 4, at + 8);
    if (length === 1) {
      if (at + 16 > bytes.length) return null;
      const large = bytes.readBigUInt64BE(at + 8);
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) return null;
      length = Number(large); header = 16;
    } else if (length === 0) length = bytes.length - at;
    if (length < header || length > bytes.length - at) return null;
    if (kind === 'ftyp') {
      if (at !== 0 || length < header + 8 || (length - header) % 4) return null;
      brands.push(bytes.toString('ascii', at + header, at + header + 4));
      for (let pos = at + header + 8; pos + 4 <= at + length; pos += 4) brands.push(bytes.toString('ascii', pos, pos + 4));
    }
    if (kind === 'meta') metadata = length > header + 4;
    if (kind === 'mdat') media ||= length > header;
    // HEIF permits encoded data in an idat child of the full-box meta container.
    if (kind === 'meta' && length > header + 4) {
      let child = at + header + 4;
      while (child + 8 <= at + length) {
        const size = bytes.readUInt32BE(child);
        if (size < 8 || child + size > at + length) break;
        if (bytes.toString('ascii', child + 4, child + 8) === 'idat' && size > 8) media = true;
        child += size;
      }
    }
    at += length;
  }
  if (at !== bytes.length || !metadata || !media || brands.some(brand => ['avif', 'avis'].includes(brand))) return null;
  if (brands.some(brand => ['heic', 'heix', 'hevc', 'hevx'].includes(brand))) return 'image/heic';
  return brands.some(brand => ['mif1', 'msf1'].includes(brand)) ? 'image/heif' : null;
}

export function detectImageType(bytes) {
  if (jpeg(bytes)) return 'image/jpeg';
  if (png(bytes)) return 'image/png';
  if (webp(bytes)) return 'image/webp';
  return heif(bytes);
}

function uploadPath(user, uploadId, HttpError) {
  if (!USER_ID.test(user.id || '')) throw new HttpError(503, '账号资料异常，请联系管理员。');
  if (typeof uploadId !== 'string' || !UUID.test(uploadId)) throw new HttpError(400, '上传编号无效，请重新选择照片。');
  return `records/inbox/${user.id}/${uploadId.toLowerCase()}`;
}

function recordValidator(user, uploadId, directory, HttpError) {
  return value => {
    if (!value || value.schemaVersion !== 1 || value.id !== uploadId || value.uploader?.id !== user.id
      || typeof value.uploader.username !== 'string' || value.uploader.username.length > 128
      || !TYPES.includes(value.mimeType) || value.photoPath !== `${directory}/photo.${EXTENSIONS[value.mimeType]}`
      || !Number.isSafeInteger(value.byteLength) || value.byteLength < 1 || value.byteLength > MAX_PHOTO_BYTES
      || !/^[a-f0-9]{64}$/.test(value.sha256 || '') || typeof value.caption !== 'string' || value.caption.length > 4000
      || typeof value.originalName !== 'string' || value.originalName.length > 255
      || typeof value.uploadedAt !== 'string' || !Number.isFinite(Date.parse(value.uploadedAt))
      || value.captureTime !== null || value.location !== null) {
      throw new HttpError(409, '此上传编号的记录内容无效，请联系管理员。');
    }
    return { schemaVersion: 1, id: value.id, photoPath: value.photoPath, originalName: value.originalName,
      mimeType: value.mimeType, byteLength: value.byteLength, sha256: value.sha256, caption: value.caption,
      uploadedAt: value.uploadedAt, uploader: { id: value.uploader.id, username: value.uploader.username },
      captureTime: null, location: null };
  };
}

async function parseUpload(request, context) {
  const { HttpError } = context;
  const type = request.headers.get('Content-Type') || '';
  if (!/^multipart\/form-data\s*;/i.test(type) || type.length > 300) throw new HttpError(415, '请通过照片上传表单提交。');
  const bytes = await boundedBody(request, HttpError);
  let form;
  try { form = await new Response(bytes, { headers: { 'Content-Type': type } }).formData(); }
  catch { throw new HttpError(400, '照片上传表单无效，请重新选择照片。'); }
  if ([...form.keys()].some(key => !['photo', 'caption', 'uploadId'].includes(key))
    || form.getAll('photo').length !== 1 || form.getAll('uploadId').length !== 1 || form.getAll('caption').length > 1) {
    throw new HttpError(400, '每次只能提交一张照片及其说明。');
  }
  const photo = form.get('photo'), rawCaption = form.get('caption') ?? '', uploadId = form.get('uploadId');
  if (!photo || typeof photo === 'string' || typeof photo.arrayBuffer !== 'function') throw new HttpError(400, '请选择有效照片。');
  if (!photo.size || photo.size > MAX_PHOTO_BYTES) throw new HttpError(413, '照片不能为空，且每张不能超过 20 MiB。');
  if (typeof rawCaption !== 'string') throw new HttpError(400, '照片说明必须是文字。');
  // Browser multipart encoders convert textarea line endings to CRLF. Store a
  // consistent newline so retries from another browser remain the same caption.
  const caption = rawCaption.replace(/\r\n?/g, '\n');
  if (caption.length > 4000) throw new HttpError(400, '照片说明不能超过 4,000 个字符。');
  const originalName = String(photo.name || 'photo').split(/[\\/]/).at(-1).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 255) || 'photo';
  const content = Buffer.from(await photo.arrayBuffer()), mimeType = detectImageType(content);
  if (!mimeType) throw new HttpError(415, '仅支持有效的 JPEG、PNG、WebP、HEIC 或 HEIF 照片。');
  return { content, mimeType, originalName, caption, uploadId };
}

export async function memoriesApi(request, pathname, context) {
  const { env, user, json, method, HttpError, nowSeconds, requireCurrentUser } = context;
  if (pathname === '/api/memories/status') {
    method(request, 'GET');
    const configured = typeof env.GITHUB_TOKEN === 'string' && Boolean(env.GITHUB_TOKEN.trim());
    if (configured) {
      await new GitHubStorage(context).verifyPrivate();
      await requireCurrentUser();
    }
    return json({ configured,
      maxBytes: MAX_PHOTO_BYTES, acceptedTypes: TYPES });
  }
  const storage = new GitHubStorage(context);
  if (pathname.startsWith('/api/memories/photo/')) {
    method(request, 'GET');
    const uploadId = pathname.slice('/api/memories/photo/'.length).toLowerCase();
    const directory = uploadPath(user, uploadId, HttpError);
    const result = await storage.lookup(directory, recordValidator(user, uploadId, directory, HttpError));
    if (!result) throw new HttpError(404, '尚未找到这张照片的已保存记录。');
    return json({ ...result, record: { ...result.record, metadataPath: `${directory}/record.json` } });
  }
  if (pathname !== '/api/memories/photo') throw new HttpError(404, '接口不存在。');
  method(request, 'POST');
  const upload = await parseUpload(request, context);
  const directory = uploadPath(user, upload.uploadId, HttpError), uploadId = upload.uploadId.toLowerCase();
  await requireCurrentUser();
  const record = {
    schemaVersion: 1, id: uploadId, photoPath: `${directory}/photo.${EXTENSIONS[upload.mimeType]}`,
    originalName: upload.originalName, mimeType: upload.mimeType, byteLength: upload.content.length,
    sha256: createHash('sha256').update(upload.content).digest('hex'), caption: upload.caption,
    uploadedAt: new Date(nowSeconds() * 1000).toISOString(),
    uploader: { id: user.id, username: user.username }, captureTime: null, location: null,
  };
  const photoGitSha = createHash('sha1').update(`blob ${upload.content.length}\0`).update(upload.content).digest('hex');
  const result = await storage.save({ bytes: upload.content, record, directory, photoGitSha,
    validateRecord: recordValidator(user, uploadId, directory, HttpError) });
  return json({ ...result, record: { ...result.record, metadataPath: `${directory}/record.json` } }, result.duplicate ? 200 : 201);
}
