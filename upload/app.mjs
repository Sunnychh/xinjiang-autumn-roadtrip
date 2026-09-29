import { PhotoError, connect, connectionErrorMessage, probeGitHub } from './github.mjs?v=20260929-batch';
import { PhotoQueue } from './queue.mjs?v=20260929-batch';
import { loadDeviceConnection, getDeviceRevision, rememberDeviceToken, forgetDeviceToken, onDeviceForgotten } from './device-credential.mjs';

const $ = id => document.getElementById(id);
const queue = new PhotoQueue();
const previewUrls = new Map();
let selectedId = null;
const inputs = [$('photo-library'),$('photo-camera')];
let client = null, connecting = false, busy = false, checkingNetwork = false, connectionGeneration = 0;
let deviceBusy = false, remembered = false, storageQueue = Promise.resolve();
let clientRevision = null, autoRestoreAllowed = true;
const selectedPhoto = () => queue.items.find(item => item.id === selectedId);
const hasUncertain = () => queue.uncertain;

function setStatus(id,message,state='') { $(id).textContent=message; $(id).dataset.state=state; }
function deviceOperation(operation) {
 const result=storageQueue.then(()=>operation());
 storageQueue=result.catch(()=>{});
 return result;
}
function update() {
 const unavailable = !client || connecting || deviceBusy;
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
 ['choose-photo','take-photo'].forEach(id=>{$(id).disabled=locked || hasUncertain();});
 $('remove-photo').disabled=locked || !item || !!item.receipt || item.uncertain || !!item.prepared;
 inputs.forEach(input=>{input.disabled=locked || hasUncertain();});
 $('photo-caption').disabled=locked || !item || !!item.prepared || !!item.receipt;
 $('upload-form').setAttribute('aria-busy',String(busy));
 $('photo-info').hidden=!item;
 $('photo-empty').hidden=!!item;
 $('photo-preview').hidden=!item;
 $('upload-form').hidden=queue.complete;
 $('upload-receipt').hidden=!queue.complete;
 renderQueue(locked);
 if(queue.complete) renderReceipt();
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
  if(generation===connectionGeneration) { connecting=false; update(); }
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
 autoRestoreAllowed=false;
 const generation=connectionGeneration;
 deviceBusy=true; setStatus('connection-status','正在清除此设备保存的连接…'); update();
 try {
  const removed=await deviceOperation(forgetDeviceToken);
  if(generation!==connectionGeneration) return;
  if(removed!==true) throw new Error('Device connection was not removed');
  remembered=false;
  if(!hasUncertain()) reset();
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
 busy=false; remembered=false; autoRestoreAllowed=false;
 setStatus('connection-status','此设备的连接已在其他页面清除。需要上传时，请重新输入连接密钥。');
 update();
});
function previewFor(item) {
 if(!previewUrls.has(item.id)) previewUrls.set(item.id,URL.createObjectURL(item.file));
 return previewUrls.get(item.id);
}
function selectItem(id) {
 selectedId=id;
 const item=selectedPhoto();
 $('preview-image').removeAttribute('src');
 $('photo-caption').value=item?.caption || '';
 $('caption-counter').textContent=($('photo-caption').value.length).toLocaleString('zh-CN')+' / 4,000';
 if(item) {
  $('photo-name').textContent=item.file.name;
  $('photo-size').textContent=(item.file.size/1024/1024).toLocaleString('zh-CN',{maximumFractionDigits:2})+' MB';
  $('preview-image').hidden=false; $('preview-fallback').hidden=true;
  $('preview-image').src=previewFor(item);
 }
 update();
}
const statusLabels={pending:'待上传',preparing:'检查原图',uploading:'正在保存',saved:'已保存',invalid:'未通过校验',failed:'待重试',uncertain:'待核对'};
function renderQueue(locked) {
 const counts={saved:0,invalid:0};
 queue.items.forEach(item=>{if(item.status in counts) counts[item.status]++;});
 $('queue-summary').textContent=queue.items.length?`共 ${queue.items.length} 张 · 已保存 ${counts.saved} 张 · 待传 ${queue.pending} 张${counts.invalid?` · 未通过 ${counts.invalid} 张`:''}`:'';
 $('photo-queue').hidden=!queue.items.length;
 $('photo-queue').replaceChildren(...queue.items.map((item,index)=>{
  const row=document.createElement('li'), button=document.createElement('button');
  button.type='button'; button.className='queue-item'; button.disabled=locked;
  button.setAttribute('aria-pressed',String(item.id===selectedId));
  button.setAttribute('aria-label',`${index+1}. ${item.file.name}，${statusLabels[item.status] || '待上传'}，查看或编辑附言`);
  button.dataset.state=item.status;
  const thumb=document.createElement('img'); thumb.src=previewFor(item); thumb.alt=''; thumb.loading='lazy';
  thumb.addEventListener('error',()=>{thumb.hidden=true;});
  const details=document.createElement('span'); details.className='queue-details';
  const name=document.createElement('strong'); name.textContent=item.file.name;
  const state=document.createElement('span'); state.className='queue-state';
  state.textContent=(statusLabels[item.status] || '待上传')+(item.caption?' · 有附言':'')+(item.error?` · ${item.error}`:'');
  details.append(name,state); button.append(thumb,details);
  button.addEventListener('click',()=>{if(!busy) selectItem(item.id);}); row.append(button); return row;
 }));
}
function reset() {
 if(!queue.clear()) return;
 for(const url of previewUrls.values()) URL.revokeObjectURL(url);
 previewUrls.clear(); selectedId=null;
 $('preview-image').removeAttribute('src');
 inputs.forEach(input=>{input.value='';});
 $('photo-caption').value=''; $('caption-counter').textContent='0 / 4,000';
 $('upload-progress-wrap').hidden=true;
 setStatus('photo-error',''); setStatus('upload-status',''); update();
}
function choose(files) {
 if(!client || connecting || deviceBusy || busy || hasUncertain() || !files?.length) return;
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
$('remove-photo').addEventListener('click',()=>{
 if(busy || !selectedId || !queue.remove(selectedId)) return;
 if(previewUrls.has(selectedId)) URL.revokeObjectURL(previewUrls.get(selectedId));
 previewUrls.delete(selectedId);
 selectItem(queue.items.find(item=>!item.receipt)?.id || queue.items[0]?.id || null);
 $('choose-photo').focus();
});
$('photo-caption').addEventListener('input',()=>{
 const item=selectedPhoto();
 if(!item || busy || item.prepared || item.receipt) return;
 item.caption=$('photo-caption').value;
 $('caption-counter').textContent=item.caption.length.toLocaleString('zh-CN')+' / 4,000';
});
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
 $('receipt-file').textContent=queue.items.map(item=>item.file.name).join(' · ');
 $('receipt-time').textContent='已确认原图与附言保存成功';
 const caption=queue.items.length===1?queue.items[0].caption:'';
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
$('upload-form').addEventListener('submit',async event=>{
 event.preventDefault();
 if(!client || connecting || deviceBusy || !queue.pending || busy) return;
 const uploadClient=client, generation=connectionGeneration;
 busy=true; setStatus('upload-status','正在依次保存。请保持页面打开。'); update();
 try {
  const result=await queue.run(uploadClient,{
   isCurrent:()=>generation===connectionGeneration,
   onChange:()=>{if(generation===connectionGeneration) update();},
   onProgress:(item,progress)=>{if(generation===connectionGeneration) setProgress(item,progress);}
  });
  if(generation!==connectionGeneration || result.stale) return;
  if(result.error) {
   if(authenticationError(result.error)) {
    if(!await requireReconnect()) return;
   } else if(['PERMISSION','ACCOUNT'].includes(result.error.code)) {
    disconnectClient(); busy=false;
    setStatus('connection-status',connectionError(result.error),'error');
    update();
   }
   setStatus('upload-status',connectionError(result.error)+' 已成功的照片会保留；请保持本页，恢复连接后继续上传。','error');
  } else if(!queue.complete) {
   setStatus('upload-status','可上传的照片已处理。未通过校验的照片标在列表中，可以移除或重新选择。','notice');
  } else {
   setStatus('upload-status','全部照片已保存。','success');
   $('receipt-title').focus();
  }
 } catch {
  if(generation===connectionGeneration) {
   queue.interrupt();
   setStatus('upload-status','暂未完成本批上传。请保留本页和原图，稍后继续核对。','error');
  }
 } finally {
  if(generation===connectionGeneration) { busy=false; $('upload-progress-wrap').hidden=true; update(); }
 }
});
window.addEventListener('beforeunload',event=>{if(busy || hasUncertain() || queue.pending){event.preventDefault();event.returnValue='';}});
window.addEventListener('pagehide',()=>{disconnectClient();busy=false;update();});
window.addEventListener('pageshow',event=>{if(event.persisted && !client && autoRestoreAllowed) void restoreDeviceConnection();});
setStatus('connection-status','正在准备照片库…');
update();
void restoreDeviceConnection();
