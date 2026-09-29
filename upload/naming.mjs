const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const NAME = /^新疆旅行_(\d{8})_(\d{3,16})_([a-f0-9]{8})$/;
const PREVIEW_EXTENSIONS = new Map([['jpg', 'jpg'], ['jpeg', 'jpg'], ['png', 'png'],
  ['webp', 'webp'], ['heic', 'heic'], ['heif', 'heif']]);

// This is the selection/upload date in China, never an inferred capture date.
export function chinaDateStamp(date = new Date()) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw new TypeError('Invalid naming date');
  const china = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const year = china.getUTCFullYear();
  if (year < 1 || year > 9999) throw new TypeError('Invalid naming year');
  return `${String(year).padStart(4, '0')}${String(china.getUTCMonth() + 1).padStart(2, '0')}${String(china.getUTCDate()).padStart(2, '0')}`;
}

export function createNameBase({ id, sequence = 1, date = new Date() }) {
  if (typeof id !== 'string' || !UUID.test(id)) throw new TypeError('Invalid naming ID');
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new TypeError('Invalid naming sequence');
  return `新疆旅行_${chinaDateStamp(date)}_${String(sequence).padStart(3, '0')}_${id.slice(0, 8).toLowerCase()}`;
}

export function validNameBase(nameBase, id) {
  if (typeof nameBase !== 'string' || typeof id !== 'string' || !UUID.test(id)) return false;
  const match = NAME.exec(nameBase);
  if (!match || match[3] !== id.slice(0, 8).toLowerCase()) return false;
  const sequence = Number(match[2]);
  if (!Number.isSafeInteger(sequence) || sequence < 1 || String(sequence).padStart(3, '0') !== match[2]) return false;
  const stamp = match[1], year = Number(stamp.slice(0, 4)), month = Number(stamp.slice(4, 6)), day = Number(stamp.slice(6, 8));
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(`${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

// Selection previews may use the original suffix. Actual saved names are always
// assigned by the content detector in prepare(), not this convenience helper.
export function previewFileName(nameBase, originalName) {
  const suffix = typeof originalName === 'string' ? /\.([^.\\/]+)$/.exec(originalName)?.[1]?.toLowerCase() : null;
  const extension = PREVIEW_EXTENSIONS.get(suffix);
  return extension ? `${nameBase}.${extension}` : nameBase;
}
