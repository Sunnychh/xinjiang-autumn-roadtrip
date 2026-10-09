import { PhotoError, connect, connectionErrorMessage, probeGitHub } from './github.mjs?v=20261009-background';
import { PhotoQueue } from './queue.mjs?v=20261009-background';
import { loadDeviceConnection, getDeviceRevision, rememberDeviceToken, forgetDeviceToken, onDeviceForgotten } from './device-credential.mjs';

import { supportsPendingUploads, loadPendingBatch, savePendingBatch, clearPendingBatch, withUploadLock } from './pending-store.mjs?v=20261009-background';

const $ = id => document.getElementById(id);
const queue = new PhotoQueue();
const previewUrls = new Map();
const cardNodes = new Map();
const batchSelected = new Set();
let renderedQueueIds = [];
let selectedId = null;
const inputs = [$('photo-library'),$('photo-camera')];
let client = null, connecting = false, busy = false, checkingNetwork = false, connectionGeneration = 0;
let deviceBusy = false, remembered = false, storageQueue = Promise.resolve();
let clientRevision = null, autoRestoreAllowed = true;
let pendingBatch = null, pendingSaved = false, initializing = true, resumeWanted = false, retryCount = 0, retryTimer = null;
let workerRegistration = null, wakeLock = null, wakeGeneration = 0, currentPageOnly = false;
const nav = globalThis.navigator;
const isVisible = () => document.visibilityState !== 'hidden';
const durableAvailable = () => supportsPendingUploads() && !currentPageOnly;
const selectedPhoto = () => queue.items.find(item => item.id === selectedId);
const hasUncertain = () => queue.uncertain;
const canEditCaption = item => !pendingBatch && !item.prepared && !item.receipt && !item.uncertain;
const captionControlsLocked = () => !client || connecting || deviceBusy || busy || !!pendingBatch;

function setStatus(id,message,state='') { $(id).textContent=message; $(id).dataset.state=state; }
function deviceOperation(operation) {
 const result=storageQueue.then(()=>operation());
 storageQueue=result.catch(()=>{});
 return result;
}
function update() {
 const unavailable = !client || connecting || deviceBusy || initializing;
 const item=selectedPhoto(), locked=busy || unavailable;
 $('connect-form').hidden=!!client;
 $('connected-user').hidden=!client;
 $('github-token').disabled=connecting || busy || deviceBusy;
 $('remember-device').disabled=connecting || busy || deviceBusy;
 $('connect-button').disabled=connecting || busy || deviceBusy;
 $('connect-button').textContent=connecting?'正在连接…':'连接照片库';
 $('connect-form').setAttribute('aria-busy',String(connecting));
 $('retry-connection').hidden=!!client || !remembered;
 $('retry-connection').disabled=connecting || busy || deviceBusy;
 $('forget-device').hidden=!client && !remembered && !deviceBusy;
 $('forget-device').disabled=busy || connecting || deviceBusy;
 $('forget-device').textContent=deviceBusy?'正在清除…':'忘记此设备';
 $('network-check').disabled=busy || connecting || deviceBusy || checkingNetwork;
 $('network-check').textContent=checkingNetwork?'正在检测…':'检测网络连接';
 $('upload-fields').disabled=unavailable;
 $('upload-submit').disabled=unavailable || busy || !queue.pending;
 $('upload-submit').textContent=busy?'正在依次保存…':hasUncertain()?'核对并继续上传':queue.pending?`保存 ${queue.pending} 张照片 ↗`:'保存照片 ↗';
 ['choose-photo','take-photo'].forEach(id=>{$(id).disabled=locked || hasUncertain() || !!pendingBatch;});
 inputs.forEach(input=>{input.disabled=locked || hasUncertain() || !!pendingBatch;});
 $('upload-form').setAttribute('aria-busy',String(busy));
 $('photo-info').hidden=!item;
 $('photo-empty').hidden=!!item;
 $('photo-preview').hidden=!item;
 $('upload-form').hidden=queue.complete;
 $('upload-receipt').hidden=!queue.complete;
 renderQueue(locked);
 if(queue.complete) renderReceipt();
 updateBackgroundStatus();
}
function disconnectClient() {
 connectionGeneration++;
 queue.interrupt();
 if(client) client.disconnect();
 client=null; clientRevision=null; connecting=false; checkingNetwork=false; deviceBusy=false;
 $('github-token').value='';
 $('upload-progress-wrap').hidden=true;
 setStatus('network-status','');
}
function authenticationError(error) { return error?.status===401 || error?.code==='AUTH' || error?.code==='AUTH_REQUIRED'; }
function connectionError(error) {
 if(authenticationError(error)) return '连接密钥无效或已过期，请重新输入。';
 if(error instanceof PhotoError && ['PERMISSION','ACCOUNT','PRIVATE','CONFIG','INVALID'].includes(error.code)) return '无法连接照片库，请检查密钥是否有此私有照片库的读写权限。';
 if(error?.code==='NETWORK') return '当前无法访问照片库。请检查网络，或点击“检测网络连接”后重试。';
 if(error?.code==='TIMEOUT') return '照片库响应超时，请稍后重试。';
 return connectionErrorMessage(error);
}
$('network-check').addEventListener('click',async()=>{
 if(checkingNetwork || busy || connecting || deviceBusy) return;
 const generation=connectionGeneration;
 checkingNetwork=true; setStatus('network-status','正在检查当前设备能否连接 GitHub API…'); update();
 try {
  await probeGitHub();
  if(generation!==connectionGeneration) return;
  setStatus('network-status','网络连接正常。照片库连接失败时，可以再试一次。','success');
 } catch(error) {
  if(generation===connectionGeneration) setStatus('network-status',
   error instanceof PhotoError && error.code==='PERMISSION'
    ? `GitHub 网络检测接口返回 HTTP ${error.status}，暂时无法完成检测；这不代表照片库密钥无效。`
    : connectionError(error),'error');
 }
 finally { if(generation===connectionGeneration) { checkingNetwork=false; update(); } }
});
function beginConnection(message='正在连接照片库…') {
 const generation=++connectionGeneration;
 checkingNetwork=false; connecting=true;
 setStatus('network-status',''); setStatus('connection-status',message); update();
 return generation;
}
async function clearExpiredCredential(generation,revision) {
 if(revision===null) {
  if(generation===connectionGeneration) setStatus('connection-status','连接密钥无效或已过期，请重新输入。','error');
  return;
 }
 let removed=false;
 try { removed=await deviceOperation(()=>forgetDeviceToken({expectedRevision:revision})); } catch {}
 if(generation!==connectionGeneration) return;
 remembered=!removed;
 setStatus('connection-status',removed?'连接密钥无效或已过期，请重新输入。':'连接密钥无效或已过期，请重新输入。此设备保存的信息暂未清除，可点击“忘记此设备”重试。','error');
}
async function connectToken(token,{remember=false,fromStorage=false,generation,revision=null}) {
 let next=null;
 try {
  next=await connect(token,{onProgress(stage){
   if(generation!==connectionGeneration) return;
   const labels={identity:'正在验证照片库连接…',repository:'正在检查照片库…',branch:'正在准备上传…'};
   setStatus('connection-status',labels[stage] || '正在连接…');
  }});
  if(generation!==connectionGeneration) return;
  if(queue.items.some(item=>item.uncertain && item.owner && String(next.user.id)!==String(item.owner.id))) {
   setStatus('connection-status','上次上传尚未确认，请用原照片库账号的密钥连接后核对。','error');
   return;
  }
  let storageFailed=!fromStorage && revision===null;
  if(!fromStorage && revision!==null) {
   try {
    const stored=await deviceOperation(async()=>{
     if(generation!==connectionGeneration) return false;
     if(remember) revision=await rememberDeviceToken(token,{expectedRevision:revision});
     else {
      if(!await forgetDeviceToken({expectedRevision:revision})) return false;
      revision=null;
     }
     return true;
    });
    if(generation!==connectionGeneration) return;
    if(stored) remembered=remember;
    else { storageFailed=true; revision=null; }
   } catch { storageFailed=true; revision=null; }
  }
  if(generation!==connectionGeneration) return;
  client=next; clientRevision=revision; next=null;
  const message=hasUncertain()?'已重新连接，可继续核对上次上传。':'照片库已连接，可以上传。';
  setStatus('connection-status',storageFailed?message+(remember?'但此设备未能记住本次连接，下次可能需要重新输入。':'但未能清除此设备之前保存的连接，请点击“忘记此设备”重试。'):message+(remembered?' 此设备会自动连接。':''),storageFailed?'notice':'success');
 } catch(error) {
  if(generation!==connectionGeneration) return;
  if(authenticationError(error)) await clearExpiredCredential(generation,revision);
  else setStatus('connection-status',connectionError(error),'error');
 } finally {
  if(next) next.disconnect();
  token='';
  if(generation===connectionGeneration) { connecting=false; update(); maybeResume(); }
 }
}
async function restoreDeviceConnection() {
 if(connecting || busy || client || deviceBusy) return;
 const generation=beginConnection('正在读取此设备的连接…');
 let token='';
 try {
  const snapshot=await deviceOperation(loadDeviceConnection);
  if(generation!==connectionGeneration) return;
  token=snapshot.token;
  remembered=!!token;
  if(!token) { setStatus('connection-status','首次输入连接密钥后即可上传。'); return; }
  const connection=connectToken(token,{fromStorage:true,generation,revision:snapshot.revision}); token='';
  await connection;
 } catch {
  if(generation===connectionGeneration) {
   remembered=true;
   setStatus('connection-status','此设备暂时无法读取已保存的连接，请重新输入。','notice');
  }
 } finally { token=''; if(generation===connectionGeneration) { connecting=false; update(); } }
}
$('connect-form').addEventListener('submit',async event=>{
 event.preventDefault();
 if(connecting || busy || client || deviceBusy) return;
 let token=$('github-token').value.trim(); $('github-token').value='';
 if(!token) { setStatus('connection-status','请先输入照片库连接密钥。','error'); $('github-token').focus(); return; }
 autoRestoreAllowed=true;
 const remember=$('remember-device').checked;
 const generation=beginConnection();
 let revision=null;
 try { revision=await deviceOperation(getDeviceRevision); } catch {}
 if(generation!==connectionGeneration) { token=''; return; }
 const connection=connectToken(token,{remember,generation,revision}); token='';
 await connection;
});
$('retry-connection').addEventListener('click',()=>{autoRestoreAllowed=true;void restoreDeviceConnection();});
$('forget-device').addEventListener('click',async()=>{
 if(busy || deviceBusy) return;
 disconnectClient();
 autoRestoreAllowed=false; resumeWanted=false; clearTimeout(retryTimer); releaseWakeLock();
 const generation=connectionGeneration;
 deviceBusy=true; setStatus('connection-status','正在清除此设备保存的连接…'); update();
 try {
  const removed=await deviceOperation(forgetDeviceToken);
  if(generation!==connectionGeneration) return;
  if(removed!==true) throw new Error('Device connection was not removed');
  remembered=false;
  if(!hasUncertain() && !pendingBatch) reset();
  setStatus('connection-status',hasUncertain()?'已忘记此设备。上次上传尚未确认，请重新输入原照片库的密钥后核对。':'已忘记此设备，下次连接时需重新输入密钥。','success');
 } catch {
  if(generation===connectionGeneration) {
   remembered=true;
   setStatus('connection-status','未能清除此设备保存的连接，请重试。','error');
  }
 } finally { if(generation===connectionGeneration) { deviceBusy=false; update(); } }
});
onDeviceForgotten(()=>{
 disconnectClient();
 busy=false; remembered=false; autoRestoreAllowed=false; resumeWanted=false; clearTimeout(retryTimer); releaseWakeLock();
 setStatus('connection-status','此设备的连接已在其他页面清除。需要上传时，请重新输入连接密钥。');
 update();
});
function previewFor(item) {
 if(!item.file || typeof item.file.arrayBuffer !== 'function') return null;
 if(!previewUrls.has(item.id)) previewUrls.set(item.id,URL.createObjectURL(item.file));
 return previewUrls.get(item.id);
}
function selectItem(id) {
 selectedId=id;
 const item=selectedPhoto();
 $('preview-image').removeAttribute('src');
 if(item) {
  $('photo-name').textContent=item.fileName || item.nameBase || item.file.name;
  $('photo-size').textContent=(item.file.size/1024/1024).toLocaleString('zh-CN',{maximumFractionDigits:2})+' MB';
  $('preview-image').hidden=false; $('preview-fallback').hidden=true;
  const preview=previewFor(item);
  if(preview) $('preview-image').src=preview; else { $('preview-image').hidden=true; $('preview-fallback').hidden=false; }
 }
 update();
}
const statusLabels={pending:'待上传',preparing:'检查原图',uploading:'正在保存',saved:'已保存',invalid:'未通过校验',failed:'待重试',uncertain:'待核对'};
function removeItem(id) {
 if(pendingBatch) { void removePersistedItem(id); return; }
 if(busy || !client || connecting || deviceBusy || !queue.remove(id)) return;
 if(previewUrls.has(id)) URL.revokeObjectURL(previewUrls.get(id));
 previewUrls.delete(id);
 if(selectedId===id) selectItem(queue.items.find(item=>!item.receipt)?.id || queue.items[0]?.id || null);
 else update();
}
function createPhotoCard(item) {
 const row=document.createElement('li'); row.className='photo-card';
 const selectLabel=document.createElement('label'); selectLabel.className='photo-select-label';
 const select=document.createElement('input'); select.type='checkbox'; select.id=`batch-select-${item.id}`; select.className='batch-photo-select';
 const selectText=document.createElement('span'); selectText.textContent='选中这张照片';
 selectLabel.append(select,selectText);
 select.addEventListener('change',()=>{
  if(captionControlsLocked() || !canEditCaption(item)) { update(); return; }
  if(select.checked) batchSelected.add(item.id); else batchSelected.delete(item.id);
  setStatus('bulk-status',''); update();
 });
 const button=document.createElement('button'); button.type='button'; button.className='queue-item';
 const thumb=document.createElement('img'); const preview=previewFor(item); if(preview) thumb.src=preview; else thumb.hidden=true; thumb.alt=''; thumb.loading='lazy';
 thumb.addEventListener('error',()=>{thumb.hidden=true;});
 const details=document.createElement('span'); details.className='queue-details';
 const name=document.createElement('strong');
 const original=document.createElement('small'); original.className='photo-original-name';
 original.textContent=`原文件：${item.file.name}`;
 const state=document.createElement('span'); state.className='queue-state';
 details.append(name,original,state); button.append(thumb,details);
 button.addEventListener('click',()=>{if(!busy) selectItem(item.id);});
 const editor=document.createElement('div'); editor.className='photo-card-editor';
 const label=document.createElement('label'); label.htmlFor=`photo-caption-${item.id}`;
 const caption=document.createElement('textarea'); caption.id=`photo-caption-${item.id}`;
 caption.className='photo-card-caption'; caption.rows=2; caption.maxLength=4000;
 caption.placeholder='记录这张照片的地点、心情或故事，也可以留空。';
 const footer=document.createElement('div'); footer.className='photo-card-footer';
 const counter=document.createElement('span'); counter.id=`caption-counter-${item.id}`; counter.className='caption-counter';
 caption.setAttribute('aria-describedby',counter.id);
 const remove=document.createElement('button'); remove.type='button'; remove.className='text-button remove-card-photo'; remove.textContent='移除照片';
 remove.addEventListener('click',()=>removeItem(item.id));
 caption.addEventListener('input',()=>{
  if(!client || connecting || deviceBusy || busy || pendingBatch || item.prepared || item.receipt || item.uncertain) return;
  item.caption=caption.value;
  counter.textContent=item.caption.length.toLocaleString('zh-CN')+' / 4,000';
  state.textContent=(statusLabels[item.status] || '待上传')+(item.caption?' · 有附言':'')+(item.error?` · ${item.error}`:'');
 });
 footer.append(counter,remove); editor.append(label,caption,footer); row.append(selectLabel,button,editor);
 return {row,select,button,name,state,label,caption,counter,remove};
}
function renderQueue(locked) {
 const counts={saved:0,invalid:0};
 queue.items.forEach(item=>{if(item.status in counts) counts[item.status]++;});
 $('queue-summary').textContent=queue.items.length?`共 ${queue.items.length} 张 · 已保存 ${counts.saved} 张 · 待传 ${queue.pending} 张${counts.invalid?` · 未通过 ${counts.invalid} 张`:''}`:'';
 $('photo-details').hidden=!queue.items.length;
 const ids=queue.items.map(item=>item.id), rows=[];
 const eligibleIds=new Set(queue.items.filter(canEditCaption).map(item=>item.id));
 for(const id of batchSelected) if(!eligibleIds.has(id)) batchSelected.delete(id);
 for(const id of cardNodes.keys()) if(!ids.includes(id)) cardNodes.delete(id);
 queue.items.forEach((item,index)=>{
  if(!cardNodes.has(item.id)) cardNodes.set(item.id,createPhotoCard(item));
  const card=cardNodes.get(item.id);
  card.select.disabled=locked || !canEditCaption(item);
  card.select.checked=batchSelected.has(item.id);
  card.select.setAttribute('aria-label',`选择第 ${index+1} 张照片共用附言`);
  card.row.dataset.batchSelected=String(card.select.checked);
  card.button.disabled=locked;
  card.button.setAttribute('aria-pressed',String(item.id===selectedId));
  card.button.setAttribute('aria-label',`预览第 ${index+1} 张照片：${item.fileName || item.nameBase || item.file.name}`);
  card.button.dataset.state=item.status;
  card.name.textContent=item.fileName || item.nameBase || item.file.name;
  card.state.textContent=(statusLabels[item.status] || '待上传')+(item.caption?' · 有附言':'')+(item.error?` · ${item.error}`:'');
  card.label.textContent=`第 ${index+1} 张照片的附言（选填）`;
  card.caption.disabled=locked || !!pendingBatch || !!item.prepared || !!item.receipt || item.uncertain;
  if(card.caption.value!==item.caption) card.caption.value=item.caption;
  card.counter.textContent=item.caption.length.toLocaleString('zh-CN')+' / 4,000';
  card.remove.disabled=locked || !!item.prepared || !!item.receipt || item.uncertain;
  card.remove.setAttribute('aria-label',`移除第 ${index+1} 张照片`);
  rows.push(card.row);
 });
 // Keep each editor node in place while state changes, preserving focus and
 // the phone keyboard. Rebuild the list only when photos are added or removed.
 if(ids.length!==renderedQueueIds.length || ids.some((id,index)=>id!==renderedQueueIds[index])) {
  $('photo-queue').replaceChildren(...rows); renderedQueueIds=ids;
 }
 updateBulkControls();
 const selected=selectedPhoto();
 if(selected) $('photo-name').textContent=selected.fileName || selected.nameBase || selected.file.name;
}
function updateBulkControls() {
 const eligible=queue.items.filter(canEditCaption);
 const selected=eligible.filter(item=>batchSelected.has(item.id));
 const locked=captionControlsLocked(), value=$('bulk-caption').value;
 $('bulk-selection-count').textContent=`已选 ${selected.length} / ${eligible.length} 张可编辑照片`;
 $('bulk-select-all').disabled=locked || !eligible.length;
 $('bulk-select-all').checked=eligible.length>0 && selected.length===eligible.length;
 $('bulk-select-all').indeterminate=selected.length>0 && selected.length<eligible.length;
 $('bulk-caption').disabled=locked || !eligible.length;
 $('bulk-caption-counter').textContent=value.length.toLocaleString('zh-CN')+' / 4,000';
 $('bulk-apply').disabled=locked || !selected.length || !value.trim() || value.length>4000;
 $('bulk-apply').textContent=selected.length?`应用到所选 ${selected.length} 张`:'应用到所选照片';
}
$('bulk-select-all').addEventListener('change',()=>{
 if(captionControlsLocked()) { update(); return; }
 const checked=$('bulk-select-all').checked;
 for(const item of queue.items) {
  if(checked && canEditCaption(item)) batchSelected.add(item.id); else batchSelected.delete(item.id);
 }
 setStatus('bulk-status',''); update();
});
$('bulk-caption').addEventListener('input',()=>{
 setStatus('bulk-status',''); updateBulkControls();
});
$('bulk-apply').addEventListener('click',()=>{
 if(captionControlsLocked()) return;
 const value=$('bulk-caption').value;
 if(!value.trim() || value.length>4000) return;
 const selected=queue.items.filter(item=>batchSelected.has(item.id) && canEditCaption(item));
 if(!selected.length) return;
 for(const item of selected) item.caption=value;
 update();
 setStatus('bulk-status',`已将附言填写到 ${selected.length} 张照片，可在下方逐张修改。`,'success');
});
function reset() {
 if(!queue.clear()) return;
 resumeWanted=false; clearTimeout(retryTimer); currentPageOnly=false;
 $('upload-current-page').hidden=true; setStatus('pending-storage-status','');
 for(const url of previewUrls.values()) URL.revokeObjectURL(url);
 previewUrls.clear(); selectedId=null; batchSelected.clear();
 $('bulk-caption').value=''; setStatus('bulk-status','');
 $('preview-image').removeAttribute('src');
 inputs.forEach(input=>{input.value='';});
 $('upload-progress-wrap').hidden=true;
 setStatus('photo-error',''); setStatus('upload-status',''); update();
}
function choose(files) {
 if(!client || connecting || deviceBusy || busy || pendingBatch || hasUncertain() || !files?.length) return;
 // Browser MIME metadata is inconsistent for JPG and phone exports. Check the
 // actual bytes during prepare(), instead of rejecting a valid filename here.
 const {added,errors}=queue.add(Array.from(files));
 setStatus('photo-error',errors.map(({file,error})=>`${file.name}：${error.message}`).join('；'),errors.length?'error':'');
 setStatus('upload-status','');
 if(added.length) selectItem(added[0].id); else update();
}
$('preview-image').addEventListener('error',()=>{if(selectedPhoto()){$('preview-image').hidden=true;$('preview-fallback').hidden=false;}});
$('choose-photo').addEventListener('click',()=>$('photo-library').click());
$('take-photo').addEventListener('click',()=>$('photo-camera').click());
inputs.forEach(input=>input.addEventListener('change',()=>{choose(input.files);input.value='';}));
$('upload-next').addEventListener('click',()=>{reset();$('choose-photo').focus();});
function setProgress(item,{percent,label}) {
 $('upload-progress-wrap').hidden=false;
 const saved=queue.items.filter(photo=>photo.receipt).length;
 $('upload-progress-label').textContent=`第 ${queue.items.indexOf(item)+1} / ${queue.items.length} 张 · ${label || '正在保存照片…'}`;
 $('upload-progress-value').textContent=`已保存 ${saved} 张`;
 if(Number.isFinite(percent)) $('upload-progress').value=Math.max(0,Math.min(100,(saved+percent/100)/queue.items.length*100));
 else $('upload-progress').removeAttribute('value');
}
function renderReceipt() {
 $('receipt-title').textContent=`${queue.items.length} 张照片已保存`;
 $('receipt-file').textContent=queue.items.map(item=>item.receipt?.record.fileName || item.fileName || item.file.name).join(' · ');
 $('receipt-time').textContent='已确认原图与附言保存成功';
 const caption=queue.items.filter(item=>item.caption).map(item=>`${item.receipt?.record.fileName || item.fileName || item.file.name}\n${item.caption}`).join('\n\n');
 $('receipt-caption').textContent=caption; $('receipt-caption').hidden=!caption;
}
async function requireReconnect() {
 const revision=clientRevision;
 disconnectClient();
 const generation=connectionGeneration;
 busy=false; deviceBusy=true;
 setStatus('connection-status','连接密钥已失效，正在清除此设备保存的连接…','error');
 update();
 await clearExpiredCredential(generation,revision);
 if(generation!==connectionGeneration) return false;
 deviceBusy=false; update();
 return true;
}
function updateBackgroundStatus() {
 const pending = busy || queue.pending > 0;
 $('keep-screen-awake').disabled = !nav?.wakeLock;
 const sleepHint = wakeLock ? '屏幕保持唤醒中。' : '';
 let text;
 if (currentPageOnly) text = '本次仅在当前页面上传，请保持页面打开。';
 else if (!supportsPendingUploads()) text = '此浏览器无法保存续传队列，请保持上传页面打开。';
 else if (workerRegistration?.sync && remembered) text = '支持后台同步；系统仍可能暂停任务，返回页面后会自动续传。';
 else text = '已开始的上传可保存到此设备；切回页面会自动续传。后台或锁屏时可能暂停。';
 setStatus('background-status', sleepHint + text);
 if (!pending) releaseWakeLock();
}
async function acquireWakeLock() {
 if (!busy || !isVisible() || !$('keep-screen-awake').checked || !nav?.wakeLock || wakeLock) return;
 const epoch=++wakeGeneration;
 try {
  const lock=await nav.wakeLock.request('screen');
  if(epoch!==wakeGeneration || !busy || !isVisible() || !$('keep-screen-awake').checked) { await lock.release(); return; }
  wakeLock=lock;
  lock.addEventListener('release',()=>{ if(wakeLock===lock) { wakeLock=null; updateBackgroundStatus(); } });
  updateBackgroundStatus();
 } catch { /* Screen wake lock is optional and never blocks an upload. */ }
}
function releaseWakeLock() {
 wakeGeneration++;
 const lock=wakeLock; wakeLock=null;
 if(lock) void lock.release().catch(()=>{});
}
async function registerBackground() {
 if(!supportsPendingUploads() || !nav?.serviceWorker) return;
 try {
  workerRegistration=await nav.serviceWorker.register('./sw.mjs?v=20261009-background',{type:'module',scope:'./'});
  workerRegistration.installing?.addEventListener('statechange',()=>{if(workerRegistration?.active) void scheduleBackground();});
  void scheduleBackground(); updateBackgroundStatus();
 } catch { workerRegistration=null; updateBackgroundStatus(); }
}
async function scheduleBackground() {
 if(!pendingBatch?.backgroundRevision || !workerRegistration?.sync) return;
 try { await workerRegistration.sync.register('xinjiang-photo-uploads'); } catch {}
}
function notifyBackground() {
 if(pendingBatch?.backgroundRevision) workerRegistration?.active?.postMessage({type:'resume-uploads'});
}
async function removePersistedItem(id) {
 if(busy || !client || connecting || deviceBusy) return;
 busy=true; update();
 try {
  const result=await withUploadLock(async()=>{
   const stored=await loadPendingBatch();
   if(!stored || stored.id!==pendingBatch?.id || String(stored.owner.id)!==String(client.user.id)) return;
   restoreQueue(stored);
   if(!queue.remove(id)) return;
   if(queue.items.length) await savePendingBatch({...pendingBatch,items:queue.snapshot()});
   else {await clearPendingBatch(pendingBatch.id);pendingBatch=null;pendingSaved=false;}
   restoreQueueView();
  });
  if(!result.acquired) setStatus('upload-status','后台正在处理，暂时不能移除照片。','notice');
 } catch {setStatus('pending-storage-status','未能保存队列修改，请稍后重试。','error');}
 finally {busy=false;update();}
 if(queue.complete && pendingBatch) void runUpload({automatic:true});
}
function restoreQueueView() {
 for(const url of previewUrls.values()) URL.revokeObjectURL(url);
 previewUrls.clear(); cardNodes.clear(); batchSelected.clear(); renderedQueueIds=[];
 selectedId=queue.items.find(item=>!item.receipt)?.id || queue.items[0]?.id || null;
 selectItem(selectedId);
}
function restoreQueue(batch) {
 for(const url of previewUrls.values()) URL.revokeObjectURL(url);
 previewUrls.clear(); cardNodes.clear(); batchSelected.clear(); renderedQueueIds=[];
 queue.restore(batch.items); pendingBatch=batch; pendingSaved=true;
 selectedId=queue.items.find(item=>!item.receipt)?.id || queue.items[0]?.id || null;
 selectItem(selectedId);
}
function maybeResume() {
 if(initializing || !resumeWanted || !autoRestoreAllowed || busy || connecting || deviceBusy || !isVisible() || nav?.onLine===false) return;
 if(!client) { void restoreDeviceConnection(); return; }
 void runUpload({automatic:true});
}
function retryLater(error) {
 if(!resumeWanted || !['NETWORK','TIMEOUT','RESPONSE','HTTP'].includes(error?.code) || retryCount>=3) return;
 clearTimeout(retryTimer);
 retryTimer=setTimeout(()=>{ if(isVisible()) maybeResume(); },[10000,30000,60000][retryCount++]);
}
async function runUpload({automatic=false}={}) {
 if(!client || connecting || deviceBusy || initializing || busy || (!queue.pending && !pendingBatch)) return;
 if(!automatic) { resumeWanted=true; retryCount=0; clearTimeout(retryTimer); }
 const uploadClient=client, generation=connectionGeneration;
 busy=true; setStatus('upload-status','正在保存上传队列…'); update(); void acquireWakeLock();
 const current=()=>generation===connectionGeneration;
 const execute=async()=>{
  if(!current()) return {stale:true};
  if(durableAvailable()) {
   const stored=await loadPendingBatch();
   if(!current()) return {stale:true};
   if(stored && stored.id!==pendingBatch?.id && queue.items.length) {
    setStatus('upload-status','此设备另一个页面有待上传任务。请先完成该任务，再上传本批照片。','notice');
    resumeWanted=false; return {stale:true};
   }
   if(stored) {
    if(String(stored.owner.id)!==String(uploadClient.user.id)) throw new PhotoError('请使用原照片库账号恢复上次上传。',409,'ACCOUNT');
    restoreQueue(stored);
   } else if(pendingBatch && pendingSaved) {
    // A background worker or another tab has already cleared the completed batch.
    pendingBatch=null; resumeWanted=false;
    setStatus('upload-status','上次任务已处理，请到旅行回忆查看已保存照片。','success');
    return {stale:true};
   }
   if(!pendingBatch) { pendingSaved=false; pendingBatch={version:1,id:crypto.randomUUID(),owner:{id:uploadClient.user.id,login:uploadClient.user.login},createdAt:new Date().toISOString(),backgroundRevision:null,items:queue.snapshot()}; }
   if(String(pendingBatch.owner.id)!==String(uploadClient.user.id)) throw new PhotoError('请使用原照片库账号恢复上次上传。',409,'ACCOUNT');
   pendingBatch.backgroundRevision=remembered && clientRevision!==null ? clientRevision : null;
   await savePendingBatch({...pendingBatch,items:queue.snapshot()}); pendingSaved=true;
   setStatus('pending-storage-status','上传队列已保存到此设备，切走或刷新后可恢复。','success');
   $('upload-current-page').hidden=true;
   void scheduleBackground();
  }
  if(!current()) return {stale:true};
  setStatus('upload-status','正在依次保存照片…');
  const result=await queue.run(uploadClient,{
   isCurrent:current,
   checkpoint:async()=>{
    if(!current()) throw new PhotoError('上传已暂停。',401,'AUTH');
    if(clientRevision!==null && await getDeviceRevision()!==clientRevision) throw new PhotoError('此设备的连接已改变，请重新连接。',401,'AUTH');
    if(durableAvailable()) await savePendingBatch({...pendingBatch,items:queue.snapshot()});
   },
   onChange:()=>{if(current()) update();},
   onProgress:(item,progress)=>{if(current()) setProgress(item,progress);}
  });
  if(current() && result.complete && durableAvailable() && pendingBatch) {
   await clearPendingBatch(pendingBatch.id);
   if(current()) {pendingBatch=null;pendingSaved=false;}
  }
  return result;
 };
 try {
  const locked=durableAvailable()?await withUploadLock(execute):{acquired:true,value:await execute()};
  if(!current()) return;
  if(!locked.acquired) {
   setStatus('upload-status','后台或另一个页面正在上传，进度会自动同步。');
   clearTimeout(retryTimer); retryTimer=setTimeout(maybeResume,5000); return;
  }
  const result=locked.value;
  if(!result || result.stale) return;
  if(result.error) {
   if(result.checkpointError?.name==='PendingStorageError' && !authenticationError(result.error)) throw result.checkpointError;
   if(result.error.name==='PendingStorageError') throw result.error;
   if(authenticationError(result.error)) {
    if(!await requireReconnect()) return;
   } else if(['PERMISSION','ACCOUNT','PRIVATE','CONFIG'].includes(result.error.code)) {
    resumeWanted=false; disconnectClient(); busy=false;
    setStatus('connection-status',connectionError(result.error),'error'); update();
   }
   setStatus('upload-status',connectionError(result.error)+(durableAvailable()?' 已保存进度，恢复网络或返回本页后继续核对。':' 请保留本页和原图后重试。'),'error');
   retryLater(result.error); void scheduleBackground();
  } else if(!queue.complete) {
   resumeWanted=false;
   setStatus('upload-status','可上传的照片已处理。未通过校验的照片标在列表中，可以移除或重新选择。','notice');
  } else {
   resumeWanted=false; clearTimeout(retryTimer);
   setStatus('pending-storage-status','全部照片已确认保存，本机待传副本已释放。','success');
   setStatus('upload-status','全部照片已保存。','success'); $('receipt-title').focus();
  }
 } catch(error) {
  if(current()) {
   queue.interrupt();
   if(error?.name==='PendingStorageError') {
    resumeWanted=false;
    setStatus('pending-storage-status','此设备未能保存续传队列，可能空间不足。本次尚不能保证切走后恢复。','error');
    $('upload-current-page').hidden=false;
    setStatus('upload-status','请腾出存储空间后重试，或选择“仅在本页继续”。','error');
   } else if(error?.code==='ACCOUNT') { resumeWanted=false; setStatus('upload-status',error.message,'error'); }
   else { setStatus('upload-status','本批上传暂未完成；返回页面或恢复网络后将核对续传。','error'); retryLater(error); }
  }
 } finally {
  releaseWakeLock();
  if(current()) { busy=false; $('upload-progress-wrap').hidden=true; update(); }
 }
}
$('upload-form').addEventListener('submit',event=>{event.preventDefault();void runUpload();});
$('upload-current-page').addEventListener('click',async()=>{
 if(busy) return;
 busy=true; update();
 try {
  if(supportsPendingUploads() && pendingBatch) {
   const expected=pendingBatch.id;
   const result=await withUploadLock(async()=>{
    const stored=await loadPendingBatch();
    if(stored && stored.id!==expected) throw new Error('Another batch is active');
    if(stored) await clearPendingBatch(expected);
   });
   if(!result.acquired) {setStatus('pending-storage-status','后台仍在处理这批照片，请稍后再试。','notice');return;}
  }
  currentPageOnly=true; pendingBatch=null; pendingSaved=false; $('upload-current-page').hidden=true;
  setStatus('pending-storage-status','本次仅在页面内保存队列，离开页面可能需要重新选择照片。','notice');
 } catch {setStatus('pending-storage-status','本机队列尚未安全停用，请先腾出存储空间后重试。','error');return;}
 finally {busy=false;update();}
 void runUpload();
});
$('keep-screen-awake').addEventListener('change',()=>{ if($('keep-screen-awake').checked) void acquireWakeLock(); else {releaseWakeLock();updateBackgroundStatus();} });
window.addEventListener('beforeunload',event=>{if((!durableAvailable() || !pendingSaved) && (busy || hasUncertain() || queue.pending)){event.preventDefault();event.returnValue='';}});
window.addEventListener('pagehide',()=>{if(busy) resumeWanted=true; notifyBackground(); disconnectClient();busy=false;releaseWakeLock();update();});
window.addEventListener('pageshow',event=>{if(event.persisted && autoRestoreAllowed) { if(!client) void restoreDeviceConnection(); else maybeResume(); }});
window.addEventListener('online',()=>{retryCount=0;maybeResume();});
document.addEventListener?.('visibilitychange',()=>{
 if(isVisible()) {retryCount=0; if(busy) void acquireWakeLock(); else maybeResume();}
 else {releaseWakeLock();updateBackgroundStatus();void scheduleBackground();}
});
async function refreshBackgroundProgress() {
 if(!pendingBatch || busy || !client || !isVisible()) return;
 const expected=pendingBatch.id,generation=connectionGeneration;
 try {
  const latest=await loadPendingBatch();
  if(generation!==connectionGeneration || busy || expected!==pendingBatch?.id || latest?.id!==expected) return;
  restoreQueue(latest);
  const saved=queue.items.filter(item=>item.receipt).length;
  setStatus('upload-status',`已同步上传进度：${saved} / ${queue.items.length} 张已保存。`);
  if(queue.complete) {resumeWanted=true;maybeResume();}
 } catch { /* A later foreground resume can retry reading the queue. */ }
}
nav?.serviceWorker?.addEventListener('message',event=>{if(event.data?.type==='upload-queue-changed') void refreshBackgroundProgress();});
async function initializeUploads() {
 setStatus('connection-status','正在准备照片库…'); update();
 if(supportsPendingUploads()) {
  try {
   const existing=await loadPendingBatch();
   if(existing) { restoreQueue(existing); resumeWanted=true; setStatus('pending-storage-status','已找回上次上传队列，连接后自动核对续传。','success'); }
  } catch {setStatus('pending-storage-status','未能读取本机待传队列，请检查浏览器存储空间后刷新。','error');}
 }
 initializing=false; update(); void registerBackground(); await restoreDeviceConnection();
}
void initializeUploads();
