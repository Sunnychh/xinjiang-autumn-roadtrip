import { MAX_BYTES, PhotoError, connect, connectionErrorMessage, probeGitHub } from './github.mjs?v=20260929-connection';
import { loadDeviceConnection, getDeviceRevision, rememberDeviceToken, forgetDeviceToken, onDeviceForgotten } from './device-credential.mjs';

const $ = id => document.getElementById(id);
const acceptedTypes = ['image/jpeg','image/png','image/webp','image/heic','image/heif'];
const extensions = {jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',webp:'image/webp',heic:'image/heic',heif:'image/heif'};
const inputs = [$('photo-library'),$('photo-camera')];
let client = null, connecting = false, busy = false, checkingNetwork = false, connectionGeneration = 0;
let deviceBusy = false, remembered = false, storageQueue = Promise.resolve();
let clientRevision = null, autoRestoreAllowed = true;
let photo = null, previewUrl = null, prepared = null, preparedOwner = null;
let uncertain = false, receipt = null;

function setStatus(id,message,state='') { $(id).textContent=message; $(id).dataset.state=state; }
function deviceOperation(operation) {
 const result=storageQueue.then(()=>operation());
 storageQueue=result.catch(()=>{});
 return result;
}
function update() {
 const unavailable = !client || connecting || deviceBusy;
 const locked = busy || uncertain || unavailable;
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
 $('upload-submit').disabled=unavailable || !photo || busy || !!receipt;
 $('upload-submit').textContent=busy?'正在保存…':uncertain?'重新核对并上传':'保存这张照片 ↗';
 ['choose-photo','take-photo','remove-photo'].forEach(id=>{$(id).disabled=locked;});
 inputs.forEach(input=>{input.disabled=locked;});
 $('photo-caption').disabled=locked;
 $('upload-form').setAttribute('aria-busy',String(busy));
 $('photo-info').hidden=!photo;
 $('photo-empty').hidden=!!photo;
 $('photo-preview').hidden=!photo;
 $('upload-form').hidden=!!receipt;
 $('upload-receipt').hidden=!receipt;
}
function disconnectClient() {
 connectionGeneration++;
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
 } catch(error) { if(generation===connectionGeneration) setStatus('network-status',connectionError(error),'error'); }
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
  if(preparedOwner && uncertain && String(next.user.id)!==String(preparedOwner.id)) {
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
  const message=uncertain?'已重新连接，可继续核对上次上传。':'照片库已连接，可以上传。';
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
  if(!uncertain) reset();
  setStatus('connection-status',uncertain?'已忘记此设备。上次上传尚未确认，请重新输入原照片库的密钥后核对。':'已忘记此设备，下次连接时需重新输入密钥。','success');
 } catch {
  if(generation===connectionGeneration) {
   remembered=true;
   setStatus('connection-status','未能清除此设备保存的连接，请重试。','error');
  }
 } finally { if(generation===connectionGeneration) { deviceBusy=false; update(); } }
});
onDeviceForgotten(()=>{
 const wasBusy=busy;
 disconnectClient();
 if(wasBusy) uncertain=true;
 busy=false; remembered=false; autoRestoreAllowed=false;
 setStatus('connection-status','此设备的连接已在其他页面清除。需要上传时，请重新输入连接密钥。');
 update();
});
function clearPreview() { if(previewUrl) URL.revokeObjectURL(previewUrl); previewUrl=null; $('preview-image').removeAttribute('src'); }
function reset() {
 clearPreview(); photo=null; prepared=null; preparedOwner=null; uncertain=false; receipt=null;
 inputs.forEach(input=>{input.value='';});
 $('photo-caption').value=''; $('caption-counter').textContent='0 / 4,000';
 $('upload-progress-wrap').hidden=true;
 setStatus('photo-error',''); setStatus('upload-status',''); update();
}
function choose(file) {
 if(!client || connecting || deviceBusy || busy || uncertain || !file) return;
 const extension=file.name.split('.').at(-1)?.toLowerCase();
 const inferred=extensions[extension], type=file.type?.toLowerCase();
 if(!file.size) { setStatus('photo-error','这张照片是空文件，请重新选择。','error'); return; }
 if(file.size>MAX_BYTES) { setStatus('photo-error','这张照片超过 20 MB，请换一张较小的照片。','error'); return; }
 const unspecifiedType=!type || type==='application/octet-stream';
 if(unspecifiedType ? !acceptedTypes.includes(inferred) : !acceptedTypes.includes(type)) {
  setStatus('photo-error','请选择 JPG、PNG、WebP、HEIC 或 HEIF 照片。','error'); return;
 }
 clearPreview(); photo=file; prepared=null; preparedOwner=null; uncertain=false;
 setStatus('photo-error',''); setStatus('upload-status','');
 $('photo-name').textContent=file.name;
 $('photo-size').textContent=(file.size/1024/1024).toLocaleString('zh-CN',{maximumFractionDigits:2})+' MB';
 $('preview-image').hidden=false; $('preview-fallback').hidden=true;
 previewUrl=URL.createObjectURL(file); $('preview-image').src=previewUrl;
 update();
}
$('preview-image').addEventListener('error',()=>{if(photo){$('preview-image').hidden=true;$('preview-fallback').hidden=false;}});
$('choose-photo').addEventListener('click',()=>$('photo-library').click());
$('take-photo').addEventListener('click',()=>$('photo-camera').click());
inputs.forEach(input=>input.addEventListener('change',()=>{choose(input.files?.[0]);input.value='';}));
$('remove-photo').addEventListener('click',()=>{reset();$('choose-photo').focus();});
$('photo-caption').addEventListener('input',()=>{$('caption-counter').textContent=$('photo-caption').value.length.toLocaleString('zh-CN')+' / 4,000';});
$('upload-next').addEventListener('click',()=>{reset();$('choose-photo').focus();});
function setProgress({percent,label}) {
 $('upload-progress-wrap').hidden=false;
 $('upload-progress-label').textContent=typeof label==='string'?label:'正在保存照片…';
 $('upload-progress-value').textContent=Number.isFinite(percent)?Math.round(Math.max(0,Math.min(100,percent)))+'%':'';
 if(Number.isFinite(percent)) $('upload-progress').value=Math.max(0,Math.min(100,percent)); else $('upload-progress').removeAttribute('value');
}
function showReceipt(result) {
 const record=result?.record;
 if(!record || typeof record.originalName!=='string' || typeof record.caption!=='string' || !result.commitSha) throw new Error('未收到完整保存回执');
 receipt=record; uncertain=false;
 $('receipt-file').textContent=record.originalName;
 $('receipt-caption').textContent=record.caption;
 $('receipt-caption').hidden=!record.caption;
 const date=typeof record.uploadedAt==='number'?new Date(record.uploadedAt<1e12?record.uploadedAt*1000:record.uploadedAt):new Date(record.uploadedAt);
 $('receipt-time').textContent=Number.isNaN(date.getTime())?'已确认保存':new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'long',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).format(date)+' · 保存成功';
 $('upload-progress-wrap').hidden=true; update(); $('receipt-title').focus();
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
function showActionableError(error) {
 if(!(error instanceof PhotoError) || (!['PERMISSION','PRIVATE','CONFIG','ACCOUNT','CONFLICT'].includes(error.code) && error.status!==403)) return false;
 let guidance='保存结果仍未确认，请保留本页和原图。';
 if(error.code==='PERMISSION' || error.code==='ACCOUNT' || (error.status===403 && !error.code)) {
  disconnectClient();
  busy=false;
  guidance='请联系管理员检查照片库连接权限。恢复连接后，再核对这张照片。';
  setStatus('connection-status',guidance,'error');
  update();
 }
 setStatus('upload-status',connectionError(error)+' '+guidance,'error');
 return true;
}
async function reconcile(uploadClient,generation) {
 setProgress({label:'正在核对照片是否已保存…'});
 try {
  const result=await uploadClient.lookup(prepared);
  if(generation!==connectionGeneration) return;
  if(result) { showReceipt(result); return; }
  setStatus('upload-status','暂未找到保存回执。请点击“重新核对并上传”，会继续处理同一张照片。','notice');
 } catch(error) {
  if(generation!==connectionGeneration) return;
  if(authenticationError(error)) { if(!await requireReconnect()) return; }
  else if(showActionableError(error)) return;
  setStatus('upload-status','暂时无法确认保存结果。请保留此页，稍后重新核对并上传。','notice');
 }
}
$('upload-form').addEventListener('submit',async event=>{
 event.preventDefault();
 if(!client || connecting || deviceBusy || !photo || busy || receipt) return;
 const uploadClient=client, generation=connectionGeneration;
 busy=true; setStatus('upload-status','上传期间请保持页面打开。'); update();
 try {
  if(!prepared) {
   setProgress({label:'正在检查原图…'});
   try {
    const nextPrepared=await uploadClient.prepare(photo,$('photo-caption').value);
    if(generation!==connectionGeneration) return;
    prepared=nextPrepared;
    preparedOwner={id:uploadClient.user.id,login:uploadClient.user.login};
   } catch(error) {
    if(generation!==connectionGeneration) return;
    if(authenticationError(error)) { if(!await requireReconnect()) return; }
    setStatus('upload-status',error instanceof PhotoError ? '照片尚未上传。'+(error.code==='INVALID'?error.message:connectionError(error)) : '照片尚未上传。请检查图片格式、大小和附言，或重新选择照片后重试。','error');
    return;
   }
  }
  if(uncertain) {
   setProgress({label:'正在核对上次保存结果…'});
   const result=await uploadClient.lookup(prepared);
   if(generation!==connectionGeneration) return;
   if(result) { showReceipt(result); return; }
  }
  uncertain=true;
  const result=await uploadClient.save(prepared,progress=>{if(generation===connectionGeneration) setProgress(progress);});
  if(generation!==connectionGeneration) return;
  showReceipt(result);
 } catch(error) {
  if(generation!==connectionGeneration) return;
  uncertain=true;
  if(authenticationError(error)) {
   if(!await requireReconnect()) return;
   setStatus('upload-status','当前保存结果尚未确认。重新连接后，请继续核对这一张照片。','notice');
  } else if(!showActionableError(error)) await reconcile(uploadClient,generation);
 } finally { if(generation===connectionGeneration) { busy=false; $('upload-progress-wrap').hidden=true; update(); } }
});
window.addEventListener('beforeunload',event=>{if(busy || uncertain){event.preventDefault();event.returnValue='';}});
window.addEventListener('pagehide',()=>{disconnectClient();if(busy) uncertain=true;busy=false;update();});
window.addEventListener('pageshow',event=>{if(event.persisted && !client && autoRestoreAllowed) void restoreDeviceConnection();});
setStatus('connection-status','正在准备照片库…');
update();
void restoreDeviceConnection();
