import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {PDFDocument} from 'pdf-lib';
import {createDocument,documentSchema,toPoints} from '../server/design/document.js';
import {layoutDocument,renderPdf,renderPreview} from '../server/design/render.js';
import {printObjects} from '../server/design/print-layout.js';
import {exportReport,exportSettingsSchema} from '../server/design/export-settings.js';
import {readAndRenderPdf} from './helpers/pdf.mjs';

const id='29620075-5cf3-4faa-9c7a-aed51acb2a5b';
const settings=exportSettingsSchema.parse({revision:1,format:'pdf',colorSpace:'cmyk',dpi:96,print:{bleedMm:3,bleedMode:'objects',safeMm:5}});
async function fixture(){
  const document=createDocument({width:100,height:80,unit:'mm'});
  document.pages[0].objects=[
    {id:'block',type:'rect',x:0,y:0,width:40,height:40,fill:'#0000ff',bleed:true},
    {id:'photo',type:'image',assetId:id,x:60,y:40,width:40,height:40,fit:'cover',bleed:true},
    {id:'logo',type:'image',assetId:id,x:45,y:0,width:10,height:10,fit:'contain'},
  ];
  const source=await sharp({create:{width:800,height:400,channels:3,background:'#ff0000'}}).png().toBuffer();
  return {document,layout:await layoutDocument(document,()=>source)};
}

async function sample(bytes,x,y){
  const {data}=await sharp(bytes).removeAlpha().extract({left:Math.round(x),top:Math.round(y),width:1,height:1}).raw().toBuffer({resolveWithObject:true});return [...data];
}

test('only opted-in edge objects extend, image aspect ratio is preserved and the stored document is unchanged',async()=>{
  const {document,layout}=await fixture(),before=structuredClone(document),page=layout.pages[0],objects=printObjects(page,settings.print,layout.assets),b=toPoints(3,'mm');
  assert.equal(objects[0].x,-b);assert.equal(objects[0].y,-b);assert.equal(objects[0].width,toPoints(43,'mm'));assert.equal(objects[0].height,toPoints(43,'mm'));
  assert.equal(objects[1].x,page.objects[1].x);assert.equal(objects[1].width,toPoints(43,'mm'));assert.equal(objects[1].draw.width/objects[1].draw.height,2);
  assert.ok(objects[1].ppi<page.objects[1].ppi);assert.equal(objects[2],page.objects[2],'Logo is not opted in');
  assert.deepEqual(printObjects(page,{...settings.print,bleedMm:0},layout.assets),page.objects);
  assert.deepEqual(printObjects(page,{...settings.print,bleedMode:'background'},layout.assets),page.objects);
  assert.deepEqual(document,before);assert.deepEqual(documentSchema.parse(document),document);
});

test('real CMYK PDF and RGB preview contain proportional image and shape bleed without writing guide lines',async()=>{
  const {layout}=await fixture(),preview=await renderPreview(layout,{print:settings.print}),background=await renderPreview(layout,{print:{...settings.print,bleedMode:'background'}});
  const p=mm=>(mm+3)*96/25.4;
  assert.deepEqual(await sample(preview.bytes,p(-1),p(10)),[0,0,255]);
  assert.deepEqual(await sample(preview.bytes,p(-1),p(-1)),[0,0,255]);
  assert.deepEqual(await sample(preview.bytes,p(101),p(70)),[255,0,0]);
  assert.deepEqual(await sample(preview.bytes,p(50),p(-1)),[255,255,255]);
  assert.deepEqual(await sample(background.bytes,p(-1),p(10)),[255,255,255]);
  const result=await renderPdf(layout,settings),pdf=await PDFDocument.load(result.bytes),page=pdf.getPage(0);
  assert.equal(result.verification.passed,true);assert.equal(result.pdfX,false);assert.ok(Math.abs(page.getWidth()-toPoints(106,'mm'))<.001);
  const rendered=await readAndRenderPdf(result.bytes),blue=await sample(rendered.png,p(-1),p(10)),red=await sample(rendered.png,p(101),p(70));
  assert.ok(blue[2]>blue[0]+40,`blue bleed: ${blue}`);assert.ok(red[0]>red[2]+40,`red bleed: ${red}`);
  const px=createDocument({width:400,height:320,unit:'px'});px.pages[0].objects=[{id:'edge',type:'rect',x:0,y:0,width:400,height:320,fill:'#123456',bleed:true}];
  const pxLayout=await layoutDocument(px,()=>{}),pxPreview=await renderPreview(pxLayout,{print:settings.print});
  assert.equal(pxPreview.width,Math.round((400*25.4/96+6)*96/25.4));assert.equal(pxPreview.geometry.trimWidth,300);
});

test('preflight measures extended image PPI, checks chosen safety distance and rejects contain-image extension',async()=>{
  const {document}=await fixture(),page=document.pages[0];
  page.objects=[{id:'photo',type:'image',assetId:id,x:0,y:0,width:100,height:50,fit:'cover',bleed:true},{id:'copy',type:'text',x:4,y:60,width:60,height:10,text:'Checked',fontSize:10,lineHeight:1.35,color:'#000000',align:'left'}];
  const layout=await layoutDocument(document,()=>sharp({create:{width:400,height:200,channels:3,background:'#f00'}}).png().toBuffer());
  assert.ok(layout.pages[0].objects[0].ppi>96);
  const body={...settings,print:{...settings.print,bleedMm:20}},report=exportReport(layout,body);
  assert.ok(report.issues.some(i=>i.code==='low_resolution'&&i.objectId==='photo'));
  assert.ok(report.issues.some(i=>i.code==='bleed_image_crop'));assert.ok(!report.issues.some(i=>i.code==='bleed_background_only'));
  assert.ok(report.issues.some(i=>i.code==='safe_margin'&&i.message.includes('5 mm')));
  assert.ok(!exportReport(layout,{...body,print:{...body.print,safeMm:3}}).issues.some(i=>i.code==='safe_margin'));
  document.pages[0].objects[0].fit='contain';const contain=await layoutDocument(document,()=>sharp({create:{width:400,height:200,channels:3,background:'#f00'}}).png().toBuffer());
  const failed=exportReport(contain,settings);assert.equal(failed.canExport,false);assert.ok(failed.issues.some(i=>i.code==='bleed_requires_cover'&&i.severity==='error'));
  assert.equal(exportReport(contain,{...settings,print:{...settings.print,bleedMode:'background'}}).canExport,true);
});
