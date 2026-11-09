import type {DesignDocument,DesignObject} from './types';
import type {EditorSnapshot} from '@/shared/design-history.js';

export type LocalDraft={id:string;sessionId:string;designId:string;baseRevision:number;stamp:string;updatedAt:number;snapshot:EditorSnapshot};
const database='canvas-local-drafts',store='drafts';
let connection:Promise<IDBDatabase>|null=null;

function open(){
  if(!connection)connection=new Promise<IDBDatabase>((resolve,reject)=>{
    if(!globalThis.indexedDB){reject(new Error('浏览器不支持本机草稿'));return;}
    const request=indexedDB.open(database,1);
    const timer=setTimeout(()=>reject(new Error('本机草稿存储暂不可用')),2500);
    request.onupgradeneeded=()=>{const db=request.result;if(!db.objectStoreNames.contains(store))db.createObjectStore(store,{keyPath:'id'}).createIndex('sessionId','sessionId');};
    request.onsuccess=()=>{clearTimeout(timer);request.result.onversionchange=()=>{request.result.close();connection=null;};resolve(request.result);};
    request.onerror=()=>{clearTimeout(timer);reject(request.error);};
    request.onblocked=()=>{clearTimeout(timer);reject(new Error('本机草稿存储被其他窗口占用'));};
  }).catch(error=>{connection=null;throw error;});
  return connection;
}

// Drafts can contain temporarily invalid values (for example an empty title).
// Check their shape without rejecting recoverable edits on export constraints.
function documentShape(value:unknown):value is DesignDocument{
  if(!value||typeof value!=='object')return false;const d=value as DesignDocument;
  const strings=(o:object,keys:string[])=>keys.every(key=>typeof (o as Record<string,unknown>)[key]==='string');
  const numbers=(o:object,keys:string[])=>keys.every(key=>Number.isFinite((o as Record<string,unknown>)[key]));
  const object=(o:DesignObject)=>o&&['locked','hidden'].every(key=>(o as Record<string,unknown>)[key]===undefined||typeof (o as Record<string,unknown>)[key]==='boolean')&&strings(o,['id'])&&numbers(o,['x','y','width','height'])&&(
    o.type==='text'?strings(o,['text','color'])&&numbers(o,['fontSize','lineHeight'])&&['left','center','right'].includes(o.align):
    o.type==='image'?strings(o,['assetId'])&&['contain','cover'].includes(o.fit):o.type==='rect'&&strings(o,['fill']));
  return d.schemaVersion===1&&typeof d.title==='string'&&Array.isArray(d.pages)&&d.pages.length>0&&d.pages.length<=20&&d.pages.every(p=>p&&strings(p,['id','name','background'])&&numbers(p,['width','height'])&&['mm','px'].includes(p.unit)&&Array.isArray(p.objects)&&p.objects.length<=300&&p.objects.every(object))&&
    (d.content===undefined||Array.isArray(d.content)&&d.content.length<=1000&&d.content.every(f=>f&&strings(f,['id','label','value'])&&['confirmed','needs_confirmation'].includes(f.status)));
}
function draftShape(value:unknown):value is LocalDraft{
  const d=value as LocalDraft|undefined;
  return !!d&&typeof d.id==='string'&&typeof d.sessionId==='string'&&typeof d.designId==='string'&&typeof d.stamp==='string'&&Number.isInteger(d.baseRevision)&&d.baseRevision>0&&Number.isFinite(d.updatedAt)&&!!d.snapshot&&documentShape(d.snapshot.document);
}
export async function listDrafts(sessionId:string,designId:string){
  const db=await open();
  return new Promise<LocalDraft[]>((resolve,reject)=>{
    const tx=db.transaction(store,'readonly'),request=tx.objectStore(store).index('sessionId').getAll(sessionId);
    tx.oncomplete=()=>resolve((request.result as unknown[]).filter(draftShape).filter(d=>d.designId===designId).sort((a,b)=>b.updatedAt-a.updatedAt));tx.onabort=()=>reject(tx.error);
  });
}
export async function putDraft(draft:LocalDraft){
  const db=await open();
  return new Promise<void>((resolve,reject)=>{const tx=db.transaction(store,'readwrite');tx.objectStore(store).put(draft);tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error);});
}
export async function removeDraft(id:string,stamp?:string){
  const db=await open();
  return new Promise<void>((resolve,reject)=>{
    const tx=db.transaction(store,'readwrite'),s=tx.objectStore(store);
    if(stamp){const request=s.get(id);request.onsuccess=()=>{if(request.result?.stamp===stamp)s.delete(id);};}else s.delete(id);
    tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error);
  });
}
