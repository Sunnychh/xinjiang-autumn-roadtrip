import { connect, connectionErrorMessage } from '../upload/github.mjs?v=20261003-memories';
import { loadDeviceConnection, onDeviceForgotten } from '../upload/device-credential.mjs';
import { photoGroups, photoTime, photoTitle, visiblePhotos, orderedPhotos, validLocation, coordinateText, locationSource, timeSource, issueText } from './model.mjs';
import { createMemoryMap } from './map.mjs';

const $ = id => document.getElementById(id);
let client = null, generation = 0, detailGeneration = 0, refreshing = false, connected = false;
let photos = [], groups = [], filter = 'all', shown = 80, selectedId = null, fingerprint = null;
let map = null, imageURL = null, autoRestore = true;
const setConnection = (text, state = '') => { $('connection-status').textContent = text; $('connection-status').dataset.state = state; };
function clearImage() {
  $('detail-image').hidden = true; $('detail-image').removeAttribute('src'); $('detail-image').alt = '';
  $('detail-image').onload = null; $('detail-image').onerror = null;
  if (imageURL) URL.revokeObjectURL(imageURL);
  imageURL = null;
}
function disconnect(message = '照片已关闭。重新打开此页可恢复已保存的连接。') {
  generation++; detailGeneration++; client?.disconnect(); client = null; connected = false; refreshing = false;
  clearImage(); photos = []; groups = []; selectedId = null; fingerprint = null;
  map?.setGroups([]); $('detail-content').hidden = true; $('detail-empty').hidden = false;
  $('detail-title').textContent = ''; $('detail-caption').textContent = ''; $('detail-metadata').replaceChildren(); $('point-photos').replaceChildren();
  $('load-original').onclick = null; $('load-original').hidden = true; $('image-status').textContent = '';
  $('photo-list').replaceChildren(); $('index-status').textContent = ''; $('list-count').textContent = '';
  for (const id of ['total-count', 'located-count', 'unlocated-count']) $(id).textContent = '—';
  $('refresh').disabled = true; $('fit-photos').disabled = true; $('disconnect').hidden = true; $('connect-link').hidden = false;
  $('show-more').hidden = true; $('list-empty').hidden = false; $('list-empty').textContent = '连接照片库后，上传的照片会出现在这里。';
  setConnection(message);
}
function renderList() {
  const filtered = visiblePhotos(photos, filter);
  $('list-count').textContent = `${filtered.length} 张`;
  $('list-empty').hidden = filtered.length > 0;
  $('list-empty').textContent = !photos.length ? '还没有已解析的照片。上传后，自动整理完成时会出现在这里。'
    : filter === 'unlocated' ? '目前没有待补充位置的照片。' : '当前筛选下还没有照片。';
  $('photo-list').replaceChildren();
  for (const [index, photo] of filtered.slice(0, shown).entries()) {
    const li = document.createElement('li'), button = document.createElement('button');
    button.type = 'button'; button.setAttribute('aria-pressed', String(photo.id === selectedId));
    const number = document.createElement('span'); number.className = 'list-number'; number.textContent = String(index + 1).padStart(2, '0');
    const copy = document.createElement('span'); copy.className = 'list-copy';
    const title = document.createElement('strong'); title.textContent = photoTitle(photo, index);
    const meta = document.createElement('small'); meta.textContent = `${validLocation(photo.location) ? (photo.location.source === 'manual' ? '手动确认位置' : 'GPS 拍摄点') : '待补充位置'} · ${photoTime(photo)}`;
    copy.append(title, meta);
    if (photo.caption) { const caption = document.createElement('small'); caption.className = 'list-caption'; caption.textContent = photo.caption; copy.append(caption); }
    button.append(number, copy); button.addEventListener('click', () => selectPhoto(photo.id, { focus: true })); li.append(button); $('photo-list').append(li);
  }
  $('show-more').hidden = filtered.length <= shown;
}
function addMetadata(label, value) {
  const term = document.createElement('dt'), description = document.createElement('dd');
  term.textContent = label; description.textContent = value; $('detail-metadata').append(term, description);
}
async function loadImage(photo, original, currentDetail) {
  const current = generation, active = client;
  if (!active) return;
  clearImage(); $('load-original').hidden = true;
  $('image-status').textContent = original ? '正在读取私有原图…' : '正在读取私有照片…';
  const path = !original && photo.thumbnailPath ? photo.thumbnailPath : photo.photoPath;
  try {
    const blob = await active.photoBlob(path, { maxBytes: original || !photo.thumbnailPath ? 20 * 1024 * 1024 : 3 * 1024 * 1024 });
    if (current !== generation || currentDetail !== detailGeneration || active !== client) return;
    imageURL = URL.createObjectURL(blob);
    const image = $('detail-image');
    image.onload = () => { if (currentDetail === detailGeneration) $('image-status').textContent = ''; };
    image.onerror = () => { if (currentDetail === detailGeneration) { image.hidden = true; $('image-status').textContent = '当前浏览器无法预览此图片格式。原图仍保存在私有照片库中。'; } };
    image.alt = photo.caption || photoTitle(photo); image.src = imageURL; image.hidden = false;
    $('load-original').hidden = original || !photo.thumbnailPath;
  } catch (error) {
    if (current !== generation || currentDetail !== detailGeneration) return;
    if (error.code === 'AUTH' || error.code === 'PRIVATE') { disconnect('照片库连接已失效，请重新连接。'); return; }
    $('image-status').textContent = '照片暂未加载，请重新选择此照片重试。';
    $('load-original').hidden = original || !photo.thumbnailPath;
  }
}
function selectPhoto(id, { focus = false } = {}) {
  const photo = photos.find(item => item.id === id);
  if (!photo || !client) return;
  selectedId = photo.id; const currentDetail = ++detailGeneration;
  $('detail-empty').hidden = true; $('detail-content').hidden = false;
  $('detail-title').textContent = photoTitle(photo);
  $('detail-position').textContent = validLocation(photo.location) ? (photo.location.source === 'manual' ? '手动确认的拍摄点' : '照片里的 GPS 拍摄点') : '位置待补充';
  $('detail-caption').textContent = photo.caption || '这一刻，还没有附言。';
  $('detail-metadata').replaceChildren();
  addMetadata('拍摄时间', photoTime(photo));
  addMetadata('时间来源', timeSource(photo));
  addMetadata('拍摄坐标', coordinateText(photo));
  addMetadata('定位来源', locationSource(photo));
  addMetadata('上传时间', photo.uploadedAt ? new Date(photo.uploadedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) + '（北京时间）' : '未记录');
  addMetadata('原文件名', photo.originalName || '未记录');
  if (photo.issues?.length) addMetadata('整理提示', photo.issues.map(issueText).join('；'));
  const group = groups.find(item => item.photos.some(candidate => candidate.id === id));
  $('point-photos').replaceChildren(); $('point-photos').hidden = !group || group.photos.length < 2;
  if (group?.photos.length > 1) for (const [index, item] of group.photos.entries()) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = `照片 ${index + 1}`; button.setAttribute('aria-pressed', String(item.id === id)); button.addEventListener('click', () => selectPhoto(item.id)); $('point-photos').append(button);
  }
  renderList();
  if (focus && validLocation(photo.location)) map?.focus(photo.location);
  $('load-original').onclick = () => loadImage(photo, true, currentDetail);
  loadImage(photo, false, currentDetail);
}
async function refreshIndex() {
  if (refreshing || !client || document.hidden) return;
  const current = generation, active = client; refreshing = true; $('refresh').disabled = true;
  try {
    const manifest = await active.gallery();
    if (current !== generation || active !== client) return;
    if (!manifest) {
      $('index-status').textContent = '照片正在等待自动整理；此页会每分钟检查一次。'; setConnection('照片库已连接。');
      photos = []; groups = []; fingerprint = null; selectedId = null; detailGeneration++; clearImage();
      $('detail-content').hidden = true; $('detail-empty').hidden = false; $('fit-photos').disabled = true;
      map?.setGroups([]); renderList();
      for (const id of ['total-count', 'located-count', 'unlocated-count']) $(id).textContent = '0';
      return;
    }
    const nextFingerprint = `${manifest.generatedAt}:${manifest.sourceCommit}:${manifest.snapshotCommit || ''}`;
    $('index-status').textContent = `整理于 ${new Date(manifest.generatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })} · 前台每分钟更新`;
    setConnection('已连接私密照片库。');
    if (nextFingerprint === fingerprint) return;
    fingerprint = nextFingerprint; photos = orderedPhotos(manifest.photos); groups = photoGroups(photos);
    $('total-count').textContent = String(photos.length);
    const located = photos.filter(photo => validLocation(photo.location)).length;
    $('located-count').textContent = String(located); $('unlocated-count').textContent = String(photos.length - located);
    $('fit-photos').disabled = !groups.length; map?.setGroups(groups); renderList();
    if (selectedId && photos.some(photo => photo.id === selectedId)) selectPhoto(selectedId);
    else { detailGeneration++; clearImage(); selectedId = null; $('detail-content').hidden = true; $('detail-empty').hidden = false; }
  } catch (error) {
    if (current !== generation) return;
    if (error.code === 'AUTH' || error.code === 'PRIVATE') { disconnect('照片库连接已失效，请到上传页面重新连接。'); return; }
    setConnection('暂未获取到最新照片；已显示的内容会保留，请稍后刷新。', 'error');
  } finally { if (current === generation) { refreshing = false; $('refresh').disabled = !connected; } }
}
async function restore() {
  if (!autoRestore || document.hidden) return;
  const current = ++generation;
  setConnection('正在连接此设备上的照片库…');
  let snapshot;
  try {
    snapshot = await loadDeviceConnection();
    if (current !== generation) return;
    if (!snapshot.token) { disconnect('此设备还未连接照片库。请先在上传页面连接并勾选“记住此设备”。'); return; }
    const next = await connect(snapshot.token); snapshot.token = null;
    if (current !== generation) { next.disconnect(); return; }
    client?.disconnect(); client = next; connected = true; $('disconnect').hidden = false; $('connect-link').hidden = true; $('refresh').disabled = false;
    await refreshIndex();
  } catch (error) {
    if (current !== generation) return;
    disconnect(error.name === 'DeviceStorageError' ? '无法读取此设备的连接。请到上传页面重新连接并记住此设备。' : connectionErrorMessage(error));
  } finally { if (snapshot) snapshot.token = null; }
}
$('refresh').addEventListener('click', refreshIndex);
$('disconnect').addEventListener('click', () => { autoRestore = false; disconnect(); });
$('fit-plan').addEventListener('click', () => map?.fitPlan());
$('fit-photos').addEventListener('click', () => map?.fitPhotos());
$('show-more').addEventListener('click', () => { shown += 80; renderList(); });
for (const button of document.querySelectorAll('[data-filter]')) button.addEventListener('click', () => {
  filter = button.dataset.filter; shown = 80;
  for (const item of document.querySelectorAll('[data-filter]')) item.setAttribute('aria-pressed', String(item === button)); renderList();
});
onDeviceForgotten(() => { autoRestore = false; disconnect('此设备的照片库连接已被清除。'); });
window.addEventListener('pagehide', () => disconnect('照片已关闭。'));
window.addEventListener('pageshow', event => { if (event.persisted) restore(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) { if (client) refreshIndex(); else if (autoRestore) restore(); } });
setInterval(() => { if (!document.hidden) refreshIndex(); }, 60000);
createMemoryMap({ container: $('memory-map'), status: (text, state = '') => { $('map-status').textContent = text; $('map-status').dataset.state = state; }, onSelect: id => {
  const group = groups.find(item => item.id === id); if (group) { selectPhoto(group.photos[0].id); $('detail-content').scrollIntoView({ block: 'nearest', behavior: 'auto' }); }
} }).then(value => { map = value; map.setGroups(groups); }).catch(() => { $('map-status').textContent = '中文地图暂未加载，请刷新或检查网络。下方照片列表仍可查看。'; $('map-status').dataset.state = 'error'; });
restore();
