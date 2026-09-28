// Validate image container structure without decoding or changing EXIF / original bytes.
const ascii = (bytes, start, end) => String.fromCharCode(...bytes.subarray(start, end));
const same = (bytes, expected) => bytes.length === expected.length && expected.every((value, index) => bytes[index] === value);

function jpeg(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 20 || bytes[0] !== 0xff || bytes[1] !== 0xd8
    || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) return false;
  let at = 2, frame = false;
  while (at < bytes.length - 2) {
    if (bytes[at++] !== 0xff) return false;
    while (bytes[at] === 0xff) at++;
    const marker = bytes[at++];
    if (at + 2 > bytes.length || marker === 0 || marker === 0xd8 || marker === 0xd9) return false;
    const length = view.getUint16(at);
    if (length < 2 || at + length > bytes.length - 2) return false;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (length < 8 || !view.getUint16(at + 3) || !view.getUint16(at + 5)) return false;
      frame = true;
    }
    if (marker === 0xda) return frame && length >= 6 && at + length < bytes.length - 2;
    at += length;
  }
  return false;
}

function png(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 45 || !same(bytes.subarray(0, 8), [137, 80, 78, 71, 13, 10, 26, 10])) return false;
  let at = 8, header = false, pixels = false;
  while (at + 12 <= bytes.length) {
    const length = view.getUint32(at), kind = ascii(bytes, at + 4, at + 8);
    if (length > bytes.length - at - 12) return false;
    if (!header) {
      if (kind !== 'IHDR' || length !== 13 || !view.getUint32(at + 8) || !view.getUint32(at + 12)) return false;
      header = true;
    } else if (kind === 'IHDR') return false;
    if (kind === 'IDAT' && length > 0) pixels = true;
    if (kind === 'IEND') return pixels && length === 0 && at + 12 === bytes.length;
    at += 12 + length;
  }
  return false;
}

function webp(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 26 || ascii(bytes, 0, 4) !== 'RIFF'
    || ascii(bytes, 8, 12) !== 'WEBP' || view.getUint32(4, true) + 8 !== bytes.length) return false;
  let at = 12, pixels = false;
  while (at + 8 <= bytes.length) {
    const kind = ascii(bytes, at, at + 4), length = view.getUint32(at + 4, true), start = at + 8;
    if (length > bytes.length - start) return false;
    if (kind === 'VP8 ') pixels ||= length >= 10 && same(bytes.subarray(start + 3, start + 6), [0x9d, 0x01, 0x2a]);
    if (kind === 'VP8L') pixels ||= length >= 5 && bytes[start] === 0x2f;
    if (kind === 'ANMF') pixels ||= length > 16;
    if (kind === 'VP8X' && length !== 10) return false;
    at = start + length + (length % 2);
  }
  return pixels && at === bytes.length;
}

function heif(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 24 || ascii(bytes, 4, 8) !== 'ftyp') return null;
  let at = 0, brands = [], metadata = false, media = false;
  while (at + 8 <= bytes.length) {
    let length = view.getUint32(at), header = 8;
    const kind = ascii(bytes, at + 4, at + 8);
    if (length === 1) {
      if (at + 16 > bytes.length) return null;
      const large = view.getBigUint64(at + 8);
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) return null;
      length = Number(large); header = 16;
    } else if (length === 0) length = bytes.length - at;
    if (length < header || length > bytes.length - at) return null;
    if (kind === 'ftyp') {
      if (at !== 0 || length < header + 8 || (length - header) % 4) return null;
      brands.push(ascii(bytes, at + header, at + header + 4));
      for (let pos = at + header + 8; pos + 4 <= at + length; pos += 4) brands.push(ascii(bytes, pos, pos + 4));
    }
    if (kind === 'meta') metadata = length > header + 4;
    if (kind === 'mdat') media ||= length > header;
    // HEIF permits encoded data in an idat child of the full-box meta container.
    if (kind === 'meta' && length > header + 4) {
      let child = at + header + 4;
      while (child + 8 <= at + length) {
        const size = view.getUint32(child);
        if (size < 8 || child + size > at + length) break;
        if (ascii(bytes, child + 4, child + 8) === 'idat' && size > 8) media = true;
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
