'use client';

import {useEffect,useRef,useState} from 'react';
import {useWorkspace} from '@/lib/use-workspace';
import {remember,stored} from '@/lib/api';
import type {SessionSummary} from '@/lib/types';
import {Inspector} from './inspector';
import {PageStrip} from './page-strip';
import {PaginationDialog} from './pagination-dialog';
import {DownloadDialog} from './download-dialog';
import {DebugDialog} from './debug-dialog';
import {Icon} from './icons';
import {Modal} from './modal';
import {DesignCanvas} from './design-canvas';
import {DraftNotices,SaveStatus} from './design-save';
import {ImageTargetControl,ImageOutputDetails,ImageInspector} from './image-target';
import {ImageComposeDialog} from './image-compose-dialog';

export function Workspace(){
  const w=useWorkspace(),[prompt,setPrompt]=useState(''),[tab,setTab]=useState<'canvas'|'content'|'objects'>('canvas');
  const [dialog,setDialog]=useState<'download'|'sessions'|'skills'|'debug'|'paginate'|'compose'|null>(null),[sessions,setSessions]=useState<SessionSummary[]>([]);
  const [inspectRequest,setInspectRequest]=useState(0);
  const [zoom,setZoom]=useState(1),[dragging,setDragging]=useState(false),[previewError,setPreviewError]=useState(false);
  const fileInput=useRef<HTMLInputElement>(null),messagesEnd=useRef<HTMLDivElement>(null),draftSession=useRef<string|null>(null);
  const keyboard=useRef({w,dialog});keyboard.current={w,dialog};
  useEffect(()=>{
    const handler=(event:KeyboardEvent)=>{
      const {w,dialog}=keyboard.current,target=event.target as HTMLElement;
      if(dialog||target?.closest('input,textarea,select,[contenteditable="true"]')||w.view!=='design'||w.locked||event.isComposing||!(event.metaKey||event.ctrlKey)||event.altKey)return;
      const key=event.key.toLowerCase();
      if(key==='z'){event.preventDefault();if(event.shiftKey)w.redo();else w.undo();}
      if(key==='y'&&!event.metaKey){event.preventDefault();w.redo();}
      if(key==='s'){event.preventDefault();w.operate(async()=>{await w.save();});}
    };
    window.addEventListener('keydown',handler);return()=>window.removeEventListener('keydown',handler);
  },[]);
  const s=w.session,record=w.data.design,p=w.activePage,image=s?.versions.find(v=>v.id===w.view);
  const isDesign=w.view==='design',references=(s?.referenceIds||[]).map(id=>s?.versions.find(v=>v.id===id)).filter(v=>!!v);
  const pending=w.document?.content?.filter(f=>f.status==='needs_confirmation').length||0;
  const skill=w.skills.find(item=>item.id===s?.skillId);
  const generated=s?.versions.filter(v=>v.kind!=='upload')||[];
  const imageIsReference=!!image&&!!s?.referenceIds.includes(image.id);
  useEffect(()=>{
    if(s?.id&&draftSession.current!==s.id){draftSession.current=s.id;setPrompt(stored(`draft-${s.id}`)||'');setZoom(1);}
  },[s?.id]);
  useEffect(()=>{messagesEnd.current?.scrollIntoView({block:'nearest',behavior:'smooth'});},[s?.messages.length,s?.job?.status]);
  useEffect(()=>setPreviewError(false),[s?.id,record?.revision,p?.id]);
  function changePrompt(value:string){setPrompt(value);if(s)remember(`draft-${s.id}`,value);}
  async function showSessions(){await w.operate(async()=>{setSessions(await w.api<SessionSummary[]>('/api/sessions'));setDialog('sessions');});}
  function chooseReference(id:string){
    if(w.locked)return;
    w.operate(async()=>{
      const ids=s?.referenceIds||[];
      if(!ids.includes(id)&&ids.length>=8)throw new Error('本轮最多 8 张参考图，请先移除不需要的图片');
      await w.patchSession({referenceIds:ids.includes(id)?ids.filter(value=>value!==id):[...ids,id]});
    });
  }
  const savedPage=record?.document.pages.find(page=>page.id===p?.id);
  const previewUrl=s&&record&&savedPage?`/api/sessions/${s.id}/design/preview?revision=${record.revision}&pageId=${savedPage.id}`:null;
  return <div className="app-shell" onDragOver={e=>{if(e.dataTransfer.types.includes('Files')){e.preventDefault();setDragging(true);}}} onDragLeave={e=>{if(!e.currentTarget.contains(e.relatedTarget as Node))setDragging(false);}} onDrop={e=>{e.preventDefault();setDragging(false);if(!w.running)w.upload([...e.dataTransfer.files]);}}>
    <aside className="rail" aria-label="主导航"><a className="brand-mark" href="/" aria-label="画语首页">✳</a><button className="rail-button active" aria-label="创作空间" onClick={()=>setDialog(null)}><Icon name="grid"/></button><button className="rail-button" aria-label="历史会话" onClick={showSessions}><Icon name="history"/></button><button className="rail-button" aria-label="技能库" onClick={()=>setDialog('skills')}><Icon name="layers"/></button><div className="rail-spacer"/><button className="rail-button" id="modelSettingsButton" aria-label="模型设置" onClick={()=>setDialog('debug')}><Icon name="settings"/></button><span className="avatar">你</span></aside>
    <div className="workspace">
      <header className="topbar"><a className="brand" href="/">画语 <span>Canvas</span><i/><small>个人创作空间</small></a><div className="top-actions"><span className={`connection ${w.config?.mode==='demo'?'demo':''}`}>{w.config?w.config.mode==='demo'?'演示模式':'API 已配置':'连接中'}</span><a id="imagePdfTool" className="btn" href="/convert"><Icon name="image"/><span>图片转 PDF</span></a><button id="newSession" className="btn" disabled={w.busy} onClick={()=>w.switchSession()}><Icon name="plus"/><span>新建创作</span></button><button id="saveDesign" className="btn" disabled={w.locked||w.saving||w.conflict||!record||!w.dirty} onClick={()=>w.operate(async()=>{await w.save();w.notify('设计稿已保存，预览已更新。');})}>保存修改</button><button id="exportButton" className="btn dark" disabled={w.locked||!(isDesign?record:image)} onClick={()=>setDialog('download')}><Icon name="download"/><span>下载作品</span></button></div></header>
      <main className="workbench">
        <section className="chat-panel" aria-label="对话创作">
          <div className="chat-heading"><span className="eyebrow">YOUR CREATIVE PARTNER</span><h1>从一个想法开始 <span>✧</span></h1></div>
          <button id="skillSelector" className="skill-selector" disabled={w.locked} onClick={()=>setDialog('skills')}><span className="skill-symbol"><Icon name="layout"/></span><span><small>当前创作技能</small><strong id="selectedSkillName">{skill?.name||'自由设计'}</strong></span><span className="skill-switch">切换 ›</span></button>
          <div className="messages" id="messages" aria-live="polite">
            {!s?.messages.length&&<div className="welcome"><span className="welcome-mark">✳</span><h2>你好，今天想创作些什么？</h2><p>给我内容、品牌素材或一点灵感。<br/>从海报到价目表，让想法变成可编辑的设计。</p>{['结合参考图，制作一张品牌活动海报','整理上传的明细和 Logo，设计一份价目表'].map(text=><button className="suggestion" key={text} onClick={()=>changePrompt(text)}><Icon name="layout"/>{text}<span>↗</span></button>)}<p className="welcome-note">先在右侧设置尺寸，再发送你的设计要求。</p></div>}
            {s?.messages.map(message=><article key={message.id} className={`message ${message.role} ${message.error?'failed':''}`}><span className="message-author">{message.role==='user'?'你':'✳ 创作助手'}</span><div className="message-text">{message.text}</div>{!!message.referenceIds?.length&&<div className="message-attachments">{message.referenceIds.map((id,index)=>{const asset=s.versions.find(v=>v.id===id);return asset?<a href={asset.url} target="_blank" rel="noreferrer" key={id} title={asset.label}><img src={asset.url} alt={`参考图 ${index+1}：${asset.label||''}`}/><small>{index+1}</small></a>:null;})}</div>}{message.task?.designResult&&<button className="design-result-link" onClick={()=>{w.setView('design');setTab('objects');}}>查看当前设计稿 · 本轮保存了 {message.task.designResult.pageCount||1} 页、{message.task.designResult.objectCount} 个对象 <span>↗</span></button>}{!!message.events?.length&&<details className="task-events"><summary>查看执行记录 · {message.events.length} 个事件</summary>{message.events.map(e=><div key={e.id}>{e.steps?e.steps.map((step,i)=><p key={i}>{i+1}. {step}</p>):e.text}</div>)}</details>}</article>)}
            {w.running&&<div className="running-status" role="status"><span className="spinner"/>助手正在创作<span>{s?.job?.events.at(-1)?.text||'理解需求并准备设计'}</span></div>}
            <div ref={messagesEnd}/>
          </div>
          <div className="composer-area"><div className="output-modes" aria-label="创作方式"><button aria-pressed={w.mode==='design'} disabled={w.locked||!s} onClick={()=>{w.setMode('design');w.setView('design');}}>可编辑设计</button><button aria-pressed={w.mode==='image'} disabled={w.locked||!s} onClick={()=>{w.setMode('image');w.setView(generated.find(v=>v.id===s?.selectedId)?.id||generated.at(-1)?.id||'image');}}>图片创作</button><small>{w.mode==='design'?'文字、图片可独立修改':skill?.workflow==='logo-design'?'一体化 Logo · 包含店名':'生成整张图片'}</small></div>
            {w.mode==='image'&&<ImageTargetControl w={w}/>}
            {skill?.workflow==='logo-design'&&<p className="logo-help">说明准确店名、风格，可上传多张参考照片；店名与图形统一设计为完整 Logo。请核对文字、人物相似度和透明边缘。需要文字独立编辑时请明确说明。</p>}
            {!!references.length&&<div className="reference-context" id="referenceContext"><div className="reference-heading">本轮参考图 · {references.length} / 8 <span>随消息发送</span></div><div className="reference-list">{references.map((asset,index)=><div className="reference-card" data-reference={asset.id} key={asset.id}><img src={asset.url} alt={asset.label||'参考图'}/><span>{index+1}</span><button aria-label={`移除参考图 ${index+1}`} disabled={w.locked} onClick={()=>chooseReference(asset.id)}>×</button></div>)}</div></div>}
            <form id="composer" className="composer" onSubmit={e=>{e.preventDefault();if(prompt.trim())w.submit(prompt.trim(),()=>changePrompt(''));}} onPaste={e=>{const files=[...e.clipboardData.files].filter(f=>f.type.startsWith('image/'));if(files.length&&!w.running){e.preventDefault();w.upload(files);}}}>
              <textarea id="prompt" aria-label="描述你的创作想法" placeholder={w.mode==='design'?'描述设计要求，或告诉我如何修改当前设计稿…':'描述想生成的图片，或如何调整图片…'} value={prompt} maxLength={12000} disabled={w.running||w.busy&&!w.uploading||!s} onChange={e=>changePrompt(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();if(prompt.trim()&&!w.locked)w.submit(prompt.trim(),()=>changePrompt(''));}}}/>
              <div className="composer-footer"><button type="button" id="attachButton" className="icon-button" aria-label="上传参考图片" disabled={w.locked||!s} onClick={()=>fileInput.current?.click()}><Icon name="paperclip"/></button><span>{w.mode==='design'?record?`修改第 ${(w.document?.pages.indexOf(p! )??0)+1} 页`:'按右侧画布设置创作':s?.imageTarget?'按已确认尺寸交付':'AI 自动构图'}</span>{w.running?<button type="button" id="stopButton" className="btn stop" disabled={w.busy} onClick={w.stop}>停止</button>:<button type="submit" id="sendButton" className="send-button" aria-label="发送消息" disabled={w.locked||!prompt.trim()||!s||w.mode==='design'&&!w.config?.editableDesign}><Icon name="arrow"/></button>}</div>
            </form><p className="composer-hint">{w.config?.mode==='demo'?'演示模式：可手动编辑；配置模型后启用 AI 设计':'Enter 发送 · Shift + Enter 换行'}</p>
          </div>
        </section>
        <section className="canvas-panel" aria-label="设计画布"><div className="canvas-toolbar"><div className="canvas-title"><Icon name={isDesign?'layout':'image'} size={17}/><strong>{isDesign?w.document?.title||s?.title||'未命名设计稿':image?.label||'图片作品'}</strong>{isDesign&&record?<SaveStatus w={w}/>:<span className="save-state">自由画布</span>}</div><div className="canvas-actions"><button id="composeImageButton" className="btn small" disabled={w.locked||!s} onClick={()=>setDialog('compose')}><Icon name="layers"/>{image?.composition?'调整组合':'图片组合'}</button>{isDesign&&record&&<><button id="undoDesign" className="btn small" aria-label="撤销" title="撤销 · ⌘/Ctrl Z" disabled={w.locked||!w.canUndo} onClick={w.undo}><span aria-hidden="true">↶</span>撤销</button><button id="redoDesign" className="btn small" aria-label="重做" title="重做 · ⌘/Ctrl Shift Z" disabled={w.locked||!w.canRedo} onClick={w.redo}><span aria-hidden="true">↷</span>重做</button><button className="btn small" disabled={w.locked||!w.document?.content?.length} onClick={()=>setTab('content')}>{pending?`${pending} 项待核对`:'核对内容'}</button><button id="snapshotDesign" className="btn small" disabled={w.locked} onClick={w.snapshot}>保存版本</button></>}{!isDesign&&image&&<button id="useImageAsReference" className="btn small" aria-pressed={imageIsReference} disabled={w.locked||image.demo||!imageIsReference&&references.length>=8} title={image.demo?'演示图片不可用作参考图':imageIsReference?'点击移出本轮参考':references.length>=8?'本轮最多 8 张参考图，请先移除不需要的图片':`将图片版本 V${image.number} 随下一条消息发送`} onClick={()=>chooseReference(image.id)}><Icon name="paperclip"/>{imageIsReference?'已加入本轮参考':'加入本轮参考'}</button>}{!isDesign&&(image||record)&&<button className="btn small" disabled={w.locked||image?.demo} onClick={()=>{w.setView('design');w.setMode('design');if(!record)w.create(image?.id);setTab('objects');}}>{record?'返回设计稿':'以此图创建设计稿'}</button>}</div></div>
          {isDesign&&<DraftNotices w={w}/>}
          {isDesign&&<PageStrip w={w} onPaginate={()=>setDialog('paginate')}/>}
          <div className="canvas-surface"><div className="canvas-top-label"><span className="live-dot"/>{isDesign?`可编辑设计稿${p?` · 第 ${w.document!.pages.indexOf(p)+1} / ${w.document!.pages.length} 页`:''}`:'图片作品'}<span>{isDesign&&p?`${Number(p.width.toFixed(2))} × ${Number(p.height.toFixed(2))} ${p.unit}`:'拖入图片添加参考素材'}</span></div>
            {isDesign&&p?<><DesignCanvas key={`${s?.id}-${p.id}`} w={w} zoom={zoom} onSelect={()=>setTab('objects')} onInspect={()=>{setTab('objects');setInspectRequest(n=>n+1);}}/>{previewUrl&&<img id="designPreview" className="saved-preview" src={previewUrl} alt="" aria-hidden="true" onError={()=>setPreviewError(true)}/>}</>:!isDesign&&image?<div className="preview-stage"><img id="canvasImage" className={image.transparency?.hasTransparency?'transparency-preview':undefined} src={image.url} alt="当前图片作品" style={{transform:`scale(${zoom})`}}/></div>:<div className="empty-canvas"><div className="empty-illustration"><span>✳</span><div><i/><b/><small>a little imagination.</small></div><span>✧</span></div><h2>让想象，有画面。</h2><p>上传素材，告诉助手你的想法。<br/>独立的文字、Logo 和图片，让每次修改更轻松。</p><button id="uploadButton" className="btn" disabled={w.locked||!s} onClick={()=>fileInput.current?.click()}><Icon name="plus"/>上传参考图片</button><small>PNG、JPG、WebP · 最多 8 张 · 每张 10 MB</small></div>}
            {previewError&&isDesign&&<div className="preview-error">预览加载失败，请重新载入设计稿。<button onClick={w.reload}>重新载入</button></div>}
            {!isDesign&&image&&<ImageOutputDetails image={image}/>}
            <div className="canvas-bottom"><span>{w.dirty?w.localState==='saved'?'当前草稿已在本机保留':w.localState==='error'?'当前草稿尚未备份':'正在保留本机草稿…':isDesign&&record?`${p?.objects.length||0} 个独立对象 · r${record.revision}`:'每一次灵感，都值得保留。'}</span><div className="zoom-controls"><button aria-label="缩小" onClick={()=>setZoom(z=>Math.max(.25,z-.25))}>−</button><button onClick={()=>setZoom(1)}>{zoom===1?'适应':`${Math.round(zoom*100)}%`}</button><button aria-label="放大" onClick={()=>setZoom(z=>Math.min(3,z+.25))}>+</button></div></div>
          </div>
          {isDesign&&!!w.issues.length&&<details className="preflight" open={w.issues.some(i=>i.severity==='error')}><summary>校稿检查 · {w.issues.filter(i=>i.severity==='error').length} 项需处理 · {w.issues.filter(i=>i.severity==='warning').length} 项提示</summary>{w.issues.map((issue,index)=><p key={index} className={issue.severity}><button onClick={()=>{if(issue.pageId)w.selectPage(issue.pageId);if(issue.objectId)w.setSelected(issue.objectId);setTab(issue.contentId?'content':'objects');}}>{issue.pageId?`第 ${(w.document?.pages.findIndex(p=>p.id===issue.pageId)??0)+1} 页 · `:''}{issue.message}</button></p>)}</details>}
          <div className="version-panel"><div className="version-heading"><span>{isDesign?'设计版本':'图片版本'} <b>{isDesign?record?.versions.length||0:generated.length}</b></span><small>{isDesign?'完整保存内容与排版':'上传的参考图保留在素材中'}</small></div><div className="versions">{record&&<button className={`version-current ${isDesign?'active':''}`} onClick={()=>w.setView('design')}><Icon name="layout"/><span>当前设计稿<small>r{record.revision}</small></span></button>}{isDesign?record?.versions.map(v=><button className="design-version" key={v.id} disabled={w.locked} onClick={()=>w.restore(v.id)} title={`恢复设计版本 ${v.number}`}><span>V{v.number}</span><strong>{v.label}</strong><small>{new Date(v.createdAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})} · 恢复</small></button>):generated.map(v=><button key={v.id} className={`version-card ${w.view===v.id?'active':''}`} aria-label={`选择图片版本 ${v.number}`} onClick={()=>w.operate(async()=>{await w.patchSession({selectedId:v.id});w.setView(v.id);})}><img src={v.url} alt={`图片版本 ${v.number}`}/><span>V{v.number}</span></button>)}{!record?.versions.length&&isDesign&&<p className="version-empty">AI 完成或点击「保存版本」后，设计历史会显示在这里。</p>}{isDesign&&!!generated.length&&<button className="old-images" onClick={()=>w.setView(generated.at(-1)!.id)}>查看 {generated.length} 个历史图片版本 →</button>}</div></div>
        </section>
        {isDesign?<Inspector w={w} tab={tab} setTab={setTab} inspectRequest={inspectRequest}/>:<ImageInspector w={w}/>}
      </main>
    </div>
    <input id="imageInput" ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={e=>{if(e.target.files?.length)w.upload([...e.target.files]);e.target.value='';}}/>
    {dragging&&<div className="drop-overlay">松开图片，添加本轮参考素材</div>}
    {w.notice&&<div id="toast" className="toast" role="status">{w.notice}</div>}
    {dialog==='paginate'&&<PaginationDialog w={w} onClose={()=>setDialog(null)}/>}
    {dialog==='compose'&&<ImageComposeDialog w={w} onClose={()=>setDialog(null)}/>}
      {dialog==='download'&&<DownloadDialog w={w} onClose={()=>setDialog(null)} onLocate={issue=>{if(issue.pageId)w.selectPage(issue.pageId);if(issue.objectId)w.setSelected(issue.objectId);setTab(issue.contentId?'content':'objects');setDialog(null);w.notify('已定位检查项，修改并保存后请重新检查。');}}/>}
    {dialog==='sessions'&&<Modal title="继续你的创作" eyebrow="YOUR WORKSPACE" onClose={()=>setDialog(null)}><div className="session-list">{sessions.map(session=><button className="session-card" key={session.id} disabled={w.busy} onClick={()=>{w.switchSession(session.id);setDialog(null);}}>{session.thumbnail?<img src={session.thumbnail} alt=""/>:<span>✧</span>}<div><strong>{session.title}</strong><small>{new Date(session.updatedAt).toLocaleString('zh-CN')}{session.status==='running'?' · 创作中':''}</small></div></button>)}</div></Modal>}
    {dialog==='skills'&&<Modal title="素材与创作技能" eyebrow="CREATIVE LIBRARY" onClose={()=>setDialog(null)}><h3>当前会话素材</h3><p className="help">图片可重复选作本轮参考；插入稿件请使用右侧对象面板。</p><div className="asset-grid">{w.data.assets.filter(a=>a.kind==='upload').map(asset=><button key={asset.id} disabled={w.locked||!s?.referenceIds.includes(asset.id)&&(s?.referenceIds.length||0)>=8} aria-pressed={s?.referenceIds.includes(asset.id)} onClick={()=>chooseReference(asset.id)}><img src={asset.url} alt=""/><span>{asset.name}</span><small>{s?.referenceIds.includes(asset.id)?'✓ 已选作本轮参考':'＋ 加入本轮参考'}</small></button>)}</div><h3>创作技能</h3><div className="skill-list">{w.skills.map(item=><button key={item.id} disabled={w.locked} aria-pressed={s?.skillId===item.id} onClick={()=>w.operate(async()=>{await w.patchSession({skillId:item.id});if(item.workflow==='logo-design'){w.setMode('image');w.setView(record?'design':generated.at(-1)?.id||'image');}setDialog(null);})}><strong>{item.name}</strong><span>{item.description}</span></button>)}</div><a href="/legacy/" className="legacy-link">进入原版工作台：导入技能、商品原图对照等工具 ↗</a></Modal>}
    {dialog==='debug'&&<DebugDialog w={w} onClose={()=>setDialog(null)}/>}
  </div>;
}
