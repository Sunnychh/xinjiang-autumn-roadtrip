import test from 'node:test';
import assert from 'node:assert/strict';
import { validLocation, duplicateGroups, photoGroups, photoFeatures, photoTime, visiblePhotos, orderedPhotos, coordinateText, locationSource, timeSource, issueText } from '../memories/model.mjs';
const located = (id, lat = 43.5, lng = 83.8) => ({ id, location: { lat, lng, source: 'exif' } });
test('only EXIF or explicitly confirmed manual coordinates become photo points', () => {
  for (const location of [null, { lat: 43, lng: 84 }, { lat: 43, lng: 84, source: 'hotel' }, { lat: '43', lng: 84, source: 'exif' }, { lat: 91, lng: 84, source: 'exif' }, { lat: 43, lng: Infinity, source: 'exif' }]) assert.equal(validLocation(location), false);
  assert.equal(validLocation(located('a').location), true);
  assert.equal(validLocation({ lat: 43, lng: 84, source: 'manual' }), true);
});
test('photos without GPS remain separately visible and never become map features', () => {
  const photos = [located('a'), { id: 'b', location: null }, { id: 'c', location: { lat: 43.5, lng: 83.8, source: 'hotel' } }];
  assert.deepEqual(visiblePhotos(photos, 'unlocated').map(x => x.id), ['b', 'c']);
  assert.deepEqual(visiblePhotos(photos, 'located').map(x => x.id), ['a']);
  assert.equal(photoFeatures(photoGroups(photos)).features.length, 1);
});
test('same-point photos remain individually accessible while geometry is longitude first', () => {
  const groups = photoGroups([located('a'), located('b', 43.500001), located('c', 44)]);
  assert.equal(groups.length, 2); assert.deepEqual(groups[0].photos.map(x => x.id), ['a', 'b']);
  const feature = photoFeatures(groups).features[0];
  assert.deepEqual(feature.geometry.coordinates, [83.8, 43.5]); assert.equal(feature.properties.count, 2);
});
test('time never silently turns upload time into capture time or assigns a timezone', () => {
  assert.equal(photoTime({ uploadedAt: '2026-10-03T08:00:00Z' }), '未记录拍摄时间');
  assert.equal(photoTime({ captureTime: '2026-09-28T17:18:19' }), '2026-09-28 17:18:19（照片未记录时区）');
  assert.equal(photoTime({ captureTime: '2026-09-28T17:18:19+08:00' }), '2026-09-28 17:18:19+08:00');
});
test('chronological list keeps input immutable', () => {
  const photos = [{ id: 'late', captureTime: '2026-10-01T12:00:00' }, { id: 'early', captureTime: '2026-09-27T12:00:00' }];
  assert.deepEqual(orderedPhotos(photos).map(x => x.id), ['early', 'late']); assert.equal(photos[0].id, 'late');
});
test('unlocated detail is explicitly pending', () => assert.match(coordinateText({ location: null }), /待补充/));

test('manual corrections remain visibly distinct from EXIF data', () => {
  assert.equal(locationSource({ location: { lat: 43, lng: 84, source: 'manual' } }), '手动确认位置');
  assert.equal(timeSource({ captureTime: '2026-10-01T12:00:00', captureTimeSource: 'manual' }), '手动补充');
  assert.match(timeSource({ captureTime: '2026-10-01T12:00:00', captureTimeSource: 'ExifIFD:DateTimeOriginal' }), /ExifIFD:DateTimeOriginal/);
  assert.equal(photoTime({ captureTime: '2026-10-01T12:00:00', captureTimeOffset: '+08:00' }), '2026-10-01 12:00:00 +08:00');
});
test('known pipeline issues are shown as understandable Chinese', () => {
  assert.equal(issueText('no-gps'), '原图未记录 GPS');
  assert.equal(issueText('location-manually-hidden'), '拍摄位置已手动隐藏');
});

const hash = letter => letter.repeat(64);
const groupIds = photos => duplicateGroups(photos).map(group => ({ id: group.id, members: group.members.map(photo => photo.id) }));
test('byte-identical uploads collapse even with different names, captions and GPS corrections', () => {
  const first = { id: 'a', contentHash: hash('a'), fileName: 'first.jpg', caption: 'first', location: null };
  const second = { ...located('b'), contentHash: hash('a'), fileName: 'second.jpg', caption: 'second' };
  const groups = duplicateGroups([first, second]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].representative, second);
  assert.deepEqual(groups[0].members, [second, first]);
  assert.equal(groups[0].members[1].caption, 'first');
});
test('identical normalized pixels collapse files whose metadata or encoding bytes differ', () => {
  const photos = [
    { id: 'a', contentHash: hash('a'), pixelHash: hash('f') },
    { id: 'b', contentHash: hash('b'), pixelHash: hash('f') },
    { id: 'c', contentHash: hash('c'), pixelHash: hash('c') },
  ];
  assert.deepEqual(groupIds(photos), [{ id: 'a', members: ['a', 'b'] }, { id: 'c', members: ['c'] }]);
});
test('independent pictures do not merge based on time, name, location or caption', () => {
  const common = { fileName: 'same.jpg', caption: '风景', captureTime: '2026-10-01T12:00:00', uploadedAt: '2026-10-03T12:00:00Z' };
  const photos = [
    { ...located('a'), ...common, contentHash: hash('a'), pixelHash: hash('b') },
    { ...located('b'), ...common, contentHash: hash('c'), pixelHash: hash('d') },
    { ...located('c', 44), ...common, contentHash: hash('e'), pixelHash: hash('f') },
  ];
  const groups = duplicateGroups(photos);
  assert.equal(groups.length, 3);
  assert.deepEqual(groups.map(group => group.members.length), [1, 1, 1]);
  // Co-located but distinct pictures still share a map point, not a duplicate group.
  assert.deepEqual(photoGroups(groups.map(group => group.representative)).map(group => group.photos.length), [2, 1]);
});
test('missing, malformed and cross-domain hashes do not cause accidental deduplication', () => {
  const invalid = [undefined, null, '', '0', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), 123, {}];
  const photos = invalid.flatMap((value, index) => [
    { id: `${index}-a`, contentHash: value, pixelHash: value },
    { id: `${index}-b`, contentHash: value, pixelHash: value },
  ]);
  photos.push({ id: 'file-hash', contentHash: hash('a') }, { id: 'pixel-hash', pixelHash: hash('a') });
  assert.equal(duplicateGroups(photos).length, photos.length);
  assert.deepEqual(duplicateGroups([]), []);
  assert.deepEqual(groupIds([{ id: 'legacy-a' }, { id: 'legacy-b' }]), [
    { id: 'legacy-a', members: ['legacy-a'] }, { id: 'legacy-b', members: ['legacy-b'] },
  ]);
});
test('invalid content hash does not disable an independently valid pixel match', () => {
  assert.equal(duplicateGroups([
    { id: 'a', contentHash: 'bad', pixelHash: hash('b') },
    { id: 'b', pixelHash: hash('b') },
  ]).length, 1);
});
test('content and pixel matches join transitively regardless of bridge arrival order', () => {
  const photos = [
    { id: 'a', contentHash: hash('a'), pixelHash: hash('a') },
    { id: 'b', contentHash: hash('a'), pixelHash: hash('b') },
    { id: 'c', contentHash: hash('c'), pixelHash: hash('b') },
    { id: 'd', contentHash: hash('d'), pixelHash: hash('d') },
  ];
  const expected = [{ id: 'a', members: ['a', 'b', 'c'] }, { id: 'd', members: ['d'] }];
  assert.deepEqual(groupIds(photos), expected);
  assert.deepEqual(groupIds([photos[2], photos[3], photos[0], photos[1]]), expected);
  assert.deepEqual(groupIds([...photos].reverse()), expected);
});
test('representative preference and member order are deterministic without mutating input', () => {
  const shared = { contentHash: hash('a') };
  const photos = [
    { id: 'no-location', ...shared, thumbnailPath: 'preview.jpg', captureTime: '2026-09-28T12:00:00' },
    { ...located('no-preview'), ...shared, captureTime: '2026-09-28T12:00:00' },
    { ...located('no-capture'), ...shared, thumbnailPath: 'preview.jpg' },
    { ...located('later'), ...shared, thumbnailPath: 'preview.jpg', captureTime: '2026-09-28T12:00:00', uploadedAt: '2026-10-03T12:00:00Z' },
    { ...located('earlier-b'), ...shared, thumbnailPath: 'preview.jpg', captureTime: '2026-09-28T12:00:00', uploadedAt: '2026-10-02T12:00:00Z' },
    { ...located('earlier-a'), ...shared, thumbnailPath: 'preview.jpg', captureTime: '2026-09-28T12:00:00', uploadedAt: '2026-10-02T12:00:00Z' },
    { ...located('missing-upload'), ...shared, thumbnailPath: 'preview.jpg', captureTime: '2026-09-28T12:00:00' },
    { ...located('invalid-location', 91), ...shared },
  ];
  const snapshot = structuredClone(photos);
  const expected = [{ id: 'earlier-a', members: ['earlier-a', 'earlier-b', 'later', 'missing-upload', 'no-capture', 'no-preview', 'no-location', 'invalid-location'] }];
  assert.deepEqual(groupIds(photos), expected);
  assert.deepEqual(groupIds([...photos].reverse()), expected);
  assert.deepEqual(photos, snapshot);
});
test('duplicate groups use the existing chronological order for their representatives', () => {
  const photos = [
    { id: 'late', captureTime: '2026-10-01T12:00:00', contentHash: hash('c') },
    { id: 'early-z', captureTime: '2026-09-27T12:00:00', contentHash: hash('a') },
    { id: 'early-a', captureTime: '2026-09-27T12:00:00', contentHash: hash('b') },
  ];
  assert.deepEqual(duplicateGroups(photos).map(group => group.representative), orderedPhotos(photos));
});
