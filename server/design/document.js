import {z} from 'zod';
import {randomUUID} from 'node:crypto';

const id=z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
const length=z.number().finite().positive().max(20000);
const position=z.number().finite().min(0).max(20000);
const color=z.string().regex(/^#[\da-f]{6}$/i);
export const backgroundSchema=z.union([color,z.literal('transparent')]);
const box={id,x:position,y:position,width:length,height:length,locked:z.boolean().optional(),hidden:z.boolean().optional()};
export const contentFieldSchema=z.object({id,label:z.string().trim().min(1).max(100),value:z.string().max(10000),sourceId:z.string().uuid().optional(),status:z.enum(['confirmed','needs_confirmation'])}).strict();
const text=z.object({...box,type:z.literal('text'),text:z.string().max(10000),fontSize:z.number().finite().min(4).max(400),lineHeight:z.number().finite().min(1).max(3).default(1.35),color:color.default('#292a31'),align:z.enum(['left','center','right']).default('left'),bindingId:id.optional()}).strict();
const image=z.object({...box,type:z.literal('image'),assetId:z.string().uuid(),fit:z.enum(['contain','cover']).default('contain'),bleed:z.boolean().optional()}).strict();
const shape=z.object({...box,type:z.literal('rect'),fill:color,bleed:z.boolean().optional()}).strict();
export const designObjectSchema=z.union([text,image,shape]);
const page=z.object({id,name:z.string().trim().min(1).max(100),width:length,height:length,unit:z.enum(['px','mm']),background:backgroundSchema.default('#ffffff'),objects:z.array(designObjectSchema).max(300)}).strict();
export const documentInputSchema=z.object({schemaVersion:z.literal(1),title:z.string().trim().min(1).max(100),pages:z.array(page).min(1).max(20),content:z.array(contentFieldSchema).max(1000).optional()}).strict();
export const documentSchema=documentInputSchema.superRefine((doc,ctx)=>{
  const ids=new Set();
  const fields=new Map();
  for(const [index,field] of (doc.content||[]).entries()){
    if(fields.has(field.id))ctx.addIssue({code:'custom',message:'内容字段 ID 不能重复',path:['content',index,'id']});
    fields.set(field.id,field);
  }
  for(const [pi,p] of doc.pages.entries()){
    for(const [oi,o] of [p,...p.objects].entries()){
      if(ids.has(o.id))ctx.addIssue({code:'custom',message:'页面和对象的 ID 不能重复',path:['pages',pi,...(oi?['objects',oi-1]:[]),'id']});
      ids.add(o.id);
      if(o.type==='text'&&o.bindingId){
        const field=fields.get(o.bindingId);
        if(!field||field.value!==o.text)ctx.addIssue({code:'custom',message:'文字必须与绑定的内容字段保持一致',path:['pages',pi,'objects',oi-1,'bindingId']});
      }
    }
    const factor=p.unit==='mm'?72/25.4:72/96;
    if(p.width*factor>14400||p.height*factor>14400)ctx.addIssue({code:'custom',message:'页面尺寸超过当前支持范围',path:['pages',pi]});
  }
});

export const designCanvasSchema=z.object({title:z.string().trim().min(1).max(100),width:length,height:length,unit:z.enum(['px','mm']),background:backgroundSchema}).strict();
export const designTurnSchema=z.object({revision:z.number().int().positive().nullable(),pageId:z.string().min(1).max(80).optional(),canvas:designCanvasSchema,referenceIds:z.array(z.string().uuid()).max(8).refine(ids=>new Set(ids).size===ids.length)}).strict();

export const toPoints=(value,unit)=>value*(unit==='mm'?72/25.4:72/96);

export function createDocument({title='未命名设计稿',width=1200,height=1600,unit='px',background='#ffffff'}={}){
  return documentSchema.parse({schemaVersion:1,title,pages:[{id:randomUUID(),name:'第 1 页',width,height,unit,background,objects:[]}]});
}

export function designError(message,status=400,details){
  return Object.assign(new Error(message),{status,...(details?{details}:{})});
}
