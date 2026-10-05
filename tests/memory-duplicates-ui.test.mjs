import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import * as model from '../memories/model.mjs';

// Real view code and grouping helpers, synthetic photographs, no external I/O.
const source = readFileSync(new URL('../memories/app.mjs', import.meta.url), 'utf8')
  .replace(/^import\s[^;]+;\s*$/gm, '');
const html = readFileSync(new URL('../memories/index.html', import.meta.url), 'utf8');
const hash = value => value.repeat(64);
const location = { lat: 43.5, lng: 83.8, source: 'exif' };
function photograph(id, overrides = {}) {
  return {
    id, photoPath: `records/inbox/test/${id}.jpg`, thumbnailPath: `records/derived/previews/${id}.jpg`,
    originalName: `${id}-original.jpg`, fileName: `${id}.jpg`, caption: `caption-${id}`,
    uploadedAt: '2026-10-03T08:00:00Z', captureTime: '2026-09-28T12:00:00+08:00',
    captureTimeSource: 'ExifIFD:DateTimeOriginal', location: null, issues: [], ...overrides,
  };
}
function collection(photos, sequence = 1) {
  return {
    schemaVersion: 1, generatedAt: `2026-10-05T08:00:${String(sequence).padStart(2, '0')}Z`,
    sourceCommit: String(sequence).repeat(40), photos,
  };
}
function duplicateFixture() {
  return [
    photograph('stripped', { contentHash: hash('a'), uploadedAt: '2026-10-03T07:00:00Z' }),
    photograph('original', { contentHash: hash('a'), pixelHash: hash('b'), location }),
    photograph('metadata-copy', { contentHash: hash('c'), pixelHash: hash('b'), location: { ...location, source: 'manual', lat: 44 }, uploadedAt: '2026-10-04T09:00:00Z' }),
    photograph('other-view', { contentHash: hash('d'), pixelHash: hash('e'), location }),
    photograph('without-hash', { location }),
    photograph('unlocated'),
  ];
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function flush() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
class Element {
  constructor(id = '', tag = '') {
    this.id = id; this.tagName = tag.match(/^<?([a-z]+)/i)?.[1]?.toUpperCase() || '';
    this.hidden = /\bhidden\b/.test(tag); this.disabled = /\bdisabled\b/.test(tag);
    this.dataset = {}; this.attributes = {}; this.listeners = new Map(); this.children = []; this._text = '';
    this.classList = { add() {}, remove() {}, toggle() {} };
  }
  set textContent(value) { this._text = String(value ?? ''); this.children = []; }
  get textContent() { return this._text + this.children.map(child => typeof child === 'string' ? child : child.textContent).join(''); }
  addEventListener(type, callback) { const callbacks = this.listeners.get(type) || []; callbacks.push(callback); this.listeners.set(type, callbacks); }
  emit(type, event = {}) {
    for (const callback of this.listeners.get(type) || []) callback({ target: this, currentTarget: this, preventDefault() {}, ...event });
    this[`on${type}`]?.({ target: this, currentTarget: this, preventDefault() {}, ...event });
  }
  click() { if (!this.disabled) this.emit('click'); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) { delete this.attributes[name]; if (name === 'src') this.src = ''; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this._text = ''; this.children = [...nodes]; }
  querySelectorAll(selector) { assert.equal(selector, 'button'); return buttons(this); }
  focus() {} scrollIntoView() {}
}
const descendants = node => node.children.flatMap(child => typeof child === 'string' ? [] : [child, ...descendants(child)]);
const buttons = node => descendants(node).filter(child => child.tagName === 'BUTTON');
function fixture(initialManifest, { blobLoader } = {}) {
  const elements = new Map();
  for (const match of html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)) elements.set(match[1], new Element(match[1], match[0]));
  const element = id => { assert.ok(elements.has(id), `Missing UI element #${id}`); return elements.get(id); };
  const filters = [...html.matchAll(/<button[^>]+data-filter="([^"]+)"[^>]*>/g)].map(match => {
    const button = new Element('', match[0]); button.dataset.filter = match[1]; return button;
  });
  const forgotten = [], mapSnapshots = [], requests = [], created = [], revoked = [], documentEvents = new Map(), windowEvents = new Map();
  let manifest = initialManifest, mapOptions, disconnected = 0;
  const client = {
    async gallery() { return manifest; },
    photoBlob(path) { requests.push(path); return blobLoader ? blobLoader(path) : Promise.resolve({ path }); },
    disconnect() { disconnected++; },
  };
  const map = {
    setGroups(groups) { mapSnapshots.push(groups); },
    focus() {}, fitPlan() {}, fitPhotos() {},
  };
  const document = {
    hidden: false, getElementById: element, createElement: tag => new Element('', tag),
    querySelectorAll: selector => { assert.equal(selector, '[data-filter]'); return filters; },
    addEventListener: (type, callback) => documentEvents.set(type, callback),
  };
  const context = vm.createContext({
    ...model, document,
    window: { addEventListener: (type, callback) => windowEvents.set(type, callback) },
    connect: async () => client,
    connectionErrorMessage: error => error.message,
    loadDeviceConnection: async () => ({ token: 'synthetic-device-key', revision: 'test' }),
    onDeviceForgotten: listener => { forgotten.push(listener); return () => {}; },
    createMemoryMap: async options => { mapOptions = options; return map; },
    URL: {
      createObjectURL(blob) { const url = `blob:synthetic-${created.length + 1}`; created.push({ url, blob }); return url; },
      revokeObjectURL(url) { revoked.push(url); },
    },
    Date, Intl, setInterval() {}, setTimeout, clearTimeout,
  });
  vm.runInContext(source, context, { filename: 'memories/app.mjs' });
  return {
    element, requests, created, revoked,
    get groups() { return mapSnapshots.at(-1); },
    get disconnected() { return disconnected; },
    async click(id) { element(id).click(); await flush(); },
    async selectList(name) {
      const button = buttons(element('photo-list')).find(item => item.textContent.includes(name));
      assert.ok(button, `Visible representative ${name} must be present`); button.click(); await flush();
    },
    async selectDuplicate(name) {
      const button = buttons(element('duplicate-photos')).find(item => item.dataset.photoId === name.replace(/\.jpg$/, ''));
      assert.ok(button, `Duplicate member ${name} must be accessible`); button.click(); await flush();
    },
    async filter(value) { filters.find(item => item.dataset.filter === value).click(); await flush(); },
    async refresh(next) { manifest = next; element('refresh').click(); await flush(); },
    async forget() { forgotten.forEach(listener => listener()); await flush(); },
    async selectPoint(id) { mapOptions.onSelect(id); await flush(); },
    async pagehide() { windowEvents.get('pagehide')?.({}); await flush(); },
  };
}

function metadata(f) {
  const children = f.element('detail-metadata').children;
  return Object.fromEntries(children.filter((_, index) => index % 2 === 0).map((term, index) => [term.textContent, children[index * 2 + 1].textContent]));
}

test('duplicate groups show one representative in list and map while keeping all originals intact', async () => {
  const photos = duplicateFixture(), before = JSON.stringify(photos), f = fixture(collection(photos));
  await flush();
  assert.equal(f.element('photo-list').children.length, 4);
  assert.equal(f.element('total-count').textContent, '4');
  assert.equal(f.groups.length, 1, 'Same point still combines its different views');
  assert.deepEqual(Array.from(f.groups[0].photos, photo => photo.id).sort(), ['original', 'other-view', 'without-hash']);
  assert.match(f.element('photo-list').textContent, /相同照片\s*3\s*张/);
  assert.ok(!f.element('photo-list').textContent.includes('stripped.jpg'));
  assert.ok(!f.element('photo-list').textContent.includes('metadata-copy.jpg'));
  assert.equal(JSON.stringify(photos), before, 'The manifest and source records must not be modified');
});

test('opening a duplicate group exposes each record and its own caption, upload time and coordinates', async () => {
  const f = fixture(collection(duplicateFixture())); await flush();
  await f.selectList('original.jpg');
  assert.equal(f.element('duplicate-section').hidden, false);
  assert.match(f.element('duplicate-title').textContent, /3/);
  assert.equal(buttons(f.element('duplicate-photos')).length, 3);
  assert.equal(buttons(f.element('point-photos')).length, 3, 'Three distinct pictures at this point remain navigable');
  await f.selectDuplicate('metadata-copy.jpg');
  assert.equal(f.element('detail-caption').textContent, 'caption-metadata-copy');
  assert.match(metadata(f)['上传时间'], /2026\/10\/4|2026-10-04/);
  assert.match(metadata(f)['拍摄坐标'], /44\.00000/);
  assert.equal(metadata(f)['定位来源'], '手动确认位置');
  assert.ok(f.requests.includes('records/derived/previews/metadata-copy.jpg'));
  assert.equal(f.element('photo-list').children.length, 4);
  await f.selectDuplicate('stripped.jpg');
  assert.equal(f.element('detail-caption').textContent, 'caption-stripped');
  assert.match(metadata(f)['拍摄坐标'], /待补充/);
  assert.equal(f.groups[0].photos.length, 3, 'Selecting a duplicate cannot create a new marker');
});

test('same-place independent photos and legacy entries without hashes remain separate', async () => {
  const f = fixture(collection(duplicateFixture())); await flush();
  await f.selectList('other-view.jpg');
  assert.equal(f.element('duplicate-section').hidden, true);
  assert.equal(buttons(f.element('point-photos')).length, 3);
  await f.selectList('without-hash.jpg');
  assert.equal(f.element('duplicate-section').hidden, true);
  await f.filter('unlocated');
  assert.equal(f.element('photo-list').children.length, 1, 'Only the separate unlocated photo remains; a located representative covers its unlocated duplicate');
  assert.match(f.element('photo-list').textContent, /unlocated\.jpg/);
});

test('switching groups revokes displayed previews and late previous results cannot replace current scenery', async () => {
  const pending = new Map(), f = fixture(collection(duplicateFixture()), {
    blobLoader(path) { const work = deferred(); if (!pending.has(path)) pending.set(path, []); pending.get(path).push(work); return work.promise; },
  }); await flush();
  await f.selectList('original.jpg');
  await f.selectList('other-view.jpg');
  pending.get('records/derived/previews/other-view.jpg').forEach(work => work.resolve({ path: 'current-photo' })); await flush();
  const activeURL = f.element('detail-image').src;
  for (const path of ['original', 'metadata-copy', 'stripped']) pending.get(`records/derived/previews/${path}.jpg`).forEach(work => work.resolve({ path: 'late-previous-photo' })); await flush();
  assert.equal(f.element('detail-image').src, activeURL);
  assert.ok(!f.created.some(item => item.blob.path === 'late-previous-photo'));
  await f.selectList('unlocated.jpg');
  assert.ok(f.revoked.includes(activeURL));
  await f.click('disconnect');
  pending.get('records/derived/previews/unlocated.jpg').forEach(work => work.resolve({ path: 'after-disconnect' })); await flush();
  assert.equal(f.element('detail-image').hidden, true);
  assert.ok(!f.created.some(item => item.blob.path === 'after-disconnect'));
  assert.equal(f.element('photo-list').children.length, 0);
  assert.equal(f.element('duplicate-photos').children.length, 0);
  assert.equal(f.groups.length, 0);
});

test('refresh preserves selection of an individual duplicate, then clears removed groups and all previews', async () => {
  const f = fixture(collection(duplicateFixture())); await flush();
  await f.selectList('original.jpg'); await f.selectDuplicate('metadata-copy.jpg');
  const oldURLs = f.created.map(item => item.url);
  const refreshed = duplicateFixture(); refreshed[2].caption = 'updated individual caption';
  await f.refresh(collection(refreshed, 2));
  assert.equal(f.element('detail-caption').textContent, 'updated individual caption');
  assert.equal(f.element('duplicate-section').hidden, false);
  await f.refresh(collection([photograph('new-only')], 3));
  assert.equal(f.element('detail-content').hidden, true);
  assert.equal(f.element('duplicate-photos').children.length, 0);
  assert.equal(f.element('photo-list').children.length, 1);
  for (const url of oldURLs) assert.ok(f.revoked.includes(url), 'The replaced private image URL must be revoked');
  await f.forget();
  assert.equal(f.element('duplicate-summary').textContent, '');
  assert.equal(f.element('photo-list').children.length, 0);
  assert.equal(f.element('detail-caption').textContent, '');
  for (const { url } of f.created) assert.ok(f.revoked.includes(url), 'No private preview remains after device credentials are forgotten');
});

test('a missing refreshed index clears duplicate group state instead of showing stale private details', async () => {
  const f = fixture(collection(duplicateFixture())); await flush();
  await f.selectList('original.jpg');
  await f.refresh(null);
  assert.equal(f.element('detail-content').hidden, true);
  assert.equal(f.element('photo-list').children.length, 0);
  assert.equal(f.element('duplicate-photos').children.length, 0);
  assert.equal(f.groups.length, 0);
  for (const { url } of f.created) assert.ok(f.revoked.includes(url));
});

test('large groups reveal every duplicate in pages without reloading existing group previews', async () => {
  const photos = Array.from({ length: 15 }, (_, index) => photograph(`copy-${String(index).padStart(2, '0')}`, { contentHash: hash('a'), location }));
  const f = fixture(collection(photos)); await flush();
  assert.equal(f.element('photo-list').children.length, 1);
  await f.selectList('copy-00.jpg');
  assert.equal(buttons(f.element('duplicate-photos')).length, 12);
  assert.equal(f.element('duplicate-more').hidden, false);
  await f.click('duplicate-more');
  assert.equal(buttons(f.element('duplicate-photos')).length, 15);
  assert.equal(f.element('duplicate-more').hidden, true);
  const previousRequests = f.requests.length;
  await f.selectDuplicate('copy-14.jpg');
  assert.equal(f.requests.length, previousRequests + 1, 'Member selection only loads the main image, not every thumbnail again');
  assert.equal(f.element('detail-caption').textContent, 'caption-copy-14');
  assert.equal(buttons(f.element('photo-list'))[0].getAttribute('aria-pressed'), 'true', 'Representative remains selected while inspecting another member');
  assert.equal(buttons(f.element('duplicate-photos')).filter(button => button.getAttribute('aria-pressed') === 'true').length, 1);
  await f.pagehide();
  for (const { url } of f.created) assert.ok(f.revoked.includes(url), 'Leaving the page revokes both scenery and duplicate thumbnail URLs');
});

test('authentication loss during duplicate previews clears every photo and rejects late sibling responses', async () => {
  const requests = [], f = fixture(collection(duplicateFixture()), {
    blobLoader(path) { const work = deferred(); requests.push({ path, ...work }); return work.promise; },
  }); await flush();
  await f.selectList('original.jpg');
  assert.equal(requests.length, 4, 'Three duplicate thumbnails and one selected scenery request begin');
  const denied = new Error('Expired test connection'); denied.code = 'AUTH';
  requests[0].reject(denied); await flush();
  for (const request of requests.slice(1)) request.resolve({ path: 'late-private-photo' });
  await flush();
  assert.equal(f.disconnected, 1);
  assert.equal(f.element('photo-list').children.length, 0);
  assert.equal(f.element('duplicate-photos').children.length, 0);
  assert.equal(f.element('detail-image').hidden, true);
  assert.equal(f.groups.length, 0);
  assert.equal(f.created.length, 0, 'A private preview must never appear after authorization has failed');
});
