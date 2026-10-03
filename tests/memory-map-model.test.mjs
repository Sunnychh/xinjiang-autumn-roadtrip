import test from 'node:test';
import assert from 'node:assert/strict';
import { validLocation, photoGroups, photoFeatures, photoTime, visiblePhotos, orderedPhotos, coordinateText, locationSource, timeSource, issueText } from '../memories/model.mjs';
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
