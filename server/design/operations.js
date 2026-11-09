import {z} from 'zod';
import {documentSchema,designObjectSchema,contentFieldSchema,designError,backgroundSchema,designCanvasSchema} from './document.js';
import {assertLockedObjectsUnchanged} from '../../shared/design-objects.js';

export const contentChangeSchema=z.object({id:contentFieldSchema.shape.id,value:contentFieldSchema.shape.value,status:contentFieldSchema.shape.status}).strict();
export const pageSizeSchema=designCanvasSchema.pick({width:true,height:true,unit:true}).strict();
export const designChangesSchema=z.object({pageId:z.string().min(1).max(80).optional(),pageSize:pageSizeSchema.nullish(),upsertObjects:z.array(designObjectSchema).max(300),removeObjectIds:z.array(z.string()).max(300),newContent:z.array(contentFieldSchema).max(1000),contentUpdates:z.array(contentChangeSchema).max(1000),title:z.string().trim().min(1).max(100).nullable(),background:backgroundSchema.nullable()}).strict();

export function validateDesignAssets(document,session){
  const valid=id=>session.versions.some(v=>v.id===id&&!v.demo);
  for(const p of document.pages)for(const o of p.objects)if(o.type==='image'&&!valid(o.assetId))throw designError('图片素材必须来自当前会话');
  for(const field of document.content||[])if(field.sourceId&&!valid(field.sourceId))throw designError('内容来源必须是当前会话的真实素材');
}

export function applyDesignChanges(input,changes,activePageId){
  const doc=structuredClone(input),patch=designChangesSchema.parse(changes);
  const pageId=patch.pageId||activePageId||(doc.pages.length===1?doc.pages[0].id:null);
  const p=doc.pages.find(p=>p.id===pageId);if(!p)throw designError('请指定存在的目标页面 pageId');
  let lockBaseline=input;
  if(patch.pageSize){
    if(p.unit!==patch.pageSize.unit){
      const factor=patch.pageSize.unit==='mm'?25.4/96:96/25.4;
      lockBaseline=structuredClone(input);
      // Convert existing geometry before applying positions in the new unit.
      // Locked objects keep their physical size and placement during conversion.
      for(const page of [p,lockBaseline.pages.find(page=>page.id===p.id)]){
        for(const object of page.objects)for(const key of ['x','y','width','height'])object[key]*=factor;
      }
    }
    Object.assign(p,patch.pageSize);
  }
  const unique=(items,key)=>{const ids=items.map(key);if(new Set(ids).size!==ids.length)throw designError('同一批修改中不能重复提交相同 ID');};
  unique(patch.upsertObjects,o=>o.id);unique(patch.newContent,f=>f.id);unique(patch.contentUpdates,f=>f.id);unique(patch.removeObjectIds,id=>id);
  const objects=new Map(p.objects.map(o=>[o.id,o]));
  for(const id of patch.removeObjectIds){if(!objects.has(id))throw designError('要删除的设计对象不存在');objects.delete(id);}
  for(const o of patch.upsertObjects){
    if(patch.removeObjectIds.includes(o.id))throw designError('不能同时删除和更新同一个对象');
    const previous=objects.get(o.id);
    // Optional presentation flags omitted by an AI patch retain their state.
    for(const key of ['locked','hidden'])if(previous&&Object.hasOwn(previous,key)&&!Object.hasOwn(o,key))o[key]=previous[key];
    objects.set(o.id,o);
  }
  p.objects=[...objects.values()];
  const fields=new Map((doc.content||[]).map(f=>[f.id,f]));
  for(const f of patch.newContent){if(fields.has(f.id))throw designError('新增内容 ID 已存在，请通过 contentUpdates 修改');fields.set(f.id,f);}
  for(const change of patch.contentUpdates){const field=fields.get(change.id);if(!field)throw designError('要修改的内容字段不存在');Object.assign(field,change);}
  if(doc.content||fields.size)doc.content=[...fields.values()];
  for(const page of doc.pages)for(const o of page.objects)if(o.type==='text'&&o.bindingId){const field=fields.get(o.bindingId);if(field)o.text=field.value;}
  if(patch.title!==null)doc.title=patch.title;if(patch.background!==null)p.background=patch.background;
  assertLockedObjectsUnchanged(lockBaseline,doc);
  return documentSchema.parse(doc);
}
