// The manifest remains private. These helpers only format already authenticated data.
export function validLocation(value) {
  return !!value && ['exif', 'manual'].includes(value.source) && Number.isFinite(value.lat) && Number.isFinite(value.lng)
    && value.lat >= -90 && value.lat <= 90 && value.lng >= -180 && value.lng <= 180;
}
function photoOrder(a, b) {
  return String(a.captureTime || a.uploadedAt || '').localeCompare(String(b.captureTime || b.uploadedAt || '')) || a.id.localeCompare(b.id);
}
function representativeOrder(a, b) {
  return Number(validLocation(b.location)) - Number(validLocation(a.location))
    || Number(!!b.thumbnailPath) - Number(!!a.thumbnailPath)
    || Number(!!b.captureTime) - Number(!!a.captureTime)
    || String(a.uploadedAt || '\uffff').localeCompare(String(b.uploadedAt || '\uffff'))
    || a.id.localeCompare(b.id);
}
export function duplicateGroups(photos) {
  const parents = photos.map((_, index) => index);
  const hashes = new Map();
  function root(index) {
    while (parents[index] !== index) {
      parents[index] = parents[parents[index]];
      index = parents[index];
    }
    return index;
  }
  photos.forEach((photo, index) => {
    for (const field of ['contentHash', 'pixelHash']) {
      const hash = photo[field];
      if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) continue;
      // File bytes and normalized pixels are separate hash domains. A matching
      // hash in either domain joins the entire group, including earlier matches.
      const key = `${field}:${hash}`;
      if (hashes.has(key)) parents[root(index)] = root(hashes.get(key));
      else hashes.set(key, index);
    }
  });
  const components = new Map();
  photos.forEach((photo, index) => {
    const key = root(index);
    if (!components.has(key)) components.set(key, []);
    components.get(key).push(photo);
  });
  return [...components.values()].map(members => {
    members.sort(representativeOrder);
    const representative = members[0];
    return { id: representative.id, representative, members };
  }).sort((a, b) => photoOrder(a.representative, b.representative));
}
export function photoGroups(photos) {
  const groups = new Map();
  for (const photo of photos) {
    if (!validLocation(photo.location)) continue;
    const key = `${photo.location.lat.toFixed(5)},${photo.location.lng.toFixed(5)}`;
    if (!groups.has(key)) groups.set(key, { id: key, location: photo.location, photos: [] });
    groups.get(key).photos.push(photo);
  }
  return [...groups.values()];
}
export function photoFeatures(groups) {
  return { type: 'FeatureCollection', features: groups.map(group => ({
    type: 'Feature', geometry: { type: 'Point', coordinates: [group.location.lng, group.location.lat] },
    properties: { group: group.id, count: group.photos.length, label: String(group.photos.length) },
  })) };
}
export function photoTime(photo) {
  if (photo.captureTime) {
    const text = photo.captureTime.replace('T', ' ').replace(/\.\d+/, '');
    if (/(?:Z|[+-]\d{2}:\d{2})$/.test(photo.captureTime)) return text;
    return text + (photo.captureTimeOffset ? ` ${photo.captureTimeOffset}` : '（照片未记录时区）');
  }
  return '未记录拍摄时间';
}
export function photoTitle(photo, index = 0) { return photo.fileName || photo.originalName || `旅途照片 ${index + 1}`; }
export function visiblePhotos(photos, filter) {
  return photos.filter(photo => filter === 'all' || (filter === 'located' ? validLocation(photo.location) : !validLocation(photo.location)));
}
export function orderedPhotos(photos) {
  return [...photos].sort(photoOrder);
}
export function coordinateText(photo) {
  return validLocation(photo.location) ? `${Math.abs(photo.location.lat).toFixed(5)}° ${photo.location.lat < 0 ? 'S' : 'N'}, ${Math.abs(photo.location.lng).toFixed(5)}° ${photo.location.lng < 0 ? 'W' : 'E'}` : '待补充 · 照片未提供有效 GPS';
}

export function locationSource(photo) {
  return validLocation(photo.location) ? photo.location.source === 'manual' ? '手动确认位置' : '照片 EXIF GPS（WGS84）' : '未获得照片定位，不推测拍摄点';
}
export function timeSource(photo) {
  if (!photo.captureTime) return '未记录';
  if (photo.captureTimeSource === 'manual') return '手动补充';
  return photo.captureTimeSource ? `照片元数据 · ${photo.captureTimeSource}` : '照片元数据';
}
const ISSUE_LABELS = {
  'no-gps': '原图未记录 GPS', 'no-capture-time': '原图未记录拍摄时间',
  'invalid-gps': '原图 GPS 数据无效', 'metadata-read-failed': '暂未读取到图片元数据',
  'thumbnail-failed': '缩略图生成失败，可尝试查看原图',
  'location-manually-hidden': '拍摄位置已手动隐藏', 'invalid-capture-time': '拍摄时间格式无效',
};
export function issueText(issue) {
  const code = typeof issue === 'string' ? issue : issue?.code;
  return ISSUE_LABELS[code] || (typeof issue?.message === 'string' ? issue.message : '部分照片信息待确认');
}
