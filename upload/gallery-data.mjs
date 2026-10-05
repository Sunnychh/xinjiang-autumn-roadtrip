const ID = /^[A-Za-z0-9_-]{1,128}$/;
const CONTENT_HASH = /^[a-f0-9]{64}$/;
const optionalHash = value => value == null || typeof value === 'string' && CONTENT_HASH.test(value);
const HASH = /^[a-f0-9]{40}$/;
const imageExtension = /\.(?:jpe?g|png|webp|heic|heif)$/i;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const boundedString = (value, limit) => typeof value === 'string' && value.length <= limit;
const nullableString = (value, limit) => value === null || boundedString(value, limit);
const validTime = value => boundedString(value, 128) && value.length > 0 && Number.isFinite(Date.parse(value));

// These are repository paths, never URLs. Reject ambiguous or encoded segments
// before encoding them for the fixed GitHub Contents endpoint.
export function validPhotoPath(path, { thumbnail = false } = {}) {
  if (typeof path !== 'string' || path.length > 1024 || /[\\%?#\u0000-\u001f\u007f]/.test(path) || path.includes('..')) return false;
  const segments = path.split('/');
  if (segments.some(segment => !segment || segment === '.')) return false;
  const preview = path.startsWith('records/derived/previews/') && /\.jpg$/i.test(path);
  return thumbnail ? preview : preview || (path.startsWith('records/inbox/') && imageExtension.test(path));
}

export function validateGallery(value) {
  const fail = () => { throw new TypeError('Invalid gallery manifest'); };
  if (!isObject(value) || value.schemaVersion !== 1 || !Array.isArray(value.photos) || value.photos.length > 5000) fail();
  if (value.sourceCommit !== undefined && value.sourceCommit !== null && (typeof value.sourceCommit !== 'string' || !HASH.test(value.sourceCommit))) fail();
  if (value.generatedAt !== undefined && !validTime(value.generatedAt)) fail();
  const ids = new Set(), paths = new Set();
  const photos = value.photos.map(photo => {
    if (!isObject(photo) || typeof photo.id !== 'string' || !ID.test(photo.id) || ids.has(photo.id) || !validPhotoPath(photo.photoPath)
      || paths.has(photo.photoPath) || !boundedString(photo.fileName, 255) || !photo.fileName
      || !boundedString(photo.originalName, 255) || !boundedString(photo.caption, 4000)
      || !(photo.uploadedAt === null || validTime(photo.uploadedAt)) || !(photo.captureTime === null || validTime(photo.captureTime))
      || !nullableString(photo.captureTimeSource, 80) || !nullableString(photo.captureTimeOffset, 32)
      || !(photo.thumbnailPath === undefined || photo.thumbnailPath === null || validPhotoPath(photo.thumbnailPath, { thumbnail: true }))
      || !optionalHash(photo.contentHash) || !optionalHash(photo.pixelHash)
      || !Array.isArray(photo.issues) || photo.issues.length > 50 || photo.issues.some(issue => !boundedString(issue, 500))) fail();
    const location = photo.location;
    if (location !== null && (!isObject(location) || !Number.isFinite(location.lat) || !Number.isFinite(location.lng)
      || location.lat < -90 || location.lat > 90 || location.lng < -180 || location.lng > 180
      || !['exif', 'manual'].includes(location.source))) fail();
    ids.add(photo.id); paths.add(photo.photoPath);
    return { ...photo, thumbnailPath: photo.thumbnailPath ?? null };
  });
  return { ...value, photos };
}
