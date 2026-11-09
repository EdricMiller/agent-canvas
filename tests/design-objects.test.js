import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {changeObject,lockedBinding} from '../shared/design-objects.js';
import {transformBox} from '../shared/design-geometry.js';
import {createDocument,documentSchema} from '../server/design/document.js';
import {applyDesignChanges} from '../server/design/operations.js';
import {layoutDocument,renderPreview,renderPdf,editorTextLayers} from '../server/design/render.js';
import {exportReport,exportSettingsSchema,printSettingsSchema} from '../server/design/export-settings.js';
import {readAndRenderPdf} from './helpers/pdf.mjs';

const fixture=()=>{
  const doc=createDocument({width:160,height:120});
  doc.content=[{id:'word',label:'品牌',value:'Hello',status:'confirmed'}];
  doc.pages[0].objects=[{id:'red',type:'rect',x:0,y:0,width:160,height:120,fill:'#ff0000'},
    {id:'blue',type:'rect',x:20,y:20,width:60,height:60,fill:'#0000ff'},
    {id:'word-object',type:'text',x:85,y:20,width:70,height:60,text:'Hello',fontSize:14,lineHeight:1.35,color:'#000000',align:'left',bindingId:'word'}];
  return doc;
};
const op=(doc,id,operation,newId)=>changeObject(doc,doc.pages[0].id,id,operation,newId);
const patch=extra=>({upsertObjects:[],removeObjectIds:[],newContent:[],contentUpdates:[],title:null,background:null,...extra});
const pixel=async(bytes,x,y)=>{const {data}=await sharp(bytes).removeAlpha().raw().toBuffer({resolveWithObject:true});const width=(await sharp(bytes).metadata()).width;return [...data.subarray((y*width+x)*3,(y*width+x)*3+3)];};

test('duplicate creates independent bound content, preserves provenance, selects the editable copy and enforces limits',()=>{
  const input=fixture();input.pages[0].objects[2].locked=true;input.pages[0].objects[2].hidden=true;
  input.content[0].sourceId=randomUUID();const before=structuredClone(input);let id=0;
  const result=op(input,'word-object',{type:'duplicate'},()=>`copy-${++id}`),copy=result.document.pages[0].objects[3];
  assert.deepEqual(input,before);assert.equal(result.selectedId,copy.id);assert.equal(copy.locked,undefined);assert.equal(copy.hidden,undefined);
  assert.equal(copy.x,90,'copy remains inside the page');assert.equal(copy.y,32);
  assert.notEqual(copy.bindingId,'word');assert.deepEqual(result.document.content[1],{...input.content[0],id:copy.bindingId});
  const updated=applyDesignChanges(result.document,patch({contentUpdates:[{id:copy.bindingId,value:'COPY',status:'confirmed'}]}));
  assert.equal(updated.pages[0].objects[2].text,'Hello');assert.equal(updated.pages[0].objects[3].text,'COPY');
  assert.ok(documentSchema.safeParse(updated).success);
  const full=fixture();full.pages[0].objects=Array.from({length:300},(_,i)=>({...full.pages[0].objects[0],id:`obj-${i}`}));
  assert.throws(()=>op(full,'obj-0',{type:'duplicate'}),/300/);
  const contentFull=fixture();contentFull.content.push(...Array.from({length:999},(_,i)=>({id:`field-${i}`,label:'字段',value:'',status:'confirmed'})));
  assert.throws(()=>op(contentFull,'word-object',{type:'duplicate'}),/1000/);
});

test('replace and reorder preserve frame, fit, bleed, identities and unrelated pages',()=>{
  const input=fixture(),image={id:'image',type:'image',assetId:randomUUID(),x:9,y:8,width:80,height:40,fit:'cover',bleed:true};
  input.pages[0].objects.push(image);input.pages.push({...structuredClone(input.pages[0]),id:'other',objects:[]});
  const newAsset=randomUUID(),changed=op(input,'image',{type:'replace',assetId:newAsset}).document;
  assert.deepEqual(changed.pages[0].objects.at(-1),{...image,assetId:newAsset});assert.deepEqual(changed.pages[1],input.pages[1]);
  const back=op(changed,'image',{type:'order',direction:'back'}).document;assert.equal(back.pages[0].objects[0].id,'image');
  const forward=op(back,'image',{type:'order',direction:'forward'}).document;assert.equal(forward.pages[0].objects[1].id,'image');
  const top=op(forward,'image',{type:'order',direction:'front'}).document;assert.equal(top.pages[0].objects.at(-1).id,'image');
  const backward=op(top,'image',{type:'order',direction:'backward'}).document;assert.equal(backward.pages[0].objects.at(-2).id,'image');
  const locked=op(input,'image',{type:'lock',value:true}).document;
  assert.throws(()=>op(locked,'image',{type:'replace',assetId:newAsset}),/锁定/);assert.throws(()=>op(locked,'image',{type:'order',direction:'back'}),/锁定/);
  assert.equal(op(locked,'image',{type:'visibility',value:true}).document.pages[0].objects.at(-1).hidden,true);
  assert.equal(op(locked,'image',{type:'lock',value:false}).document.pages[0].objects.at(-1).locked,false);
});

test('AI cannot move/delete/unlock/rebind locked objects or alter shared locked text across pages',()=>{
  const input=fixture();input.pages[0].objects[2].locked=true;
  input.pages.push({...structuredClone(input.pages[0]),id:'other',objects:[{...input.pages[0].objects[2],id:'other-word',locked:false}]});
  assert.equal(lockedBinding(input,'word'),true);
  for(const extra of [{removeObjectIds:['word-object']},{upsertObjects:[{...input.pages[0].objects[2],x:0}]},{upsertObjects:[{...input.pages[0].objects[2],locked:false}]},{contentUpdates:[{id:'word',value:'changed',status:'confirmed'}]}])assert.throws(()=>applyDesignChanges(input,patch(extra),input.pages[0].id),/锁定/);
  assert.throws(()=>applyDesignChanges(input,patch({contentUpdates:[{id:'word',value:'changed',status:'confirmed'}]}),'other'),/锁定/);
  const same={...input.pages[0].objects[2]};delete same.locked;
  assert.deepEqual(applyDesignChanges(input,patch({upsertObjects:[same]}),input.pages[0].id),documentSchema.parse(input));
  input.pages[0].objects[0].hidden=true;
  const red={...input.pages[0].objects[0],x:1};delete red.hidden;
  assert.equal(applyDesignChanges(input,patch({upsertObjects:[red]}),input.pages[0].id).pages[0].objects[0].hidden,true);
});

test('hidden objects do not snap, render, resolve images, contribute glyphs or block print preflight; original data stays intact',async()=>{
  const document=fixture();document.pages[0].objects[2].hidden=true;document.content[0].status='needs_confirmation';
  document.pages[0].objects.push({id:'bad-image',type:'image',assetId:randomUUID(),x:158,y:119,width:50,height:50,fit:'contain',hidden:true,bleed:true});
  const original=structuredClone(document),layout=await layoutDocument(document,()=>{assert.fail('hidden images must not be decoded');});
  assert.deepEqual(document,original);assert.equal(layout.issues.length,0);assert.equal(editorTextLayers(layout,document.pages[0].id).objects.length,0);
  assert.equal(layout.pages[0].objects.length,2);assert.equal(layout.document.pages[0].objects.length,4);
  const report=exportReport(layout,exportSettingsSchema.parse({revision:1,format:'pdf',colorSpace:'cmyk',print:{bleedMm:3,bleedMode:'objects'}}));
  assert.equal(report.errors,0);assert.ok(!report.issues.some(i=>['word-object','bad-image'].includes(i.objectId)));
  const print=await renderPdf(layout,{colorSpace:'cmyk',print:printSettingsSchema.parse({bleedMm:3,bleedMode:'objects'})});
  assert.equal(print.verification.passed,true);assert.doesNotMatch((await readAndRenderPdf(print.bytes)).text,/Hello/);
  const visible=structuredClone(document);visible.pages[0].objects[2].hidden=false;
  assert.ok((await layoutDocument(visible,()=>{})).issues.some(i=>i.code==='unconfirmed_content'));
  const page={width:200,height:200,unit:'px',objects:[{id:'ghost',x:31,y:55,width:10,height:10,hidden:true}]};
  assert.equal(transformBox(page,{id:'moving',x:20,y:100,width:10,height:10},{dx:2,snap:true,tolerance:2}).box.x,22);
});

test('PNG and RGB/CMYK PDFs paint object order consistently and never export hidden text or shapes',async()=>{
  let document=fixture();document.pages[0].objects[2].hidden=true;
  let layout=await layoutDocument(document,()=>{});assert.deepEqual(await pixel((await renderPreview(layout)).bytes,40,40),[0,0,255]);
  document=op(document,'red',{type:'order',direction:'front'}).document;layout=await layoutDocument(document,()=>{});
  assert.deepEqual(await pixel((await renderPreview(layout)).bytes,40,40),[255,0,0]);
  for(const colorSpace of ['rgb','cmyk']){
    const pdf=await renderPdf(layout,{colorSpace}),rendered=await readAndRenderPdf(pdf.bytes);assert.doesNotMatch(rendered.text,/Hello/);
    const rgb=await pixel(rendered.png,40,40);assert.ok(rgb[0]>rgb[1]+80&&rgb[0]>rgb[2]+80,`${colorSpace} preserves frontmost red`);
  }
  document=op(document,'red',{type:'visibility',value:true}).document;layout=await layoutDocument(document,()=>{});
  assert.deepEqual(await pixel((await renderPreview(layout)).bytes,40,40),[0,0,255]);
  const rendered=await readAndRenderPdf((await renderPdf(layout)).bytes);assert.deepEqual(await pixel(rendered.png,40,40),[0,0,255]);
});
