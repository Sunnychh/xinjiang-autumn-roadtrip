import { MAX_BYTES, PhotoError, connect, connectionErrorMessage, probeGitHub } from './github.mjs?v=20260929-connection';
import { embeddedToken } from './credential-config.mjs';

const $ = id => document.getElementById(id);
const configured = typeof embeddedToken === 'string' && embeddedToken.trim().length > 0;
const acceptedTypes = ['image/jpeg','image/png','image/webp','image/heic','image/heif'];
const extensions = {jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',webp:'image/webp',heic:'image/heic',heif:'image/heif'};
const inputs = [$('photo-library'),$('photo-camera')];
let client = null, connecting = false, busy = false, checkingNetwork = false, connectionGeneration = 0;
let photo = null, previewUrl = null, prepared = null, preparedOwner = null;
let uncertain = false, receipt = null;

function setStatus(id,message,state='') { $(id).textContent=message; $(id).dataset.state=state; }
function update() {
 const locked = busy || uncertain;
 $('connect-form').hidden=!!client;
 $('connected-user').hidden=!client;
 $('connect-button').disabled=!configured || connecting || busy;
 $('connect-button').textContent=!configured?'入口待配置':connecting?'正在连接…':'重试连接';
 $('connect-form').setAttribute('aria-busy',String(connecting));
 $('network-check').disabled=busy || connecting || checkingNetwork;
 $('network-check').textContent=checkingNetwork?'正在检测…':'检测网络连接';
 $('upload-fields').disabled=!client;
 $('upload-submit').disabled=!client || !photo || busy || !!receipt;
 $('upload-submit').textContent=busy?'正在保存…':uncertain?'重新核对并上传':'保存这张照片 ↗';
 ['choose-photo','take-photo','remove-photo'].forEach(id=>{$(id).disabled=locked || !client;});
 inputs.forEach(input=>{input.disabled=locked || !client;});
 $('photo-caption').disabled=locked || !client;
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
 client=null; connecting=false; checkingNetwork=false;
 $('upload-progress-wrap').hidden=true;
 setStatus('network-status','');
}
function authenticationError(error) { return error?.status===401 || error?.code==='AUTH' || error?.code==='AUTH_REQUIRED'; }
function connectionError(error) {
 if(authenticationError(error)) return '照片库连接已到期，请联系管理员更新。';
 if(error instanceof PhotoError && ['PERMISSION','ACCOUNT','PRIVATE','CONFIG','INVALID'].includes(error.code)) return '照片库暂时不可用，请稍后重试或联系管理员检查连接权限。';
 if(error?.code==='NETWORK') return '当前无法访问照片库。请检查网络，或点击“检测网络连接”后重试。';
 if(error?.code==='TIMEOUT') return '照片库响应超时，请稍后重试。';
 return connectionErrorMessage(error);
}
$('network-check').addEventListener('click',async()=>{
 if(checkingNetwork || busy || connecting) return;
 const generation=connectionGeneration;
 checkingNetwork=true; setStatus('network-status','正在检查当前设备能否连接 GitHub API…'); update();
 try {
  await probeGitHub();
  if(generation!==connectionGeneration) return;
  setStatus('network-status','网络连接正常。照片库连接失败时，可以再试一次。','success');
 } catch(error) { if(generation===connectionGeneration) setStatus('network-status',connectionError(error),'error'); }
 finally { if(generation===connectionGeneration) { checkingNetwork=false; update(); } }
});
async function connectLibrary() {
 if(connecting || busy || client) return;
 if(!configured) { setStatus('connection-status','上传入口待配置，请稍后再来。','notice'); return; }
 const generation=++connectionGeneration;
 checkingNetwork=false;
 setStatus('network-status','');
 connecting=true; setStatus('connection-status','正在连接照片库…'); update();
 try {
  const next=await connect(embeddedToken,{onProgress(stage){
   if(generation!==connectionGeneration) return;
   const labels={identity:'正在验证照片库连接…',repository:'正在检查照片库…',branch:'正在准备上传…'};
   setStatus('connection-status',labels[stage] || '正在连接…');
  }});
  if(generation!==connectionGeneration) { next.disconnect(); return; }
  if(preparedOwner && uncertain && String(next.user.id)!==String(preparedOwner.id)) {
   next.disconnect();
   setStatus('connection-status','照片库账号已发生变化。上次上传尚未确认，请联系管理员恢复原照片库连接后核对。','error');
   return;
  }
  client=next;
  setStatus('connection-status',uncertain?'已重新连接，可继续核对上次上传。':'照片库已连接，可以上传。','success');
 } catch(error) { if(generation===connectionGeneration) setStatus('connection-status',connectionError(error),'error'); }
 finally { if(generation===connectionGeneration) { connecting=false; update(); } }
}
$('connect-form').addEventListener('submit',event=>{event.preventDefault();void connectLibrary();});
function clearPreview() { if(previewUrl) URL.revokeObjectURL(previewUrl); previewUrl=null; $('preview-image').removeAttribute('src'); }
function reset() {
 clearPreview(); photo=null; prepared=null; preparedOwner=null; uncertain=false; receipt=null;
 inputs.forEach(input=>{input.value='';});
 $('photo-caption').value=''; $('caption-counter').textContent='0 / 4,000';
 $('upload-progress-wrap').hidden=true;
 setStatus('photo-error',''); setStatus('upload-status',''); update();
}
function choose(file) {
 if(!client || busy || uncertain || !file) return;
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
function requireReconnect() {
 disconnectClient();
 busy=false;
 setStatus('connection-status','照片库连接已到期，请联系管理员更新。上次上传仍可继续核对。','error');
 update();
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
  if(authenticationError(error)) requireReconnect();
  else if(showActionableError(error)) return;
  setStatus('upload-status','暂时无法确认保存结果。请保留此页，稍后重新核对并上传。','notice');
 }
}
$('upload-form').addEventListener('submit',async event=>{
 event.preventDefault();
 if(!client || !photo || busy || receipt) return;
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
    if(authenticationError(error)) requireReconnect();
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
   requireReconnect(); setStatus('upload-status','当前保存结果尚未确认。重新连接后，请继续核对这一张照片。','notice');
  } else if(!showActionableError(error)) await reconcile(uploadClient,generation);
 } finally { if(generation===connectionGeneration) { busy=false; $('upload-progress-wrap').hidden=true; update(); } }
});
window.addEventListener('beforeunload',event=>{if(busy || uncertain){event.preventDefault();event.returnValue='';}});
window.addEventListener('pagehide',()=>{disconnectClient();if(busy) uncertain=true;busy=false;update();});
window.addEventListener('pageshow',event=>{if(event.persisted && !client) void connectLibrary();});
setStatus('connection-status',configured?'正在准备照片库…':'上传入口待配置，请稍后再来。',configured?'':'notice');
update();
void connectLibrary();
