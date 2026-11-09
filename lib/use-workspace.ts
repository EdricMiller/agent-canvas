'use client';

import {useCallback,useEffect,useRef,useState} from 'react';
import {changePages} from '../shared/design-pages.js';
import type {PageOperation} from '../shared/design-pages.js';
import {DesignHistory,type EditorSnapshot} from '../shared/design-history.js';
import {alignBox,transformBox,type Alignment,type ObjectBox} from '../shared/design-geometry.js';
import {changeObject,type ObjectOperation} from '../shared/design-objects.js';
import {ApiError,remember,request,stored} from './api';
import {listDrafts,putDraft,removeDraft,type LocalDraft} from './local-drafts';
import type {CanvasSettings,Capabilities,DesignData,DesignDocument,DesignObject,DesignRecord,ImageVersion,Issue,LogoComposition,Session,Skill,StudioConfig,SessionSummary} from './types';

const initialCanvas:CanvasSettings={title:'未命名设计稿',width:1200,height:1600,unit:'px',background:'#ffffff'};
export function useWorkspace(){
  const [config,setConfig]=useState<StudioConfig|null>(null),[skills,setSkills]=useState<Skill[]>([]);
  const [session,setSession]=useState<Session|null>(null),[data,setData]=useState<DesignData>({design:null,assets:[]});
  const [document,setDocument]=useState<DesignDocument|null>(null),[canvas,setCanvas]=useState(initialCanvas);
  const [dirty,setDirty]=useState(false),[busy,setBusy]=useState(false),[queuedUploads,setQueuedUploads]=useState(0),[notice,setNotice]=useState('');
  const [issues,setIssues]=useState<Issue[]>([]),[capabilities,setCapabilities]=useState<Capabilities|null>(null);
  const [mode,setMode]=useState<'design'|'image'>('design'),[view,setView]=useState<'design'|string>('design');
  const [activePageId,setActivePageId]=useState<string|null>(null);
  const [selected,setSelectedState]=useState<string|null>(null),[conflict,setConflict]=useState(false),[ready,setReady]=useState(false);
  const [saving,setSaving]=useState(false),[saveError,setSaveError]=useState(''),[localState,setLocalState]=useState<'idle'|'writing'|'saved'|'error'>('idle'),[recovery,setRecovery]=useState<LocalDraft[]>([]);
  const saveFlight=useRef<Promise<DesignRecord|null>|null>(null),baseRevision=useRef<number|null>(null),sync=useRef({conflict:false,error:''});
  const writer=useRef(''),localQueue=useRef(Promise.resolve(true)),localSequence=useRef(0),localStatus=useRef('idle'),recovered=useRef<LocalDraft|null>(null);
  const downloadedBackup=useRef<{sessionId:string;document:DesignDocument}|null>(null);
  const saveLatest=useRef<(automatic?:boolean)=>Promise<DesignRecord|null>>(async()=>null);
  const history=useRef(new DesignHistory()),editGroup=useRef<string|null>(null),[,setHistoryTick]=useState(0);
  const token=useRef<string|undefined>(undefined),lock=useRef(false),generation=useRef(0),noticeTimer=useRef<ReturnType<typeof setTimeout>|null>(null);
  const uploadQueue=useRef(Promise.resolve()),uploadCount=useRef(0);
  const current=useRef({session,dirty,data,document,mode,view,canvas,activePageId,selected});current.current={session,dirty,data,document,mode,view,canvas,activePageId,selected};
  function setSelected(id:string|null){current.current.selected=id;setSelectedState(id);}
  const api=useCallback(<T,>(url:string,method='GET',body?:unknown,signal?:AbortSignal)=>request<T>(url,token.current,method,body,signal),[]);
  const notify=useCallback((text:string)=>{setNotice(text);if(noticeTimer.current)clearTimeout(noticeTimer.current);noticeTimer.current=setTimeout(()=>setNotice(''),8000);},[]);
  const accept=useCallback((next:DesignData,preserveHistory=false)=>{
    const pageId=next.design?.document.pages.some(p=>p.id===current.current.activePageId)?current.current.activePageId:next.design?.document.pages[0]?.id??null;
    current.current={...current.current,data:next,document:next.design?.document??null,dirty:false,activePageId:pageId};
    setData(next);setDocument(next.design?.document??null);setDirty(false);setConflict(false);setActivePageId(pageId);
    baseRevision.current=next.design?.revision??null;sync.current={conflict:false,error:''};setSaveError('');setLocalState('idle');localStatus.current='idle';
    if(!preserveHistory){history.current.clear();editGroup.current=null;setHistoryTick(t=>t+1);}
  },[]);
  const endpoint=useCallback((suffix='')=>`/api/sessions/${current.current.session?.id}/design${suffix}`,[]);
  const operate=useCallback(async(task:()=>Promise<void>)=>{
    if(lock.current)return;lock.current=true;setBusy(true);
    try{await saveFlight.current?.catch(()=>{});await task();}catch(error){if(error instanceof ApiError&&error.status===409){sync.current.conflict=true;setConflict(true);}notify(error instanceof Error?error.message:'操作失败');}
    finally{lock.current=false;setBusy(false);}
  },[notify]);
  const useSession=useCallback(async(next:Session)=>{
    const key=++generation.current;
    const design=await api<DesignData>(`/api/sessions/${next.id}/design`);
    if(key!==generation.current)return;
    current.current.session=next;setSession(next);accept(design);setActivePageId(design.design?.document.pages[0]?.id??null);setSelected(null);setIssues([]);recovered.current=null;setRecovery([]);
    const saved=design.design;
    // A complete Logo is delivered as an image. On reload, keep that result
    // visible even when an older, separately editable composition still exists.
    const deliveredLogo=next.skillId==='logo-design'&&!next.job?.designResult&&next.job?.events.some(e=>e.type==='image'&&e.versionId===next.selectedId);
    const deliveredImage=deliveredLogo||!!next.versions.find(v=>v.id===next.selectedId)?.composition;
    setMode(deliveredImage||next.skillId==='logo-design'?'image':saved||!next.imageTarget&&!next.versions.some(v=>v.id===next.selectedId&&v.kind!=='upload')?'design':'image');
    setView(saved&&!deliveredImage?'design':next.versions.find(v=>v.id===next.selectedId&&v.kind!=='upload')?.id||(next.imageTarget?'image':'design'));
    const params=new URLSearchParams(location.search),source=design.assets.find(a=>a.id===params.get('source'));
    setCanvas(saved?{title:saved.document.title,...pickCanvas(saved.document)}:source?{...initialCanvas,title:source.name.slice(0,100),width:source.width||1200,height:source.height||1600}:initialCanvas);
    remember('canvas-session',next.id);window.history.replaceState(null,'',`/?session=${next.id}`);
    await loadRecovery(next.id,design,key);
  },[accept,api]);
  // A ref makes initialization idempotent across Strict Mode's effect replay.
  const boot=useRef<Promise<void>|null>(null);
  useEffect(()=>{
    if(!boot.current)boot.current=(async()=>{
      try{
        const cfg=await api<StudioConfig>('/api/config');token.current=cfg.token;setConfig(cfg);
        const [available,list,caps]=await Promise.all([api<Skill[]>('/api/skills'),api<SessionSummary[]>('/api/sessions'),api<Capabilities>('/api/design/capabilities')]);
        setSkills(available);setCapabilities(caps);
        const wanted=new URLSearchParams(location.search).get('session')||stored('canvas-session');
        const id=list.find(s=>s.id===wanted)?.id||list[0]?.id;
        await useSession(id?await api<Session>(`/api/sessions/${id}`):await api<Session>('/api/sessions','POST'));
      }catch(error){notify(error instanceof Error?error.message:'无法连接工作台');}
      finally{setReady(true);}
    })();
  },[api,notify,useSession]);
  useEffect(()=>()=>{if(noticeTimer.current)clearTimeout(noticeTimer.current);},[]);
  const refresh=useCallback(async()=>{
    const previous=current.current,s=previous.session;if(!s||lock.current||saveFlight.current)return;
    const key=generation.current;
    const [next,design]=await Promise.all([api<Session>(`/api/sessions/${s.id}`),api<DesignData>(`/api/sessions/${s.id}/design`)]);
    if(key!==generation.current||lock.current||saveFlight.current||current.current.data.design?.revision!==previous.data.design?.revision)return;
    current.current.session=next;setSession(next);
    if(design.design?.revision!==current.current.data.design?.revision){
      if(current.current.dirty){sync.current.conflict=true;setConflict(true);current.current.data=design;setData(design);}
      else{
        accept(design);setSelected(null);
        if(next.job?.designResult){setView('design');if(next.job.designResult.pageId)setActivePageId(next.job.designResult.pageId);}
      }
    }else setData(d=>({...d,assets:design.assets}));
    if(!next.job?.designResult&&next.job?.outputMode!=='design'&&next.selectedId!==s.selectedId&&next.versions.some(v=>v.id===next.selectedId&&v.kind!=='upload'))setView(next.selectedId!);
  },[accept,api]);
  useEffect(()=>{
    if(!session)return;
    let stopped=false,timer:ReturnType<typeof setTimeout>;
    const poll=async()=>{try{await refresh();}catch(error){if(!stopped)notify(error instanceof Error?error.message:'刷新失败');}finally{if(!stopped)timer=setTimeout(poll,current.current.session?.job?.status==='running'?850:5000);}};
    timer=setTimeout(poll,session.job?.status==='running'?850:5000);
    const focus=()=>{if(!lock.current)refresh().catch(()=>{});};window.addEventListener('focus',focus);
    return()=>{stopped=true;clearTimeout(timer);window.removeEventListener('focus',focus);};
  },[session?.id,session?.job?.status,refresh,notify]);
  useEffect(()=>{
    if(!session||!data.design){setIssues([]);return;}
    const controller=new AbortController();
    api<{revision:number;issues:Issue[]}>(`/api/sessions/${session.id}/design/preflight`,'GET',undefined,controller.signal).then(result=>{if(result.revision===data.design?.revision)setIssues(result.issues);}).catch(error=>{if(!controller.signal.aborted)notify(error.message);});
    return()=>controller.abort();
  },[session?.id,data.design?.revision,api,notify]);
  useEffect(()=>{
    const handler=(event:BeforeUnloadEvent)=>{if(current.current.dirty&&localStatus.current!=='saved'){event.preventDefault();event.returnValue='';}};
    window.addEventListener('beforeunload',handler);return()=>window.removeEventListener('beforeunload',handler);
  },[]);
  useEffect(()=>{
    if(!dirty||!document||busy||queuedUploads||session?.job?.status==='running'||conflict||saving||saveError)return;
    const timer=setTimeout(()=>{if(!lock.current&&!sync.current.conflict)saveLatest.current(true).catch(()=>{});},1200);
    return()=>clearTimeout(timer);
  },[dirty,document,busy,queuedUploads,session?.job?.status,session?.id,conflict,saving,saveError]);
  useEffect(()=>{
    const retry=()=>{if(current.current.dirty&&!sync.current.conflict&&!lock.current&&!uploadCount.current&&current.current.session?.job?.status!=='running')saveLatest.current(true).catch(()=>{});};
    const hidden=()=>{if(window.document.visibilityState==='hidden')retry();};
    window.addEventListener('online',retry);window.document.addEventListener('visibilitychange',hidden);
    return()=>{window.removeEventListener('online',retry);window.document.removeEventListener('visibilitychange',hidden);};
  },[]);
  function draftId(sessionId:string){if(!writer.current)writer.current=crypto.randomUUID();return `${writer.current}:${sessionId}`;}
  async function loadRecovery(sessionId:string,design:DesignData,key=generation.current){
    if(!design.design)return;
    try{
      const drafts=await listDrafts(sessionId,design.design.id);
      if(key===generation.current&&current.current.session?.id===sessionId)setRecovery(drafts.filter(d=>JSON.stringify(d.snapshot.document)!==JSON.stringify(design.design!.document)&&!(current.current.dirty&&d.id===draftId(sessionId))));
    }catch{if(key===generation.current){setLocalState('error');localStatus.current='error';}}
  }
  function persistDraft(){
    const c=current.current;if(!c.dirty||!c.document||!c.session||!c.data.design)return Promise.resolve(true);
    const draft:LocalDraft={id:draftId(c.session.id),sessionId:c.session.id,designId:c.data.design.id,baseRevision:baseRevision.current??c.data.design.revision,stamp:crypto.randomUUID(),updatedAt:Date.now(),snapshot:{document:c.document,pageId:c.activePageId,selected:c.selected}};
    const sequence=++localSequence.current;setLocalState('writing');localStatus.current='writing';
    const restored=recovered.current;
    localQueue.current=localQueue.current.catch(()=>false).then(async()=>{
      try{
        await putDraft(draft);
        if(restored&&restored.sessionId===draft.sessionId&&restored.id!==draft.id){await removeDraft(restored.id,restored.stamp);if(recovered.current===restored)recovered.current=null;}
        if(sequence===localSequence.current&&current.current.session?.id===draft.sessionId){localStatus.current='saved';setLocalState('saved');}
        return true;
      }catch{if(sequence===localSequence.current&&current.current.session?.id===draft.sessionId){localStatus.current='error';setLocalState('error');}return false;}
    });
    return localQueue.current;
  }
  function clearOwnDraft(){
    const id=current.current.session?.id;if(!id)return;
    ++localSequence.current;localStatus.current='idle';setLocalState('idle');const key=draftId(id);
    localQueue.current=localQueue.current.catch(()=>false).then(()=>removeDraft(key).then(()=>true,()=>false));
  }
  function editorState():EditorSnapshot|null{
    const c=current.current;return c.document?{document:c.document,pageId:c.activePageId,selected:c.selected}:null;
  }
  function applyDraft(state:EditorSnapshot){
    const page=state.document.pages.find(p=>p.id===state.pageId)||state.document.pages[0],selection=page.objects.some(o=>o.id===state.selected)?state.selected:null;
    const dirty=JSON.stringify(state.document)!==JSON.stringify(current.current.data.design?.document);
    current.current={...current.current,document:state.document,activePageId:page.id,selected:selection,dirty};
    setDocument(state.document);setActivePageId(page.id);setSelectedState(selection);setDirty(dirty);setHistoryTick(t=>t+1);
    if(!sync.current.conflict){sync.current.error='';setSaveError('');}
    if(dirty)persistDraft();else clearOwnDraft();
  }
  function endEdit(){editGroup.current=null;history.current.endGroup();}
  function beginEdit(key:string){endEdit();editGroup.current=key;}
  function replaceDraft(next:DesignDocument,context?:{pageId:string;selected:string|null},group=editGroup.current){
    const before=editorState();if(!before)return;
    const after={document:next,pageId:context?.pageId??before.pageId,selected:context?context.selected:before.selected};
    if(history.current.record(before,after,group))applyDraft(after);
  }
  function edit(change:(draft:DesignDocument)=>void,group?:string){
    if(lock.current||current.current.session?.job?.status==='running'||!current.current.document)return;
    const next=structuredClone(current.current.document);change(next);replaceDraft(next,undefined,group??editGroup.current);
  }
  function travel(direction:'undo'|'redo'){
    if(lock.current||uploadCount.current||current.current.session?.job?.status==='running'||current.current.view!=='design')return;
    endEdit();const before=editorState();if(!before)return;const state=history.current[direction](before);if(state)applyDraft(state);
  }
  function changeBox(id:string,box:ObjectBox){
    endEdit();edit(doc=>{const p=doc.pages.find(p=>p.id===current.current.activePageId)||doc.pages[0],o=p.objects.find(o=>o.id===id);if(o&&!o.locked&&!o.hidden)Object.assign(o,box);});
  }
  function alignSelected(alignment:Alignment){
    const c=current.current,p=c.document?.pages.find(p=>p.id===c.activePageId)||c.document?.pages[0],o=p?.objects.find(o=>o.id===c.selected);
    if(p&&o)changeBox(o.id,alignBox(p,o,alignment));
  }
  function nudgeSelected(dx:number,dy:number){
    const c=current.current,p=c.document?.pages.find(p=>p.id===c.activePageId)||c.document?.pages[0],o=p?.objects.find(o=>o.id===c.selected);if(!p||!o||o.locked||o.hidden)return;
    const box=transformBox(p,o,{dx,dy}).box;
    edit(doc=>Object.assign(doc.pages.find(page=>page.id===p.id)!.objects.find(item=>item.id===o.id)!,box),`nudge-${o.id}`);
  }
  function deleteSelected(){
    const c=current.current,o=c.document?.pages.flatMap(p=>p.objects).find(o=>o.id===c.selected);if(o?.locked)return;
    endEdit();edit(doc=>{const p=doc.pages.find(p=>p.id===current.current.activePageId)||doc.pages[0];p.objects=p.objects.filter(o=>o.id!==current.current.selected);});setSelected(null);
  }
  function objectOperation(operation:ObjectOperation,objectId=current.current.selected){
    const c=current.current;if(lock.current||uploadCount.current||c.session?.job?.status==='running'||c.view!=='design'||!c.document||!objectId)return;
    const page=c.document.pages.find(p=>p.id===c.activePageId)||c.document.pages[0];
    try{
      if(operation.type==='replace'&&!c.data.assets.some(a=>a.id===operation.assetId))throw new Error('请选择当前项目的图片');
      endEdit();const result=changeObject(c.document,page.id,objectId,operation);
      replaceDraft(result.document,{pageId:page.id,selected:result.selectedId});
    }catch(e){notify(e instanceof Error?e.message:'对象操作失败');}
  }
  const uploadReplacement=(file:File)=>operate(async()=>{
    const c=current.current,page=c.document?.pages.find(p=>p.id===c.activePageId)||c.document?.pages[0],object=page?.objects.find(o=>o.id===c.selected);
    if(!c.session||!c.document||!page||object?.type!=='image'||object.locked||uploadCount.current)throw new Error('请先选择可编辑的图片对象');
    const content=await readImageFile(file);
    const result=await api<{session:Session;version:{id:string;url:string;width:number;height:number}}>(`/api/sessions/${c.session.id}/upload`,'POST',{data:content,name:file.name,purpose:'asset'});
    setSession(result.session);current.current={...current.current,session:result.session};
    setData(d=>({...d,assets:[...d.assets,{...result.version,name:file.name,kind:'upload'}]}));
    if(current.current.document!==c.document)throw new Error('稿件已更新，新图片已保留在素材中，请重新选择替换');
    const changed=changeObject(c.document,page.id,object.id,{type:'replace',assetId:result.version.id});
    endEdit();replaceDraft(changed.document,{pageId:page.id,selected:object.id});
    notify('图片已替换，位置、尺寸和适配方式已保留');
  });
  async function save(automatic=false):Promise<DesignRecord|null>{
    if(!automatic)endEdit();
    if(saveFlight.current){await saveFlight.current;return automatic?current.current.data.design:save();}
    const c=current.current;
    if(!c.data.design||!c.document)return null;
    if(!c.dirty)return c.data.design;
    if(sync.current.conflict)throw new ApiError('其他窗口已更新，自动保存已暂停。请先处理版本冲突。',409);
    const key=generation.current,id=c.session!.id,submitted=c.document,revision=baseRevision.current??c.data.design.revision;
    const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),15000);setSaving(true);sync.current.error='';setSaveError('');
    const applySaved=(result:DesignData)=>{
      if(key!==generation.current||current.current.session?.id!==id)return result.design;
      const latest=current.current,next=latest.document===submitted&&JSON.stringify(submitted)!==JSON.stringify(result.design!.document)?result.design!.document:latest.document,dirty=JSON.stringify(next)!==JSON.stringify(result.design!.document);
      baseRevision.current=result.design!.revision;sync.current={conflict:false,error:''};
      current.current={...latest,data:result,document:next,dirty};setData(result);setDocument(next);setDirty(dirty);setConflict(false);setSaveError('');
      if(dirty)persistDraft();else clearOwnDraft();return result.design;
    };
    const task=(async()=>{
      try{return applySaved(await api<DesignData>(`/api/sessions/${id}/design`,'PUT',{revision,document:submitted},controller.signal));}
      catch(error){
        // A request may have committed before its response was lost. Never retry
        // against a newer revision unless its document is exactly our submission.
        if(error instanceof ApiError&&error.status===409){
          const result=await api<DesignData>(`/api/sessions/${id}/design`,'GET',undefined,controller.signal).catch(()=>null);
          if(result?.design&&JSON.stringify(result.design.document)===JSON.stringify(submitted))return applySaved(result);
          // Keep the draft's baseRevision, while using current metadata for
          // read-only layout and preflight. A conflict must not hide its text.
          if(result?.design&&key===generation.current&&current.current.session?.id===id){current.current.data=result;setData(result);}
        }
        if(key===generation.current&&current.current.session?.id===id){
          const message=controller.signal.aborted?'保存超时，请重试':error instanceof Error?error.message:'保存失败';
          sync.current={conflict:error instanceof ApiError&&error.status===409,error:message};setConflict(sync.current.conflict);setSaveError(message);persistDraft();
        }
        throw error;
      }finally{clearTimeout(timeout);saveFlight.current=null;setSaving(false);}
    })();saveFlight.current=task;return task;
  }
  saveLatest.current=save;
  async function patchSession(patch:Partial<Session>){
    const s=current.current.session;if(!s)return;
    const next=await api<Session>(`/api/sessions/${s.id}`,'PATCH',patch);setSession(next);
  }
  const switchSession=(id?:string)=>operate(async()=>{
    if(current.current.dirty&&!await persistDraft()&&!hasDownloadedBackup()){await save();}
    await useSession(id?await api<Session>(`/api/sessions/${id}`):await api<Session>('/api/sessions','POST'));
  });
  const create=(sourceId?:string)=>operate(async()=>{
    const image=current.current.session?.versions.find(v=>v.id===sourceId);
    const options=sourceId?{...canvas,width:image?.width||canvas.width,height:image?.height||canvas.height,unit:'px',background:image?.transparency?.hasTransparency?'transparent':canvas.background,sourceId}:canvas;
    const next=await api<DesignData>(endpoint(),'POST',options);accept(next);setView('design');setMode('design');setSelected(null);notify('设计稿已创建，可添加独立文字、图片和色块。');
  });
  const submit=(text:string,onAccepted:()=>void)=>operate(async()=>{
    if(uploadCount.current)throw new Error('参考图仍在上传，请完成后再发送。');
    const c=current.current;if(!c.session)return;
    const record=await save();
    const body={text,requestId:crypto.randomUUID(),...(c.mode==='design'?{design:{revision:record?.revision??null,canvas:record?{title:record.document.title,...pickCanvas(record.document,c.activePageId)}:c.canvas,...(record?{pageId:record.document.pages.find(p=>p.id===c.activePageId)?.id||record.document.pages[0].id}:{}),referenceIds:c.session.referenceIds}}:{})};
    const result=await api<{session:Session}>(`/api/sessions/${c.session.id}/turns`,'POST',body);setSession(result.session);onAccepted();if(c.mode==='design')setView('design');
  });
  const upload=(files:File[])=>{
    const id=current.current.session?.id;if(!id||!files.length)return;
    if(current.current.session?.job?.status==='running'||lock.current&&!uploadCount.current){notify('当前正在执行操作，请完成后再上传。');return;}
    uploadCount.current++;setQueuedUploads(uploadCount.current);
    uploadQueue.current=uploadQueue.current.then(()=>operate(async()=>{
    if(current.current.session?.id!==id)throw new Error('会话已切换，本次图片未上传');
    for(const file of files){
      if(!['image/png','image/jpeg','image/webp'].includes(file.type))throw new Error('支持 PNG、JPG、WebP 图片');
      if(file.size>10*1024*1024)throw new Error('每张图片最大 10 MB');
    }
    if(files.length+(current.current.session?.referenceIds.length||0)>8)throw new Error('本轮最多 8 张参考图，请先移除不需要的图片');
    try{
      for(const file of files){
        const content=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(new Error('图片读取失败'));reader.readAsDataURL(file);});
        const result=await api<{session:Session}>(`/api/sessions/${id}/upload`,'POST',{data:content,name:file.name});setSession(result.session);current.current={...current.current,session:result.session};
      }
    }finally{const next=await api<DesignData>(`/api/sessions/${id}/design`);setData(d=>({...d,assets:next.assets}));}
    })).finally(()=>{uploadCount.current--;setQueuedUploads(uploadCount.current);});
    return uploadQueue.current;
  };
  const uploadCompositionAsset=(file:File,onComplete:(id:string)=>void,onError:(message:string)=>void)=>operate(async()=>{
    try{
      const s=current.current.session;if(!s)return;
      const data=await readImageFile(file);
      const result=await api<{session:Session;version:ImageVersion}>(`/api/sessions/${s.id}/upload`,'POST',{data,name:file.name,purpose:'asset'});
      current.current.session=result.session;setSession(result.session);
      setData(d=>({...d,assets:[...d.assets,{...result.version,name:file.name}]}));onComplete(result.version.id);
    }catch(e){const message=e instanceof Error?e.message:'上传失败';onError(message);throw e;}
  });
  const composeImage=(options:LogoComposition,onComplete:()=>void,onError:(message:string)=>void)=>operate(async()=>{
    try{
      const s=current.current.session;if(!s)return;
      const result=await api<{session:Session;version:ImageVersion}>(`/api/sessions/${s.id}/compose`,'POST',options);
      current.current.session=result.session;setSession(result.session);setMode('image');setView(result.version.id);
      notify('已保存组合图片，原图与 Logo 保留。');onComplete();
    }catch(e){const message=e instanceof Error?e.message:'图片组合失败';onError(message);throw e;}
  });
  function addObject(type:DesignObject['type'],assetId?:string){
    endEdit();
    const id=crypto.randomUUID();
    edit(doc=>{
      const p=doc.pages.find(p=>p.id===current.current.activePageId)||doc.pages[0],x=p.width*.08,y=p.height*.08,width=p.width*.65,height=type==='text'?p.height*.12:p.height*.3;
      const base={id,x,y,width,height};
      if(type==='text')p.objects.push({...base,type,text:'双击灵感，写下想法',fontSize:24,lineHeight:1.35,color:'#292a31',align:'left'});
      if(type==='rect')p.objects.push({...base,type,fill:'#e9e0fa'});
      if(type==='image'&&assetId)p.objects.push({...base,type,assetId,fit:'contain'});
    });setSelected(id);setView('design');
  }
  const activePage=document?.pages.find(p=>p.id===activePageId)||document?.pages[0];
  function selectPage(id:string){if(current.current.document?.pages.some(p=>p.id===id)){endEdit();current.current.activePageId=id;setActivePageId(id);setSelected(null);setView('design');}}
  function pageOperation(type:PageOperation['type'],toIndex?:number){
    const c=current.current;if(lock.current||c.session?.job?.status==='running'||!c.document)return;
    const page=c.document.pages.find(p=>p.id===c.activePageId)||c.document.pages[0];
    if(type==='delete'&&page.objects.length&&!window.confirm(`删除“${page.name}”及其专属内容？保存的历史版本仍可恢复。`))return;
    try{
      const result=changePages(c.document,{type,pageId:page.id,...(type==='move'?{toIndex:toIndex!}:{})} as PageOperation);
      endEdit();replaceDraft(result.document,{pageId:result.selectedId,selected:null});
    }catch(e){notify(e instanceof Error?e.message:'页面操作失败');}
  }
  const paginate=(options:PaginationOptions,onComplete?:()=>void,onError?:(message:string)=>void)=>operate(async()=>{
    try{
    const c=current.current,saved=await save();
    const settings=saved?{title:saved.document.title,...pickCanvas(saved.document,c.activePageId)}:c.canvas;
    const result=await api<DesignData&{addedPageIds:string[]}>(endpoint('/paginate'),'POST',{revision:saved?.revision??null,canvas:settings,options});
    accept(result);setActivePageId(result.addedPageIds[0]);setSelected(null);setView('design');notify(`已新增 ${result.addedPageIds.length} 页，条目已完整排入；原有页面保留。`);onComplete?.();
    }catch(e){onError?.(e instanceof Error?e.message:'分页失败');throw e;}
  });
  const snapshot=()=>operate(async()=>{const record=await save();if(!record)return;accept(await api<DesignData>(endpoint('/versions'),'POST',{revision:record.revision,label:'手动保存'}),true);notify('已保存完整设计版本。');});
  const restore=(versionId:string)=>operate(async()=>{
    const record=await save();if(!record)return;
    accept(await api<DesignData>(endpoint('/restore'),'POST',{revision:record.revision,versionId}));setSelected(null);setView('design');notify('已恢复所选版本，历史版本保留。');
  });
  const reload=()=>operate(async()=>{
    if(current.current.dirty){if(!await persistDraft()&&!hasDownloadedBackup())throw new Error('无法保留本机草稿，请先下载当前草稿备份，再重新载入。');writer.current=crypto.randomUUID();}
    const next=await api<DesignData>(endpoint());accept(next);setSelected(null);await loadRecovery(current.current.session!.id,next);
  });
  const recoverDraft=(draft:LocalDraft)=>operate(async()=>{
    const c=current.current;if(draft.sessionId!==c.session?.id||draft.designId!==c.data.design?.id)return;
    if(c.dirty){if(!await persistDraft())throw new Error('请先保存或下载当前草稿，再恢复其他草稿。');writer.current=crypto.randomUUID();}
    history.current.clear();editGroup.current=null;recovered.current=draft;baseRevision.current=draft.baseRevision;
    applyDraft(structuredClone(draft.snapshot));
    const older=draft.baseRevision!==c.data.design.revision;
    sync.current={conflict:older,error:''};setConflict(older);setSaveError('');setView('design');setRecovery(items=>items.filter(item=>item.id!==draft.id));
    notify(older?'已恢复本机草稿。线上稿件已有更新，已暂停同步。':'已恢复本机草稿，将自动保存。');
  });
  const discardDraft=(draft:LocalDraft)=>operate(async()=>{await removeDraft(draft.id,draft.stamp);setRecovery(items=>items.filter(item=>item.id!==draft.id));});
  function hasDownloadedBackup(){const c=current.current;return downloadedBackup.current?.sessionId===c.session?.id&&downloadedBackup.current?.document===c.document;}
  function downloadDraft(){
    const c=current.current;if(!c.document)return;
    const url=URL.createObjectURL(new Blob([JSON.stringify({format:'canvas-local-draft',baseRevision:baseRevision.current,document:c.document},null,2)],{type:'application/json'})),link=window.document.createElement('a');
    link.href=url;link.download=`${c.document.title||'设计稿'}-本机草稿.json`;link.click();downloadedBackup.current={sessionId:c.session!.id,document:c.document};setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  return {config,setConfig,skills,setSkills,session,data,document,activePage,selectPage,pageOperation,paginate,canvas,setCanvas,dirty,busy:busy||queuedUploads>0,notice,issues,capabilities,mode,setMode,view,setView,selected,setSelected,conflict,ready,saving,saveError,localState,recovery,recoverDraft,discardDraft,downloadDraft,
    api,notify,operate,save,edit,beginEdit,endEdit,changeBox,alignSelected,nudgeSelected,deleteSelected,objectOperation,uploadReplacement,uploadCompositionAsset,composeImage,undo:()=>travel('undo'),redo:()=>travel('redo'),canUndo:history.current.canUndo,canRedo:history.current.canRedo,patchSession,switchSession,create,submit,upload,addObject,snapshot,restore,reload,endpoint,
    uploading:queuedUploads>0,running:session?.job?.status==='running',locked:busy||queuedUploads>0||session?.job?.status==='running',
    stop:()=>operate(async()=>{if(session){await api(`/api/sessions/${session.id}/cancel`,'POST',{});notify('已请求停止，已保存的设计版本会保留。');}}),
  };
}
export function pickCanvas(doc:DesignDocument,pageId?:string|null){const p=doc.pages.find(p=>p.id===pageId)||doc.pages[0];return {width:p.width,height:p.height,unit:p.unit,background:p.background};}
export type WorkspaceState=ReturnType<typeof useWorkspace>;

async function readImageFile(file:File){
  if(!['image/png','image/jpeg','image/webp'].includes(file.type))throw new Error('支持 PNG、JPG、WebP 图片');
  if(file.size>10*1024*1024)throw new Error('每张图片最大 10 MB');
  return new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(new Error('图片读取失败'));reader.readAsDataURL(file);});
}

export type PaginationOptions={heading:string;rows:{name:string;value:string;description:string;status:'confirmed'|'needs_confirmation'}[];columns:number;fontSize:number;logoId?:string};
