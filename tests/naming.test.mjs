import assert from 'node:assert/strict';
import test from 'node:test';
import { chinaDateStamp, createNameBase, validNameBase, previewFileName } from '../upload/naming.mjs';

const ID = 'ABCDEF12-2222-4222-8222-222222222222';

test('date labels follow China time across day and year boundaries', () => {
  assert.equal(chinaDateStamp(new Date('2026-09-28T15:59:59Z')), '20260928');
  assert.equal(chinaDateStamp(new Date('2026-09-28T16:00:00Z')), '20260929');
  assert.equal(chinaDateStamp(new Date('2026-12-31T16:00:00Z')), '20270101');
  assert.throws(() => chinaDateStamp(new Date('invalid')), TypeError);
});

test('stable names include padded selection order and a lowercase UUID prefix', () => {
  const date = new Date('2026-09-28T16:00:00Z');
  assert.equal(createNameBase({ id: ID, sequence: 1, date }), '新疆旅行_20260929_001_abcdef12');
  assert.equal(createNameBase({ id: ID, sequence: 1000, date }), '新疆旅行_20260929_1000_abcdef12');
  for (const sequence of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => createNameBase({ id: ID, sequence, date }), TypeError);
  assert.throws(() => createNameBase({ id: '../unsafe', date }), TypeError);
});

test('name validation rejects path syntax, invalid dates, sequence ambiguity and unrelated IDs', () => {
  assert.equal(validNameBase('新疆旅行_20260929_001_abcdef12', ID), true);
  assert.equal(validNameBase('新疆旅行_20240229_001_abcdef12', ID), true);
  for (const name of ['../新疆旅行_20260929_001_abcdef12', '新疆旅行_20260929_001_abcdef12.png',
    '新疆旅行_20260229_001_abcdef12', '新疆旅行_20261301_001_abcdef12', '新疆旅行_00000101_001_abcdef12',
    '新疆旅行_20260929_000_abcdef12', '新疆旅行_20260929_0001_abcdef12',
    '新疆旅行_20260929_9007199254740992_abcdef12', '新疆旅行_20260929_001_deadbeef',
    null, 42]) assert.equal(validNameBase(name, ID), false, String(name));
});

test('preview suffixes are normalized only for known photo filename extensions', () => {
  const base = '新疆旅行_20260929_001_abcdef12';
  assert.equal(previewFileName(base, 'IMG_001.JPEG'), `${base}.jpg`);
  assert.equal(previewFileName(base, 'IMG_001.HEIC'), `${base}.heic`);
  assert.equal(previewFileName(base, 'renamed.txt'), base);
  assert.equal(previewFileName(base, '<script>'), base);
});
