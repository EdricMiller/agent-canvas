import { originalFor, productPanelMarkup, taskMarkup } from './product.js';
import { initDebugPanel } from './debug.js';
const $=id=>document.getElementById(id);
const paths={sparkles:'m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z',grid:'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',history:'M3 11a9 9 0 1 1 2 7 M3 4v7h7 M12 7v5l3 2',layers:'m12 3 10 5-10 5L2 8l10-5Z M2 12l10 5 10-5 M2 16l10 5 10-5',settings:'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M12 2v3 M12 19v3 M2 12h3 M19 12h3 M5 5l2 2 M17 17l2 2 M5 19l2-2 M17 7l2-2',plus:'M12 5v14 M5 12h14',download:'M12 3v12 m-5-5 5 5 5-5 M4 16v5h16v-5',upload:'M12 16V3 m-5 5 5-5 5 5 M4 16v5h16v-5',arrow:'M12 19V5 m-6 6 6-6 6 6',right:'m9 5 7 7-7 7',image:'M3 3h18v18H3z m0 14 6-6 5 5 3-3 4 4 M15 7h.01',layout:'M3 3h18v18H3z M3 9h18 M9 9v12',camera:'M3 7h4l2-3h6l2 3h4v13H3z M12 10a3 3 0 1 0 0 6 3 3 0 0 0 0-6',brush:'m14 3 7 7-10 10-7-7L14 3Z M4 13l-2 9 9-2',paperclip:'m8 12 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l9-9',more:'M5 12h.01 M12 12h.01 M19 12h.01'};
const icon=(name,size=18)=>`<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name]||paths.sparkles}"/></svg>`;
paths.sliders='M4 7h7 M15 7h5 M4 17h3 M11 17h9 M11 4v6 M7 14v6';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const state={config:null,skills:[],session:null,pending:false,zoom:1};
let pollTimer,toastTimer,lastMessageSignature='';
for(const [id,name] of Object.entries({workspaceNav:'grid',sessionsNav:'history',skillsNav:'layers',settingsNav:'settings',sessionMenu:'more',attachButton:'paperclip',sendButton:'arrow',canvasIcon:'image',skillChevron:'right'}))$(id).innerHTML=icon(name);
$('debugNav').innerHTML=icon('sliders');$('debugButton').innerHTML=icon('sliders',16);
$('newSession').innerHTML=icon('plus')+'新建创作';$('exportButton').innerHTML=icon('download')+'导出图片';$('uploadButton').innerHTML=icon('upload')+'上传图片';
function toast(text){$('toast').textContent=text;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,6000);}
function localGet(key){try{return localStorage.getItem(key);}catch{return null;}}
function localSet(key,value){try{localStorage.setItem(key,value);}catch{}}
async function api(url,options={}){
  const response=await fetch(url,{...options,headers:{'Content-Type':'application/json','X-Studio-Token':state.config?.token||'',...options.headers}});
  const data=await response.json();if(!response.ok)throw new Error(data.error||'请求失败');return data;
}
const running=()=>state.session?.job?.status==='running';
const selected=()=>state.session?.versions.find(v=>v.id===state.session.selectedId);
function controls(){
  const locked=running()||state.pending||!state.session;
  for(const id of ['skillSelector','attachButton','uploadButton'])$(id).disabled=locked;
  $('sendButton').disabled=locked||!$('prompt').value.trim();$('sendButton').hidden=running();$('stopButton').hidden=!running();$('stopButton').disabled=state.pending;
  $('exportButton').disabled=!selected();
  $('saveStatus').textContent=running()?'创作中':'已保存';
}
initDebugPanel({api,toast,onConfig:config=>{state.config=config;controls();}});
function eventMarkup(events){return events.map(e=>e.type==='plan'?`<div class="event plan">${e.steps.map((s,i)=>`<div>${i+1}. ${esc(s)}</div>`).join('')}</div>`:`<div class="event ${esc(e.type)}">${esc(e.text||'')}</div>`).join('');}
function welcome(){return `<div class="welcome-avatar">✳</div><div class="welcome-title">你好，今天想创作些什么？</div><p class="welcome-copy">给我一个想法、一张图片，或一点灵感。<br>我会运用你选择的技能，陪你把它变成作品。</p><div class="suggestions"><button class="suggestion" data-prompt="设计一张以陶瓷花瓶为主角的杂志海报，暖色调、大面积留白，不添加虚构品牌文案。"><span>${icon('layout')}</span>设计一张有留白感的杂志海报<span>↗</span></button><button class="suggestion" data-prompt="基于我上传的商品实拍，制作一张适合社交分享的商品推广图。根据商品和用途决定画面表达、构图及是否需要文字；商品信息以实拍和我提供的资料为准，不编造品牌、价格或优惠。"><span>${icon('camera')}</span>把商品实拍，做成推广图<span>↗</span></button><button class="suggestion" data-prompt="画一幅温暖的水彩插画：窗边的猫和绿植，午后阳光，细腻纸张肌理。"><span>${icon('brush')}</span>把午后的灵感，画成水彩<span>↗</span></button></div><div class="welcome-note">${icon('history',13)} 每个版本都会保存，放心尝试新想法。</div>`;}
function renderMessages(){
  const s=state.session, signature=JSON.stringify([s.id,s.messages,s.job]);
  if(signature===lastMessageSignature)return;lastMessageSignature=signature;
  const nearBottom=$('messages').scrollHeight-$('messages').scrollTop-$('messages').clientHeight<100;
  $('messages').innerHTML=s.messages.length?s.messages.map(m=>`<article class="message ${m.role==='user'?'user':'assistant'} ${m.error?'error':''}"><div class="message-label">${m.role==='user'?'你':`<span class="mini-avatar">✳</span>画语助手`}</div><div class="message-text">${esc(m.text)}</div>${m.role==='user'?`<div class="message-context">${m.skillName?`<span>✧ ${esc(m.skillName)}</span>`:''}${m.sourceId?`<span>基于 V${s.versions.find(v=>v.id===m.sourceId)?.number||'?'}</span>`:''}</div>`:''}${m.events?.length?`<details class="event-log"><summary>查看执行记录 · ${m.events.length} 个事件</summary>${eventMarkup(m.events)}</details>`:''}${m.role==='assistant'?taskMarkup(m.task):''}</article>`).join(''):welcome();
  if(running())$('messages').insertAdjacentHTML('beforeend',`<div class="activity"><div class="activity-heading"><span class="spinner"></span>${state.config.mode==='demo'?'演示流程正在运行':'助手正在创作'}</div>${eventMarkup(s.job.events)}</div>`);
  if(nearBottom||running())$('messages').scrollTop=$('messages').scrollHeight;
  document.querySelectorAll('[data-prompt]').forEach(button=>button.onclick=()=>{$('prompt').value=button.dataset.prompt;localSet(`draft-${s.id}`,$('prompt').value);controls();$('prompt').focus();});
}
function render(){
  const s=state.session;if(!s)return;
  const skill=state.skills.find(k=>k.id===s.skillId);
  const productMode=skill?.workflow==='product-promotion';
  $('selectedSkillName').textContent=skill?.name||'自由创作';$('selectedSkillIcon').innerHTML=icon(skill?.icon||'sparkles');
  $('projectTitle').textContent=s.title;
  const image=selected();$('emptyCanvas').hidden=!!image;$('imageStage').hidden=!image;$('imageMeta').hidden=!image;$('selectedContext').hidden=!image;
  if(image){
    if($('canvasImage').getAttribute('src')!==image.url)$('canvasImage').src=image.url;
    $('canvasImage').alt=`V${image.number} · ${image.label}`;
    $('imageMeta').textContent=`V${image.number} · ${image.width} × ${image.height} · ${image.demo?'演示示意图':image.kind==='upload'?'原始图片':image.product?'商品推广图':'生成图片'}`;
    $('selectedContext').innerHTML=`<img src="${esc(image.url)}" alt=""><span>正在基于 V${image.number} 继续创作</span><button id="clearSelection" aria-label="取消选中图片" ${running()?'disabled':''}>×</button>`;
    $('clearSelection').onclick=()=>update({selectedId:null});
  }
  const productPanel=$('productPanel');
  const open=[...productPanel.querySelectorAll('details[open]')].map(el=>el.className);
  const productMarkup=productMode?productPanelMarkup(s):'';
  productPanel.innerHTML=productMarkup;productPanel.hidden=!productMarkup;
  for(const detail of productPanel.querySelectorAll('details'))if(open.includes(detail.className))detail.open=true;
  const original=image&&(productMode||image.productSourceId)?originalFor(s,image):null;
  $('compareButton').hidden=!original||original.id===image?.id;
  $('canvasStatus').textContent=running()?'助手创作中，完成后将在这里显示。':image?'选择历史版本，可以从那里继续创作。':'每一次灵感，都值得保留。';
  $('versionCount').textContent=s.versions.length;
  $('versions').innerHTML=s.versions.length?s.versions.map(v=>`<button class="version-card ${v.id===s.selectedId?'selected':''}" data-version="${v.id}" ${running()?'disabled':''} title="V${v.number} · ${esc(v.label)}${v.parentId?' · 基于 V'+s.versions.find(p=>p.id===v.parentId)?.number:''}" aria-label="选择版本 ${v.number}" aria-pressed="${v.id===s.selectedId}"><img src="${esc(v.url)}" alt="${esc(v.label)}"><span>V${v.number}${v.demo?' · 演示':''}</span>${v.parentId?'<i class="branch-dot"></i>':''}</button>`).join(''):'<div class="version-empty">生成的图片会保存在这里，随时回到任何一个版本。</div>';
  document.querySelectorAll('[data-version]').forEach(b=>b.onclick=()=>{state.zoom=1;applyZoom();update({selectedId:b.dataset.version});});
  renderMessages();controls();
}
function schedulePoll(){clearTimeout(pollTimer);if(running())pollTimer=setTimeout(refresh,850);}
async function refresh(){
  if(!state.session)return;const id=state.session.id;
  try{const session=await api(`/api/sessions/${id}`);if(state.session.id!==id)return;state.session=session;render();schedulePoll();}
  catch(error){toast(error.message);if(state.session.id===id&&running())pollTimer=setTimeout(refresh,3500);}
}
async function useSession(session){clearTimeout(pollTimer);state.session=session;state.zoom=1;lastMessageSignature='';localSet('canvas-session',session.id);$('prompt').value=localGet(`draft-${session.id}`)||'';applyZoom();render();schedulePoll();}
async function update(body){if(state.pending||running())return;state.pending=true;controls();try{const id=state.session.id;const s=await api(`/api/sessions/${id}`,{method:'PATCH',body:JSON.stringify(body)});if(state.session.id===id)state.session=s;}catch(e){toast(e.message);}finally{state.pending=false;render();}}
async function createSession(){if(state.pending)return;state.pending=true;controls();try{await useSession(await api('/api/sessions',{method:'POST'}));}catch(e){toast(e.message);}finally{state.pending=false;controls();}}
$('newSession').onclick=createSession;
$('workspaceNav').onclick=()=>{document.querySelectorAll('dialog[open]').forEach(d=>d.close());$('prompt').focus();};
$('compareButton').onclick=()=>{
  const image=selected(),original=originalFor(state.session,image);if(!image||!original||original.id===image.id)return;
  $('compareOriginal').src=original.url;$('compareResult').src=image.url;
  $('compareOriginalLabel').textContent=`商品原图 · V${original.number}`;$('compareResultLabel').textContent=`成品 · V${image.number}`;
  $('compareDialog').showModal();
};

$('prompt').oninput=()=>{if(state.session)localSet(`draft-${state.session.id}`,$('prompt').value);controls();};
$('prompt').onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();if(!$('sendButton').disabled)$('composer').requestSubmit();}};
$('composer').onsubmit=async e=>{
  e.preventDefault();const text=$('prompt').value.trim();if(!text||running()||state.pending||!state.session)return;
  state.pending=true;controls();const id=state.session.id;
  try{
    const {session}=await api(`/api/sessions/${id}/turns`,{method:'POST',body:JSON.stringify({text,requestId:crypto.randomUUID()})});
    localSet(`draft-${id}`,'');if(state.session.id===id){state.session=session;$('prompt').value='';render();schedulePoll();}
  }catch(error){toast(error.message);}finally{state.pending=false;controls();}
};
$('stopButton').onclick=async()=>{state.pending=true;controls();try{await api(`/api/sessions/${state.session.id}/cancel`,{method:'POST'});await refresh();}catch(e){toast(e.message);}finally{state.pending=false;controls();}};
function showSkills(){
  if(!state.session||running()){toast('请先等待当前创作完成');return;}
  const list=[{id:null,name:'自由创作',description:'不使用特定技能，直接描述你想要的画面。',icon:'sparkles'},...state.skills];
  $('skillList').innerHTML=list.map(s=>`<button class="skill-card ${s.id===state.session.skillId?'selected':''}" data-skill="${esc(s.id||'')}" ${s.unsupported?'disabled':''}><span class="skill-icon">${icon(s.icon||'sparkles')}</span><span class="skill-card-text"><strong>${esc(s.name)}</strong><p>${esc(s.description)}</p>${s.unsupported?`<small>${esc(s.unsupportedReason||'需要适配连接器或依赖')}</small>`:s.canRunScripts?'<small>支持 Docker 脚本</small>':''}</span><span class="skill-check">${s.id===state.session.skillId?'✓':icon('right',14)}</span></button>`).join('');
  document.querySelectorAll('[data-skill]').forEach(b=>b.onclick=async()=>{await update({skillId:b.dataset.skill||null});$('skillsDialog').close();});
  if(!$('skillsDialog').open)$('skillsDialog').showModal();
}
$('skillSelector').onclick=showSkills;$('skillsNav').onclick=showSkills;
async function showSessions(){
  try{const sessions=await api('/api/sessions');$('sessionList').innerHTML=sessions.map(s=>`<button class="session-card" data-session="${s.id}">${s.thumbnail?`<img src="${esc(s.thumbnail)}" alt="">`:'<span class="session-placeholder">✧</span>'}<span><strong>${esc(s.title)}</strong><small>${new Date(s.updatedAt).toLocaleString('zh-CN')}${s.status==='running'?' · 创作中':''}</small></span></button>`).join('')||'<p class="dialog-description">还没有创作，开始你的第一个想法吧。</p>';document.querySelectorAll('[data-session]').forEach(b=>b.onclick=async()=>{try{await useSession(await api(`/api/sessions/${b.dataset.session}`));$('sessionsDialog').close();}catch(e){toast(e.message);}});$('sessionsDialog').showModal();}catch(e){toast(e.message);}
}
$('sessionsNav').onclick=showSessions;$('sessionMenu').onclick=showSessions;
  $('settingsNav').onclick=()=>{const c=state.config;if(!c)return;$('settingsContent').innerHTML=`<div class="settings-row"><span>运行状态</span><strong>${c.mode==='demo'?'演示模式 · 无 AI 调用':'已配置真实 API'}</strong></div><div class="settings-row"><span>任务执行</span><span>OpenAI Agents SDK</span></div><div class="settings-row"><span>对话模型</span><span>${esc(c.agentModel)}</span></div><div class="settings-row"><span>图片模型</span><span>${esc(c.imageModel)}</span></div><div class="settings-row"><span>Sandbox</span><span>${esc(c.sandboxMode||'off')}</span></div><div class="settings-row"><span>图片调用上限</span><span>${c.maxImages==='unlimited'?'由用户和助手决定':`${c.maxImages} 次`}</span></div><p class="settings-note">${c.mode==='demo'?'当前展示的是本地示意图，不会理解或真实编辑图片。请在服务端配置 API Key 并重启。':'凭据只在服务端读取，不发送给浏览器。任务执行会产生模型和图片 API 费用。'}<br>图片和 Agent 回合均不设固定上限，任务仍受 5 分钟超时和“停止”按钮控制。会话和图片保存在本机。Skills 支持指令、参考资料、受控 Docker 脚本和已注册连接器；MCP 或未注册连接器仍需适配。</p>`;$('settingsDialog').showModal();};
for(const b of document.querySelectorAll('.close-dialog'))b.onclick=()=>b.closest('dialog').close();
for(const d of document.querySelectorAll('dialog'))d.onclick=e=>{if(e.target===d){const r=d.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)d.close();}};
async function upload(file){
  if(!file||running()||state.pending)return;
  if(!['image/png','image/jpeg','image/webp'].includes(file.type))return toast('请选择 PNG、JPEG 或 WebP 图片');
  if(file.size>10*1024*1024)return toast('图片最大 10 MB');
  state.pending=true;controls();const id=state.session.id;
  try{const data=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=reject;r.readAsDataURL(file);});const result=await api(`/api/sessions/${id}/upload`,{method:'POST',body:JSON.stringify({data,name:file.name})});if(state.session.id===id)state.session=result.session;toast('图片已加入画布，告诉助手如何调整它。');}
  catch(e){toast(e.message||'上传失败');}finally{state.pending=false;render();$('imageInput').value='';}
}
for(const id of ['attachButton','uploadButton'])$(id).onclick=()=>$('imageInput').click();
$('imageInput').onchange=()=>upload($('imageInput').files[0]);
let dragDepth=0;
$('canvasSurface').ondragenter=e=>{e.preventDefault();dragDepth++;if(!running())$('dropOverlay').hidden=false;};
$('canvasSurface').ondragover=e=>e.preventDefault();
$('canvasSurface').ondragleave=e=>{e.preventDefault();if(--dragDepth<=0)$('dropOverlay').hidden=true;};
$('canvasSurface').ondrop=e=>{e.preventDefault();dragDepth=0;$('dropOverlay').hidden=true;upload(e.dataTransfer.files[0]);};
window.addEventListener('paste',e=>{const image=[...(e.clipboardData?.files||[])].find(f=>f.type.startsWith('image/'));if(image){e.preventDefault();upload(image);}});
$('importSkill').onclick=()=>$('skillInput').click();
$('skillInput').onchange=async()=>{const file=$('skillInput').files[0];if(!file)return;if(file.size>64000)return toast('技能文件最大 64 KB');try{await api('/api/skills',{method:'POST',body:JSON.stringify({text:await file.text()})});state.skills=await api('/api/skills');showSkills();toast('技能已导入。如果有配套参考文件，请使用服务端技能目录。');}catch(e){toast(e.message);}finally{$('skillInput').value='';}};
$('importSkillUrl').onclick=async()=>{const sourceUrl=$('skillUrl').value.trim();if(!sourceUrl)return toast('请输入 GitHub 仓库地址');$('importSkillUrl').disabled=true;try{const result=await api('/api/skills',{method:'POST',body:JSON.stringify({sourceUrl})});state.skills=await api('/api/skills');$('skillUrl').value='';showSkills();toast(`已从 GitHub 导入 ${result.imported?.length||0} 个 Skill`);}catch(e){toast(e.message);}finally{$('importSkillUrl').disabled=false;}};
$('exportButton').onclick=()=>{const v=selected();if(!v)return;const a=document.createElement('a');a.href=v.url;a.download=`canvas-v${v.number}.png`;a.click();};
function applyZoom(){$('artboard').style.transform=`scale(${state.zoom})`;$('zoomReset').textContent=state.zoom===1?'适应':Math.round(state.zoom*100)+'%';}
$('zoomIn').onclick=()=>{state.zoom=Math.min(2.5,state.zoom+.25);applyZoom();};$('zoomOut').onclick=()=>{state.zoom=Math.max(.25,state.zoom-.25);applyZoom();};$('zoomReset').onclick=()=>{state.zoom=1;applyZoom();};
window.addEventListener('focus',()=>{if(state.session&&!state.pending)refresh();});
async function boot(){
  try{state.config=await api('/api/config');state.skills=await api('/api/skills');$('connection').textContent=state.config.mode==='demo'?'演示模式':'API 已配置';$('connection').classList.toggle('demo',state.config.mode==='demo');if(state.config.mode==='demo')$('composerHint').textContent='演示模式 · 本地示意图，不调用 AI';const sessions=await api('/api/sessions');const saved=localGet('canvas-session');const id=sessions.find(s=>s.id===saved)?.id||sessions[0]?.id;await useSession(id?await api(`/api/sessions/${id}`):await api('/api/sessions',{method:'POST'}));}catch(e){toast(`无法连接工作室：${e.message}`);$('connection').textContent='连接失败';}
}
boot();
