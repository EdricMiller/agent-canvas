import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {PDFDocument,PDFDict,PDFName,PDFArray,PDFRawStream,decodePDFRawStream} from 'pdf-lib';
import {createDocument,documentSchema,toPoints} from '../server/design/document.js';
import {DocumentStore} from '../server/design/store.js';
import {layoutDocument,renderPreview,renderPdf,designCapabilities} from '../server/design/render.js';
import {designFixture} from './fixtures/design.mjs';
import {readAndRenderPdf} from './helpers/pdf.mjs';

test('document validates custom units, identity and supported object contracts',()=>{
  const px=createDocument({width:1200,height:900}),mm=createDocument({width:180,height:240,unit:'mm'});
  assert.equal(toPoints(px.pages[0].width,'px'),900);assert.ok(Math.abs(toPoints(mm.pages[0].width,'mm')-510.236)<.001);
  assert.throws(()=>documentSchema.parse({...px,schemaVersion:2}));
  assert.throws(()=>documentSchema.parse({...px,pages:[px.pages[0],px.pages[0]]}),/不能重复/);
  assert.throws(()=>documentSchema.parse({...px,pages:[{...px.pages[0],width:NaN}]}));
  assert.throws(()=>documentSchema.parse({...px,pages:[{...px.pages[0],objects:[{id:'html',type:'html',html:'<script>'}]}]}));
});

test('atomic draft persistence, revision conflicts and immutable version restore',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'canvas-document-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const store=new DocumentStore(dir),id='11111111-1111-4111-8111-111111111111',original=store.create(id,{title:'原始设计'});
  assert.equal(original.revision,1);const snapshot=store.snapshot(id,1,'第一版');
  const edited=structuredClone(snapshot.document);edited.title='改版';
  assert.equal(store.update(id,edited,2).revision,3);
  assert.throws(()=>store.update(id,edited,2),/其他窗口/);
  const restored=new DocumentStore(dir).restore(id,3,snapshot.versions[0].id);
  assert.equal(restored.document.title,'原始设计');assert.equal(restored.revision,4);
  assert.equal(restored.versions[0].document.title,'原始设计');assert.equal(store.view(restored).versions[0].document,undefined);
  assert.throws(()=>store.file('../outside'));assert.throws(()=>store.create(id,{}),/已有/);
});

test('layout preserves text, wraps it, reports missing glyphs/assets and prevents clipping',async()=>{
  const d=createDocument({width:500,height:700});
  const text='长标题应该换行，所有菜名和价格都保留。';
  d.pages[0].objects.push({id:'t',type:'text',text,x:20,y:20,width:140,height:250,fontSize:18,color:'#000000'});
  let layout=await layoutDocument(d,()=>{}),lines=layout.pages[0].objects[0].lines;
  assert.ok(lines.length>1);assert.equal(lines.map(l=>l.text).join(''),text);assert.equal(layout.issues.length,0);
  d.pages[0].objects[0].height=5;layout=await layoutDocument(d,()=>{});
  assert.ok(layout.issues.some(i=>i.code==='text_overflow'));
  await assert.rejects(renderPdf(layout),/超出/);
  d.pages[0].objects[0].text='\u{10FFFF}';d.pages[0].objects[0].height=50;
  assert.ok((await layoutDocument(d,()=>{})).issues.some(i=>i.code==='missing_glyph'));
  d.pages[0].objects=[{id:'image',type:'image',assetId:'11111111-1111-4111-8111-111111111111',x:0,y:0,width:50,height:50}];
  assert.ok((await layoutDocument(d,()=>{throw Error();})).issues.some(i=>i.code==='missing_asset'));
});

test('Chinese vector PDF embeds fonts and matches the shared preview including image crop/alpha',async()=>{
  const f=await designFixture(),layout=await layoutDocument(f.document,f.resolveAsset);
  assert.equal(layout.issues.filter(i=>i.severity==='error').length,0);
  assert.ok(layout.issues.some(i=>i.code==='low_resolution'));
  const preview=await renderPreview(layout),{bytes}=await renderPdf(layout),rendered=await readAndRenderPdf(bytes);
  assert.match(rendered.text,/让好想法，成为好设计/);assert.match(rendered.text,/独立文字/);
  const pdf=await PDFDocument.load(bytes),page=pdf.getPage(0);
  assert.ok(Math.abs(page.getWidth()-180*72/25.4)<.001);assert.ok(Math.abs(page.getHeight()-240*72/25.4)<.001);
  const fonts=page.node.Resources().lookup(PDFName.of('Font'),PDFDict);assert.ok(fonts.keys().length);
  for(const key of fonts.keys()){
    const top=fonts.lookup(key,PDFDict),cid=top.lookup(PDFName.of('DescendantFonts'),PDFArray).lookup(0,PDFDict);
    const descriptor=cid.lookup(PDFName.of('FontDescriptor'),PDFDict);
    assert.ok(descriptor.has(PDFName.of('FontFile2'))||descriptor.has(PDFName.of('FontFile3')),'font data is embedded');
    assert.ok(top.has(PDFName.of('ToUnicode')),'text remains extractable');
  }
  const a=await sharp(preview.bytes).removeAlpha().raw().toBuffer(),b=await sharp(rendered.png).resize(preview.width,preview.height).removeAlpha().raw().toBuffer();
  let total=0;for(let i=0;i<a.length;i++)total+=Math.abs(a[i]-b[i]);
  assert.ok(total/a.length<3,`preview/PDF mean channel difference: ${total/a.length}`);
  assert.equal((await sharp(preview.bytes).metadata()).width,preview.width);
});

test('CMYK PDF converts image/vector colors, embeds four-channel ICC and keeps alpha + Chinese text',async()=>{
  const f=await designFixture(),layout=await layoutDocument(f.document,f.resolveAsset),result=await renderPdf(layout,{colorSpace:'cmyk'});
  const pdf=await PDFDocument.load(result.bytes),context=pdf.context;
  const intent=pdf.catalog.lookup(PDFName.of('OutputIntents'),PDFArray).lookup(0,PDFDict);
  const icc=intent.lookup(PDFName.of('DestOutputProfile'),PDFRawStream),profile=decodePDFRawStream(icc).decode();
  assert.equal(icc.dict.lookup(PDFName.of('N')).asNumber(),4);assert.equal(Buffer.from(profile).subarray(16,20).toString(),'CMYK');
  let imageCount=0,maskCount=0;
  for(const [,value] of context.enumerateIndirectObjects()){
    if(!(value instanceof PDFRawStream)||value.dict.get(PDFName.of('Subtype'))?.toString()!=='/Image')continue;
    const space=value.dict.lookup(PDFName.of('ColorSpace'));
    if(space.toString()==='/DeviceGray'){maskCount++;continue;}
    imageCount++;assert.ok(space instanceof PDFArray);assert.equal(space.lookup(0).toString(),'/ICCBased');
    const colorProfile=space.lookup(1,PDFRawStream);assert.equal(colorProfile.dict.lookup(PDFName.of('N')).asNumber(),4);
    assert.equal(decodePDFRawStream(value).decode().length,value.dict.lookup(PDFName.of('Width')).asNumber()*value.dict.lookup(PDFName.of('Height')).asNumber()*4);
  }
  assert.equal(imageCount,2);assert.ok(maskCount>=1);
  const contents=pdf.getPage(0).node.Contents();
  const streams=contents instanceof PDFArray?contents.asArray().map(r=>context.lookup(r,PDFRawStream)):[contents];
  const operators=streams.map(s=>Buffer.from(decodePDFRawStream(s).decode()).toString()).join('\n');
  assert.match(operators,/0 0 0 1 k/);assert.doesNotMatch(operators,/\s(?:rg|RG)\s/);
  const rendered=await readAndRenderPdf(result.bytes);assert.match(rendered.text,/让好想法/);assert.ok(rendered.png.length>10000);
  assert.equal(result.pdfX,false);assert.equal((await designCapabilities()).pdfX,false);
});

test('custom pixel dimensions, multi-page PDF contract, and image output limits',async()=>{
  const d=createDocument({width:640,height:360});d.pages.push({...d.pages[0],id:'second',width:150,height:200,unit:'mm'});
  const layout=await layoutDocument(d,()=>{}),png=await renderPreview(layout,{pageId:d.pages[0].id,scale:2});
  assert.equal(png.width,1280);assert.equal(png.height,720);
  const pdf=await PDFDocument.load((await renderPdf(layout)).bytes);assert.equal(pdf.getPageCount(),2);
  assert.equal(pdf.getPage(0).getWidth(),480);assert.ok(Math.abs(pdf.getPage(1).getWidth()-150*72/25.4)<.001);
  await assert.rejects(renderPreview(layout,{scale:10}),/缩放/);
  await assert.rejects(renderPdf(layout,{pageId:'missing'}),/不存在/);
});
