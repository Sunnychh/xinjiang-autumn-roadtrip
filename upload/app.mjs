import { MAX_BYTES, PhotoError, connect } from './github.mjs';

const $ = id => document.getElementById(id);
const acceptedTypes = ['image/jpeg','image/png','image/webp','image/heic','image/heif'];
const extensions = {jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',webp:'image/webp',heic:'image/heic',heif:'image/heif'};
const inputs = [$('photo-library'),$('photo-camera')];
let client = null, connecting = false, busy = false, connectionGeneration = 0;
let photo = null, previewUrl = null, prepared = null, preparedOwner = null;
let uncertain = false, receipt = null;

function setStatus(id,message,state='') { $(id).textContent=message; $(id).dataset.state=state; }
function update() {
 const locked = busy || uncertain;
 $('connect-form').hidden=!!client;
 $('connected-user').hidden=!client;
 $('github-token').disabled=connecting || busy;
 $('connect-button').disabled=connecting || busy;
 $('connect-button').textContent=connecting?'正在连接…':'连接照片库';
 $('disconnect').disabled=busy || connecting;
 $('upload-fields').disabled=!client;
 $('upload-submit').disabled=!client || !photo || busy || !!receipt;
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
function disconnectClient() { connectionGeneration++; if(client) client.disconnect(); client=null; $('github-token').value=''; }
function authenticationError(error) { return error?.status===401 || error?.code==='AUTH' || error?.code==='AUTH_REQUIRED'; }
function connectionError(error) {
 if(error instanceof PhotoError && ['PRIVATE','CONFIG','ACCOUNT','CONFLICT','PERMISSION'].includes(error.code)) return error.message;
 if(authenticationError(error)) return '令牌无效或已过期，请检查后重新连接。';
 if(error?.status===403) return '暂时没有访问权限。请核对照片库 Contents 读写权限；若 GitHub 限流，请稍后重试。';
 if(error?.status===404) return '无法访问指定照片库，请确认令牌已选择该私有仓库。';
 return '连接未完成，请检查网络、令牌及仓库权限后重试。';
}
$('connect-form').addEventListener('submit',async event=>{
 event.preventDefault();
 if(connecting || busy || client) return;
 let token=$('github-token').value.trim();
 $('github-token').value='';
 if(!token) { setStatus('connection-status','请先粘贴 GitHub 访问令牌。','error'); $('github-token').focus(); return; }
 const generation=++connectionGeneration;
 connecting=true; setStatus('connection-status','正在核对账号和私有仓库…'); update();
 try {
  const connection=connect(token); token='';
  const next=await connection;
  if(generation!==connectionGeneration) { next.disconnect(); return; }
  if(preparedOwner && uncertain && String(next.user.id)!==String(preparedOwner.id)) {
   next.disconnect();
   setStatus('connection-status',`上次上传尚未确认，请用 ${preparedOwner.login} 的令牌重新连接后核对。`,'error');
   return;
  }
  client=next;
  $('connected-login').textContent=client.user.login;
  $('token-help').open=false;
  setStatus('connection-status',uncertain?'已重新连接，可继续核对上次上传。':'私密照片库已连接，可以上传。','success');
 } catch(error) { setStatus('connection-status',connectionError(error),'error'); }
 finally { token=''; connecting=false; update(); }
});
$('disconnect').addEventListener('click',()=>{
 if(busy || connecting) return;
 disconnectClient();
 if(!uncertain) reset();
 setStatus('connection-status',uncertain?'已断开。上次上传尚未确认，请重新连接同一账号后核对。':'已断开连接，令牌已从当前页面清除。');
 update(); $('github-token').focus();
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
 if(busy || uncertain || !file) return;
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
 setStatus('connection-status','令牌已失效，请重新连接同一账号。上次上传仍可继续核对。','error');
}
function showActionableError(error) {
 if(!(error instanceof PhotoError) || (!['PERMISSION','PRIVATE','CONFIG','ACCOUNT','CONFLICT'].includes(error.code) && error.status!==403)) return false;
 let guidance='保存结果仍未确认，请保留本页和原图。';
 if(error.code==='PERMISSION' || error.code==='ACCOUNT' || (error.status===403 && !error.code)) {
  disconnectClient();
  guidance='请用发起上传的同一账号，重新连接已开启此照片库 Contents 读写权限的令牌，再核对这张照片。';
  setStatus('connection-status',error.message+' '+guidance,'error');
 }
 setStatus('upload-status',error.message+' '+guidance,'error');
 return true;
}
async function reconcile() {
 setProgress({label:'正在核对照片是否已保存…'});
 try {
  const result=await client.lookup(prepared);
  if(result) { showReceipt(result); return; }
  setStatus('upload-status','暂未找到保存回执。请点击“重新核对并上传”，会继续处理同一张照片。','notice');
 } catch(error) {
  if(authenticationError(error)) requireReconnect();
  else if(showActionableError(error)) return;
  setStatus('upload-status','暂时无法确认保存结果。请保留此页，稍后重新核对并上传。','notice');
 }
}
$('upload-form').addEventListener('submit',async event=>{
 event.preventDefault();
 if(!client || !photo || busy || receipt) return;
 busy=true; setStatus('upload-status','上传期间请保持页面打开。'); update();
 try {
  if(!prepared) {
   setProgress({label:'正在检查原图…'});
   try {
    prepared=await client.prepare(photo,$('photo-caption').value);
    preparedOwner={id:client.user.id,login:client.user.login};
   } catch(error) {
    if(authenticationError(error)) requireReconnect();
    setStatus('upload-status',error instanceof PhotoError ? '照片尚未上传。'+error.message : '照片尚未上传。请检查图片格式、大小和附言，或重新选择照片后重试。','error');
    return;
   }
  }
  if(uncertain) {
   setProgress({label:'正在核对上次保存结果…'});
   const result=await client.lookup(prepared);
   if(result) { showReceipt(result); return; }
  }
  uncertain=true;
  showReceipt(await client.save(prepared,setProgress));
 } catch(error) {
  uncertain=true;
  if(authenticationError(error)) {
   requireReconnect(); setStatus('upload-status','当前保存结果尚未确认。重新连接后，请继续核对这一张照片。','notice');
  } else if(!showActionableError(error)) await reconcile();
 } finally { busy=false; $('upload-progress-wrap').hidden=true; update(); }
});
window.addEventListener('beforeunload',event=>{if(busy || uncertain){event.preventDefault();event.returnValue='';}});
window.addEventListener('pagehide',()=>{disconnectClient();});
window.addEventListener('pageshow',event=>{if(event.persisted && !client){setStatus('connection-status',uncertain?'页面连接已清除，请重新连接同一账号后核对上次上传。':'页面连接已清除，请重新粘贴令牌连接。');update();}});
update();
