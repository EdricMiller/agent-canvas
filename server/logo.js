import {randomUUID} from 'node:crypto';
import {tool} from '@openai/agents';
import {z} from 'zod';
import {createDocument,documentSchema,designError} from './design/document.js';
import {layoutDocument,measureDesignText} from './design/render.js';
import {assertLockedObjectsUnchanged} from '../shared/design-objects.js';
import {imageTargetGeometry} from './image-target.js';
import {assertTransparentImage} from './image-output.js';

export const logoCompositionSchema=z.object({
  imageId:z.string().uuid(),brandName:z.string().trim().min(1).max(100),
  layout:z.enum(['stacked','horizontal']),pageId:z.string().min(1).max(80).nullable(),
  label:z.string().trim().min(1).max(100),
}).strict();

function logoObjects(page){
  const image=page.objects.find(o=>o.type==='image'&&o.id.startsWith('logo-image-'));
  const text=page.objects.find(o=>o.type==='text'&&o.id.startsWith('logo-text-')&&o.bindingId?.startsWith('logo-brand-'));
  return image&&text?{image,text}:null;
}

export async function composeLogo({session,store,documents,revision,signal},input){
  signal.throwIfAborted();const body=logoCompositionSchema.parse(input),record=documents.get(session.id);
  if((record?.revision??null)!==revision)throw designError('设计稿已被其他窗口更新，请刷新后再组合 Logo',409);
  const asset=session.versions.find(v=>v.id===body.imageId&&!v.demo);
  if(!asset)throw designError('Logo 图形必须来自当前会话的真实素材');
  await assertTransparentImage(store.image(session,body.imageId).bytes);
  let document,page;
  if(body.pageId){
    document=structuredClone(record?.document);page=document?.pages.find(p=>p.id===body.pageId);
    const objects=page&&logoObjects(page);
    if(!objects)throw designError('请选择此前组合的 Logo 页面；新 Logo 请新增页面');
    const field=document.content?.find(f=>f.id===objects.text.bindingId);
    if(!field)throw designError('Logo 店名绑定已变化，请在内容面板修改或新增 Logo 页面');
    objects.image.assetId=body.imageId;field.value=body.brandName;field.status='confirmed';
    for(const p of document.pages)for(const o of p.objects)if(o.type==='text'&&o.bindingId===field.id)o.text=body.brandName;
    assertLockedObjectsUnchanged(record.document,document);
  }else{
    const geometry=session.imageTarget?imageTargetGeometry(session.imageTarget):body.layout==='horizontal'?{width:1600,height:800}:{width:1200,height:1200};
    const fresh=createDocument({title:`${body.brandName.slice(0,80)} · Logo`,...geometry,background:'transparent'});
    // targetGeometry also returns aspect fields; only document fields are stored.
    page=fresh.pages[0];page.name=`Logo · ${body.brandName.slice(0,80)}`;
    document=record?structuredClone(record.document):fresh;
    if(record)document.pages.push(page);
    const id=randomUUID(),w=page.width,h=page.height,horizontal=body.layout==='horizontal';
    const box=horizontal?{x:w*.5,y:h*.28,width:w*.44,height:h*.44}:{x:w*.08,y:h*.75,width:w*.84,height:h*.18};
    let fontSize=Math.min(120,box.width*.75*.25,box.height*.75/1.4);
    for(let n=0;n<40;n++){
      const measured=measureDesignText(body.brandName,box.width*.75,fontSize,1.25);
      if(measured.width<=box.width*.75&&measured.height<=box.height*.75)break;
      fontSize*=.9;
    }
    if(fontSize<4)throw designError('当前尺寸无法清晰放下店名，请增加画布尺寸或缩短文字');
    const field={id:`logo-brand-${id}`,label:'品牌 / 店名',value:body.brandName,status:'confirmed'};
    (document.content||=[]).push(field);
    page.objects=[
      {id:`logo-image-${id}`,type:'image',assetId:body.imageId,fit:'contain',x:w*.08,y:h*.08,width:horizontal?w*.36:w*.84,height:horizontal?h*.84:h*.60},
      {id:`logo-text-${id}`,type:'text',bindingId:field.id,text:body.brandName,...box,fontSize,lineHeight:1.25,color:'#222222',align:'center'},
    ];
  }
  const parsed=documentSchema.parse(document),layout=await layoutDocument(parsed,id=>store.image(session,id).bytes);
  const errors=layout.issues.filter(i=>i.pageId===page.id&&i.severity==='error');
  if(errors.length)throw designError('Logo 排版未通过检查，尚未保存',422,errors);
  signal.throwIfAborted();
  const saved=documents.commit(session.id,parsed,revision,body.label);
  return {record:saved,pageId:page.id,issues:layout.issues.filter(i=>i.pageId===page.id)};
}

export function createLogoTools(context){
  const {session,documents,job,signal,emit}=context;
  const revision=Object.hasOwn(job,'logoRevision')?job.logoRevision:documents.get(session.id)?.revision??null;
  return [
    tool({name:'read_logo_design',description:'读取此前分层组合的 Logo 页、图形 ID 和独立店名。只有这些分层稿可直接改独立文字；完整一体化图片改字需 render_image 编辑原图。',parameters:z.object({}).strict(),async execute(){
      signal.throwIfAborted();const record=documents.get(session.id);
      return {revision:record?.revision??null,logos:record?.document.pages.flatMap(p=>{const o=logoObjects(p);return o?[{pageId:p.id,imageId:o.image.assetId,brandName:o.text.text,locked:!!o.image.locked||!!o.text.locked}]:[]})||[]};
    }}),
    tool({name:'compose_logo',description:'仅用于用户明确要求独立可编辑文字的分层组合稿，或修改已有分层稿。默认一体化 Logo 应用 render_image 将准确店名与图形统一生成，完成后直接交付，不调用本工具。分层稿 pageId=null 新增页面，传此前 Logo pageId 更新图形与店名并保留排版；不得给已含店名的整图重复叠字，不覆盖其他设计。',parameters:logoCompositionSchema,async execute(input){
      try{
        if(job.designResult)throw designError('本轮 Logo 已保存，请交付当前结果，等待用户下一轮修改');
        const {record,pageId,issues}=await composeLogo({...context,revision},input);
        job.designResult={documentId:record.id,revision:record.revision,versionId:record.versions.at(-1).id,pageId,pageCount:record.document.pages.length,objectCount:record.document.pages.reduce((n,p)=>n+p.objects.length,0)};
        emit('design_saved',{text:'Logo 已组合并保存：图形与店名可独立编辑，PNG 保留透明背景',revision:record.revision});
        return {saved:true,...job.designResult,issues,next:'直接交付，说明可在内容面板修改店名并下载透明 PNG；图形仍为位图。'};
      }catch(error){
        if(signal.aborted)throw error;
        emit('design_validation',{text:error.message});
        return {saved:false,error:error.message,conflict:error.status===409,...(error.details?{issues:error.details}:{})};
      }
    }}),
  ];
}
