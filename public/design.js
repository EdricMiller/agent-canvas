const $=id=>document.getElementById(id),escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const params=new URL(location.href).searchParams;
const state={sessionId:params.get('session'),sourceId:params.get('source'),token:null,record:null,assets:[],selected:null,dirty:false,busy:false,capabilities:null,session:null,mode:null,aiEnabled:false,referenceIds:new Set(),aiNotice:''};
const page=()=>state.record?.document.pages[0],object=()=>page()?.objects.find(o=>o.id===state.selected);
const displayNumber=value=>Number(value.toFixed(6));
const endpoint=suffix=>`/api/sessions/${state.sessionId}/design${suffix||''}`;
let messageTimer,previewUrl,aiPollTimer;
const aiRunning=()=>state.session?.job?.status==='running'&&state.session.job.outputMode==='design';
function message(text){$('designMessage').textContent=text;$('designMessage').hidden=false;clearTimeout(messageTimer);messageTimer=setTimeout(()=>$('designMessage').hidden=true,6000);}
async function request(url,method='GET',body){
  const response=await fetch(url,{method,headers:{'Content-Type':'application/json','X-Studio-Token':state.token},...(body===undefined?{}:{body:JSON.stringify(body)})});
  if(!response.ok){const error=await response.json().catch(()=>({}));throw new Error(error.error||`请求失败（${response.status}）`);}
  return response.json();
}
function accept(data){state.record=data.design;state.assets=data.assets;state.dirty=false;}
function changed(){state.dirty=true;$('designStatus').textContent='有未保存修改';$('dirtyPreview').hidden=false;}
function controls(){
  const locked=state.busy||aiRunning();
  for(const element of document.querySelectorAll('button,input,select,textarea'))element.disabled=locked;
  const exists=Boolean(state.record);
  $('createDesign').hidden=exists;$('objectsSection').hidden=!exists;$('versionsSection').hidden=!exists;
  for(const id of ['saveDesign','snapshotDesign','downloadDesign'])$(id).disabled=locked||!exists;
  $('deleteObject').disabled=locked||!object();$('addImage').disabled=locked||!state.assets.length;
  $('restoreDesign').disabled=locked||!state.record?.versions.length;
  $('designAiSubmit').disabled=locked||!state.aiEnabled||!$('designAiPrompt').value.trim()||state.session?.job?.status==='running';
  $('designAiSubmit').textContent=exists?'AI 修改当前设计稿':'AI 生成可编辑稿';
  $('designAiStop').hidden=!aiRunning();$('designAiStop').disabled=state.busy||!aiRunning();
  for(const input of document.querySelectorAll('[data-ai-reference]'))input.disabled=locked||(!input.checked&&state.referenceIds.size>=8);
  $('designAiReferenceLabel').textContent=`本轮参考图 · ${state.referenceIds.size} / 8 · 随消息发送`;
  if(!state.busy)$('designStatus').textContent=state.dirty?'有未保存修改':exists?'已保存':'尚未创建设计稿';
  $('dirtyPreview').hidden=!state.dirty;
}
async function working(task){if(state.busy)return;state.busy=true;controls();try{await task();}catch(e){message(e.message);}finally{state.busy=false;controls();}}
function render(){
  const p=page(),chosenAsset=$('assetSelect').value;
  if(p){$('designTitle').value=state.record.document.title;$('pageWidth').value=displayNumber(p.width);$('pageHeight').value=displayNumber(p.height);$('pageUnit').value=p.unit;$('pageBackground').value=p.background;$('designPageLabel').textContent=`${p.name} · ${displayNumber(p.width)} × ${displayNumber(p.height)} ${p.unit}`;}
  $('assetSelect').innerHTML=state.assets.length?state.assets.map(a=>`<option value="${a.id}">${escape(a.name)}</option>`).join(''):'<option>在创作空间上传图片后可在此使用</option>';
  const source=state.assets.find(a=>a.id===state.sourceId);
  $('designSourceNotice').hidden=!source;
  if(source){
    $('designSourceThumbnail').src=source.url;
    const imported=p?.objects.some(o=>o.type==='image'&&o.assetId===source.id);
    $('designSourceText').textContent=!p?'已带入当前图片，可勾选参考图后让 AI 排成可编辑对象，也可整体插入原图。整体插入时，原图文字不能逐字修改。':imported?'原图已作为独立图片对象放入。可让 AI 根据参考图重新排版，或手动添加独立文字、Logo；直接插入的原图文字不能逐字修改。':'已打开这个会话原有的设计稿。当前图片可作为 AI 参考，也可从素材列表插入。';
    $('assetSelect').value=state.assets.some(a=>a.id===chosenAsset)?chosenAsset:source.id;
    $('createDesign').textContent='以当前图片创建设计稿';
  }
  $('objectList').innerHTML=(p?.objects||[]).map(o=>`<button type="button" data-object="${o.id}" class="${o.id===state.selected?'selected':''}">${escape(o.type==='text'?o.text||'空文字':o.type==='rect'?'色块':state.assets.find(a=>a.id===o.assetId)?.name||'图片')}</button>`).join('');
  for(const button of document.querySelectorAll('[data-object]'))button.onclick=()=>{state.selected=button.dataset.object;render();};
  $('designVersions').innerHTML=state.record?.versions.length?state.record.versions.map(v=>`<option value="${v.id}">V${v.number} · ${escape(v.label)}</option>`).reverse().join(''):'<option>尚未保存版本</option>';
  properties();renderContent();renderAI();controls();
}
function updateContent(field,value){
  field.value=value;
  for(const p of state.record.document.pages)for(const o of p.objects)if(o.type==='text'&&o.bindingId===field.id)o.text=value;
  const selected=object(),input=$('objectProperties').querySelector('[data-property="text"]');if(input&&selected?.bindingId===field.id)input.value=value;
  changed();
}
function renderContent(){
  const fields=state.record?.document.content||[];$('contentSection').hidden=!fields.length;
  const pending=fields.filter(f=>f.status==='needs_confirmation').length;
  $('reviewContent').hidden=!fields.length;$('reviewContent').textContent=pending?`核对内容 · ${pending} 项待核对`:'核对内容';
  $('designContent').innerHTML=fields.map(f=>`<div class="design-content-row" data-pending="${f.status==='needs_confirmation'}"><label>${escape(f.label)}<textarea data-content="${f.id}" maxlength="10000">${escape(f.value)}</textarea></label><label class="design-confirm"><input type="checkbox" data-confirm="${f.id}" ${f.status==='confirmed'?'checked':''}><span>${f.status==='confirmed'?'已核对':'待核对'}</span></label>${f.sourceId?`<small>来源：${escape(state.assets.find(a=>a.id===f.sourceId)?.name||'参考图')}</small>`:''}</div>`).join('');
  for(const input of document.querySelectorAll('[data-content]'))input.oninput=()=>updateContent(fields.find(f=>f.id===input.dataset.content),input.value);
  for(const input of document.querySelectorAll('[data-confirm]'))input.onchange=()=>{
    const f=fields.find(f=>f.id===input.dataset.confirm);f.status=input.checked?'confirmed':'needs_confirmation';input.closest('.design-content-row').dataset.pending=String(!input.checked);input.nextElementSibling.textContent=input.checked?'已核对':'待核对';changed();
  };
}
function properties(){
  const o=object(),p=page(),root=$('objectProperties');if(!o){root.innerHTML='';return;}
  const field=(key,label)=>`<label>${label}<input data-property="${key}" type="number" step="0.1" min="${key==='x'||key==='y'?0:.1}" value="${displayNumber(o[key])}"></label>`;
  root.innerHTML=`${o.type==='text'?`<label>文字内容<textarea data-property="text" maxlength="10000">${escape(o.text)}</textarea></label>`:''}<div class="design-fields">${field('x',`X（${p.unit}）`)}${field('y',`Y（${p.unit}）`)}${field('width',`宽度（${p.unit}）`)}${field('height',`高度（${p.unit}）`)}${o.type==='text'?`${field('fontSize','字号（pt）')}<label>文字颜色<input type="color" data-property="color" value="${o.color}"></label>`:o.type==='rect'?`<label>填充颜色<input type="color" data-property="fill" value="${o.fill}"></label>`:''}</div>${o.type==='image'?`<label>图片适配<select data-property="fit"><option value="contain" ${o.fit==='contain'?'selected':''}>完整显示</option><option value="cover" ${o.fit==='cover'?'selected':''}>居中裁切填充</option></select></label>`:''}`;
  for(const input of root.querySelectorAll('[data-property]'))input.oninput=()=>{
    const value=input.type==='number'?Number(input.value):input.value;
    if(input.type==='number'&&(!input.value||!Number.isFinite(value)))return;
    if(input.dataset.property==='text'&&o.bindingId){const field=state.record.document.content?.find(f=>f.id===o.bindingId);if(field){updateContent(field,value);const textarea=document.querySelector(`[data-content="${field.id}"]`);if(textarea)textarea.value=value;}}
    else o[input.dataset.property]=value;
    changed();
  };
}
async function refreshPreview(){
  if(!state.record)return;
  const p=page(),revision=state.record.revision;
  const [response,preflight]=await Promise.all([fetch(endpoint(`/preview?pageId=${p.id}&revision=${revision}`)),request(endpoint('/preflight'))]);
  if(!response.ok){const error=await response.json();throw new Error(error.error||'预览失败');}
  const url=URL.createObjectURL(await response.blob()),old=previewUrl;previewUrl=url;
  $('designPreview').src=url;$('designPreview').hidden=false;$('designEmpty').hidden=true;
  if(old)URL.revokeObjectURL(old);
  $('designIssues').innerHTML=preflight.issues.map(i=>`<div class="design-issue-${i.severity}">${escape(i.message)}</div>`).join('');
}
async function save(){
  if(!state.dirty)return;
  accept(await request(endpoint(),'PUT',{revision:state.record.revision,document:state.record.document}));render();await refreshPreview();
}
$('createDesign').onclick=()=>working(async()=>{
  accept(await request(endpoint(),'POST',{title:$('designTitle').value,width:Number($('pageWidth').value),height:Number($('pageHeight').value),unit:$('pageUnit').value,background:$('pageBackground').value,...(state.assets.some(a=>a.id===state.sourceId)?{sourceId:state.sourceId}:{})}));render();await refreshPreview();
});
for(const [id,key] of [['designTitle','title'],['pageWidth','width'],['pageHeight','height'],['pageBackground','background']])$(id).oninput=()=>{
  if(!state.record)return;
  const value=id==='pageWidth'||id==='pageHeight'?Number($(id).value):$(id).value;
  if(id==='designTitle')state.record.document.title=value;else page()[key]=value;changed();
};
$('pageUnit').onchange=()=>{
  const p=page();if(!p)return;
  const next=$('pageUnit').value,factor=p.unit===next?1:p.unit==='px'?25.4/96:96/25.4;
  for(const o of [p,...p.objects])for(const key of o===p?['width','height']:['x','y','width','height']){
    const value=o[key]*factor;o[key]=Math.abs(value-Math.round(value))<1e-8?Math.round(value):value;
  }
  p.unit=next;changed();render();
};
function add(type){
  const p=page();if(!p)return;
  const o={id:crypto.randomUUID(),type,x:p.width*.08,y:p.height*.08,width:p.width*.84,height:p.height*.22};
  if(type==='text')Object.assign(o,{text:'输入你的文字',fontSize:Math.max(4,Math.min(28,p.width*(p.unit==='mm'?72/25.4:72/96)*.08)),lineHeight:1.35,color:'#292a31',align:'left'});
  if(type==='rect')Object.assign(o,{fill:'#7961cf',y:p.height*.65});
  if(type==='image')Object.assign(o,{assetId:$('assetSelect').value,fit:'contain',y:p.height*.35,width:p.width*.4,height:p.height*.35});
  p.objects.push(o);state.selected=o.id;changed();render();
}
$('addText').onclick=()=>add('text');$('addShape').onclick=()=>add('rect');$('addImage').onclick=()=>add('image');
$('deleteObject').onclick=()=>{page().objects=page().objects.filter(o=>o.id!==state.selected);state.selected=null;changed();render();};
$('saveDesign').onclick=()=>working(async()=>{await save();message('设计稿已保存，预览已更新。');});
$('snapshotDesign').onclick=()=>working(async()=>{await save();accept(await request(endpoint('/versions'),'POST',{revision:state.record.revision,label:`设计版本 ${state.record.versions.length+1}`}));render();message('已保存新的设计版本。');});
$('restoreDesign').onclick=()=>working(async()=>{
  if(state.dirty)await save();
  accept(await request(endpoint('/restore'),'POST',{revision:state.record.revision,versionId:$('designVersions').value}));state.selected=null;render();await refreshPreview();message('已恢复所选版本，历史版本保留。');
});
function exportOptions(){
  const value=$('designFormat').value,cmyk=value==='pdf-cmyk';$('scaleField').hidden=value.startsWith('pdf');
  $('profileInfo').hidden=!cmyk;
  if(cmyk){const profile=state.capabilities?.profile;$('profileInfo').textContent=profile?`色彩配置：${profile.name}${profile.custom?'':'（内置验证配置）'}。当前 PDF 未经过 PDF/X 符合性认证。`:state.capabilities?.profileError||'CMYK 配置不可用';}
}
$('designFormat').onchange=exportOptions;
$('downloadDesign').onclick=()=>working(async()=>{
  await save();const value=$('designFormat').value,format=value.startsWith('pdf')?'pdf':value,colorSpace=value==='pdf-cmyk'?'cmyk':'rgb';
  const response=await fetch(endpoint('/export'),{method:'POST',headers:{'Content-Type':'application/json','X-Studio-Token':state.token},body:JSON.stringify({revision:state.record.revision,pageId:page().id,format,colorSpace,scale:Number($('designScale').value)})});
  if(!response.ok){const error=await response.json();throw new Error(error.error||'文件下载失败');}
  const url=URL.createObjectURL(await response.blob()),a=document.createElement('a');a.href=url;a.download=`${state.record.document.title}-${colorSpace}.${format==='jpeg'?'jpg':format}`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);message('文件已生成。');
});
function renderAI(){
  $('designAiReferences').innerHTML=state.assets.length?state.assets.map(a=>`<label class="design-ai-reference"><input type="checkbox" data-ai-reference="${a.id}" ${state.referenceIds.has(a.id)?'checked':''}><img src="${escape(a.url)}" alt=""><span>${escape(a.name)}</span></label>`).join(''):'<p class="design-help">可直接输入内容；需要参考图片时，先在创作空间上传。</p>';
  for(const input of document.querySelectorAll('[data-ai-reference]'))input.onchange=()=>{if(input.checked)state.referenceIds.add(input.dataset.aiReference);else state.referenceIds.delete(input.dataset.aiReference);controls();};
  renderAIStatus();
}
function renderAIStatus(){
  const job=state.session?.job,designJob=job?.outputMode==='design';
  $('designAiStatus').textContent=state.mode==='demo'?'当前为演示模式，配置创作引擎后可使用 AI 设计。':!state.aiEnabled?'AI 设计暂不可用，请刷新页面或重启本地服务。':aiRunning()?`AI 正在处理：${job.events.at(-1)?.text||'理解设计要求'}。完成后自动更新预览。`:job?.status==='running'?'创作空间还有任务进行中，请等待完成。':designJob?job.designResult?'本轮已保存可编辑版本，可继续核对内容或修改。':'本轮未保存新设计版本，请查看回复。':'AI 将按画布设置制作；成功后自动保存设计版本。';
  const reply=designJob?state.session.messages.findLast(m=>m.role==='assistant'&&m.task?.id===job.id)?.text||job.error||'':'';
  $('designAiReply').textContent=state.aiNotice||reply;$('designAiReply').hidden=!$('designAiReply').textContent;
}
function scheduleAI(){clearTimeout(aiPollTimer);if(state.session?.job?.status==='running')aiPollTimer=setTimeout(pollAI,850);}
async function pollAI(){
  try{
    state.session=await request(`/api/sessions/${state.sessionId}`);const job=state.session.job;
    if(job?.outputMode==='design'&&!state.dirty&&!state.busy&&(job.status!=='running'||job.designResult?.revision!==undefined&&job.designResult.revision!==state.record?.revision)){
      accept(await request(endpoint()));render();if(state.record)await refreshPreview();
    }
    renderAIStatus();controls();
  }catch(error){state.aiNotice=error.message;renderAIStatus();}
  finally{scheduleAI();}
}
$('designAiPrompt').oninput=controls;
$('reviewContent').onclick=()=>$('contentSection').scrollIntoView({block:'start',behavior:'smooth'});
$('designAiForm').onsubmit=event=>{event.preventDefault();working(async()=>{
  if(!state.aiEnabled||state.session?.job?.status==='running')return;
  await save();state.aiNotice='';
  try{
    const data=await request(`/api/sessions/${state.sessionId}/turns`,'POST',{text:$('designAiPrompt').value.trim(),requestId:crypto.randomUUID(),design:{revision:state.record?.revision??null,canvas:{title:$('designTitle').value,width:Number($('pageWidth').value),height:Number($('pageHeight').value),unit:$('pageUnit').value,background:$('pageBackground').value},referenceIds:[...state.referenceIds]}});
    state.session=data.session;state.referenceIds.clear();
    const url=new URL(location.href);url.searchParams.delete('source');history.replaceState(null,'',url);renderAI();scheduleAI();
  }catch(error){state.aiNotice=error.message;renderAIStatus();await pollAI();throw error;}
});};
$('designAiStop').onclick=()=>working(async()=>{await request(`/api/sessions/${state.sessionId}/cancel`,'POST',{});message('已请求停止，已保存的版本会保留。');scheduleAI();});
window.addEventListener('focus',()=>{if(state.sessionId&&!state.busy&&!state.dirty)pollAI();});
window.addEventListener('beforeunload',event=>{if(state.dirty){event.preventDefault();event.returnValue='';}});
await working(async()=>{
  const config=await request('/api/config');state.token=config.token;state.mode=config.mode;state.aiEnabled=config.editableDesign===true;
  if(!state.sessionId){$('designStatus').textContent='请从创作空间打开设计稿';throw new Error('请从创作空间顶部的“编辑设计稿”入口打开当前会话。');}
  const [data,capabilities,session]=await Promise.all([request(endpoint()),request('/api/design/capabilities'),request(`/api/sessions/${state.sessionId}`)]);accept(data);state.capabilities=capabilities;state.session=session;
  state.referenceIds=new Set((session.referenceIds.length?session.referenceIds:state.sourceId?[state.sourceId]:[]).filter(id=>state.assets.some(a=>a.id===id)).slice(0,8));
  const source=state.assets.find(a=>a.id===state.sourceId);
  if(!state.record&&source){$('designTitle').value=source.name.slice(0,100);if(source.width&&source.height){$('pageWidth').value=source.width;$('pageHeight').value=source.height;}}
  render();exportOptions();if(state.record)await refreshPreview();scheduleAI();
});
