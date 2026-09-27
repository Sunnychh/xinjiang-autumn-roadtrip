(() => {
'use strict';
const $ = id => document.getElementById(id);
const DEFAULT_MAX = 20 * 1024 * 1024;
const DEFAULT_TYPES = ['image/jpeg','image/png','image/webp','image/heic','image/heif'];
const extensions = {jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',webp:'image/webp',heic:'image/heic',heif:'image/heif'};
let configured = false, checking = false, busy = false, locked = false;
let maxBytes = DEFAULT_MAX, acceptedTypes = DEFAULT_TYPES;
let photo = null, previewUrl = null, uploadId = null, submittedCaption = null, uncertain = false, receipt = null;
const inputs = [$('photo-library'),$('photo-camera')];
class ApiError extends Error { constructor(message,status=0,body=null) { super(message); this.status=status; this.body=body; } }
function setStatus(id,message,state='') { $(id).textContent=message; $(id).dataset.state=state; }
function update() {
 $('upload-fields').disabled=!configured;
 $('upload-submit').disabled=!configured || !photo || busy || !!receipt;
 $('upload-submit').textContent=busy?'正在保存…':uncertain?'重新核对并上传':'保存这张照片 ↗';
 ['choose-photo','take-photo','remove-photo'].forEach(id=>{$(id).disabled=busy || locked;});
 inputs.forEach(input=>{input.disabled=busy || locked;});
 $('photo-caption').disabled=busy || locked;
 $('service-retry').disabled=checking || busy;
 $('upload-form').setAttribute('aria-busy',String(busy));
 $('photo-info').hidden=!photo;
 $('photo-empty').hidden=!!photo;
 $('photo-preview').hidden=!photo;
 $('upload-form').hidden=!!receipt;
 $('upload-receipt').hidden=!receipt;
}
async function getJson(path) {
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20000);
 try {
  const response=await fetch(path,{credentials:'same-origin',cache:'no-store',signal:controller.signal});
  let body;
  try { body=await response.json(); } catch { throw new ApiError('服务暂时没有返回有效结果',response.status); }
  if(!response.ok) throw new ApiError(typeof body.error==='string'?body.error:'请求未完成',response.status,body);
  return body;
 } finally { clearTimeout(timer); }
}
function needLogin() {
 configured=false;
 $('upload-login').hidden=false;
 setStatus('service-status','登录已过期，请重新登录。尚未确认保存的照片请保留原文件。','error');
}
async function checkService() {
 if(checking || busy) return;
 checking=true; configured=false; $('upload-login').hidden=true;
 setStatus('service-status','正在连接照片存储…'); update();
 try {
  const result=await getJson('/api/memories/status');
  if(typeof result.configured!=='boolean') throw new ApiError('服务状态不完整');
  configured=result.configured;
  maxBytes=Number.isSafeInteger(result.maxBytes) && result.maxBytes>0 ? Math.min(result.maxBytes,DEFAULT_MAX) : DEFAULT_MAX;
  acceptedTypes=Array.isArray(result.acceptedTypes)?DEFAULT_TYPES.filter(type=>result.acceptedTypes.includes(type)):DEFAULT_TYPES;
  setStatus('service-status',configured?'私密照片库已连接，可以上传。':'照片存储尚未连接，连接完成后即可上传。',configured?'success':'');
  $('service-retry').hidden=configured;
 } catch(error) {
  if(error.status===401) needLogin();
  else setStatus('service-status','暂时无法连接照片存储，请稍后重新连接。','error');
  $('service-retry').hidden=false;
 } finally { checking=false; update(); }
}
function clearPreview() { if(previewUrl) URL.revokeObjectURL(previewUrl); previewUrl=null; $('preview-image').removeAttribute('src'); }
function reset() {
 clearPreview(); photo=null; uploadId=null; submittedCaption=null; uncertain=false; locked=false; receipt=null;
 inputs.forEach(input=>{input.value='';});
 $('photo-caption').value=''; $('caption-counter').textContent='0 / 4,000';
 $('upload-progress-wrap').hidden=true;
 setStatus('photo-error',''); setStatus('upload-status',''); update();
}
function choose(file) {
 if(busy || locked || !file) return;
 const extension=file.name.split('.').at(-1)?.toLowerCase();
 const inferred=extensions[extension], type=file.type?.toLowerCase();
 if(!file.size) { setStatus('photo-error','这张照片是空文件，请重新选择。','error'); return; }
 if(file.size>maxBytes) { setStatus('photo-error','这张照片超过 20 MB，请换一张较小的照片。','error'); return; }
 if((type && !acceptedTypes.includes(type)) || (!type && !acceptedTypes.includes(inferred))) {
  setStatus('photo-error','请选择 JPG、PNG、WebP、HEIC 或 HEIF 照片。','error'); return;
 }
 clearPreview(); photo=file; uploadId=null; submittedCaption=null; uncertain=false;
 setStatus('photo-error',''); setStatus('upload-status','');
 $('photo-name').textContent=file.name;
 const large=file.size>=1024*1024;
 $('photo-size').textContent=(file.size/(large?1024*1024:1024)).toLocaleString('zh-CN',{maximumFractionDigits:2})+(large?' MB':' KB');
 $('preview-image').hidden=false; $('preview-fallback').hidden=true;
 previewUrl=URL.createObjectURL(file); $('preview-image').src=previewUrl;
 update();
}
$('preview-image').addEventListener('error',()=>{$('preview-image').hidden=true;$('preview-fallback').hidden=false;});
$('choose-photo').addEventListener('click',()=>$('photo-library').click());
$('take-photo').addEventListener('click',()=>$('photo-camera').click());
inputs.forEach(input=>input.addEventListener('change',()=>{choose(input.files?.[0]);input.value='';}));
$('remove-photo').addEventListener('click',()=>{reset();$('choose-photo').focus();});
$('photo-caption').addEventListener('input',()=>{$('caption-counter').textContent=$('photo-caption').value.length.toLocaleString('zh-CN')+' / 4,000';});
$('service-retry').addEventListener('click',checkService);
$('upload-next').addEventListener('click',()=>{reset();$('choose-photo').focus();});
function setProgress(value,label) {
 $('upload-progress-wrap').hidden=false;
 $('upload-progress-label').textContent=label;
 $('upload-progress-value').textContent=Number.isFinite(value)?Math.round(value)+'%':'';
 if(Number.isFinite(value)) $('upload-progress').value=value; else $('upload-progress').removeAttribute('value');
}
function upload() {
 return new Promise((resolve,reject)=>{
  const request=new XMLHttpRequest();
  request.open('POST','/api/memories/photo'); request.withCredentials=true; request.timeout=150000;
  request.setRequestHeader('X-Requested-With','itinerary');
  request.upload.addEventListener('progress',event=>{
   if(event.lengthComputable) {
    const percent=Math.min(100,event.loaded/event.total*100);
    setProgress(percent,percent===100?'照片已传送，正在确认保存…':'正在上传照片…');
   } else setProgress(null,'正在上传照片…');
  });
  request.addEventListener('load',()=>{
   let body;
   try { body=JSON.parse(request.responseText); } catch { reject(new ApiError('保存结果暂时无法确认',request.status)); return; }
   if(request.status<200 || request.status>=300) { reject(new ApiError(typeof body.error==='string'?body.error:'上传未完成',request.status,body)); return; }
   resolve(body);
  });
  request.addEventListener('error',()=>reject(new ApiError('网络连接中断')));
  request.addEventListener('timeout',()=>reject(new ApiError('等待保存结果超时')));
  request.addEventListener('abort',()=>reject(new ApiError('上传中断')));
  const form=new FormData();
  form.append('photo',photo,photo.name); form.append('caption',submittedCaption); form.append('uploadId',uploadId);
  setProgress(0,'正在上传照片…'); request.send(form);
 });
}
function showReceipt(result) {
 const record=result?.record;
 if(!record || record.id!==uploadId || typeof record.originalName!=='string' || typeof record.photoPath!=='string' || typeof record.metadataPath!=='string' || typeof record.caption!=='string' || !result.commitSha) throw new ApiError('尚未收到完整的保存回执');
 receipt=record; uncertain=false; locked=false;
 $('receipt-file').textContent=record.originalName;
 $('receipt-caption').textContent=record.caption;
 $('receipt-caption').hidden=!record.caption;
 const date=typeof record.uploadedAt==='number'?new Date(record.uploadedAt<1e12?record.uploadedAt*1000:record.uploadedAt):new Date(record.uploadedAt);
 $('receipt-time').textContent=Number.isNaN(date.getTime())?'已确认保存':new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'long',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).format(date)+' · 保存成功';
 $('upload-progress-wrap').hidden=true; update(); $('receipt-title').focus();
}
async function lookup() { return getJson('/api/memories/photo/'+encodeURIComponent(uploadId)); }
async function reconcile() {
 setProgress(null,'正在核对照片是否已保存…');
 try { showReceipt(await lookup()); }
 catch(error) {
  if(error.status===401) needLogin();
  setStatus('upload-status',error.status===404?'暂未找到保存回执。请点击“重新核对并上传”，会继续核对同一张照片。':'暂时无法确认保存结果。请保留此页，稍后点击“重新核对并上传”。','error');
 }
}
$('upload-form').addEventListener('submit',async event=>{
 event.preventDefault();
 if(!configured || !photo || busy || receipt) return;
 if(!crypto.randomUUID) { setStatus('upload-status','请使用 HTTPS 或本机预览地址打开页面后上传。','error'); return; }
 if(!uploadId) { uploadId=crypto.randomUUID(); submittedCaption=$('photo-caption').value; }
 const retrying=uncertain;
 busy=true; locked=true; setStatus('upload-status','上传期间请保持页面打开。'); update();
 try {
  if(uncertain) {
   setProgress(null,'正在核对上次保存结果…');
   try { showReceipt(await lookup()); return; }
   catch(error) { if(error.status!==404) throw error; }
  }
  uncertain=true;
  showReceipt(await upload());
 } catch(error) {
  if(error.status===401) {
   needLogin(); setStatus('upload-status','登录已过期，当前保存结果尚未确认。请保留原照片，重新登录后继续。','error');
  } else if([400,413,415,422].includes(error.status) && !retrying) {
   locked=false; uncertain=false; uploadId=null; submittedCaption=null;
   setStatus('upload-status','照片未保存。请检查图片格式、大小和附言后重新选择。','error');
  } else {
   uncertain=true; await reconcile();
  }
 } finally { busy=false; $('upload-progress-wrap').hidden=true; update(); }
});
window.addEventListener('beforeunload',event=>{if(busy || uncertain){event.preventDefault();event.returnValue='';}});
update(); checkService();
})();
