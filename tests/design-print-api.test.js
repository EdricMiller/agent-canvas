import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {PDFDocument,PDFName,PDFRawStream,decodePDFRawStream} from 'pdf-lib';
import {createApp} from '../server/app.js';
import {getDefaultPrintProfile} from '../server/design/profiles.js';
import {designFixture} from './fixtures/design.mjs';
import {readPdfPages} from './helpers/pdf.mjs';

async function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'canvas-print-api-')),instance=createApp({root:path.resolve(import.meta.dirname,'..'),dataDir:dir,demo:true,agentModel:'test',imageModel:'test',sandboxMode:'off'});
  const server=await new Promise((resolve,reject)=>{const s=instance.app.listen(0,'127.0.0.1');s.once('listening',()=>resolve(s));s.once('error',reject);});
  t.after(()=>{instance.shutdown();server.closeAllConnections();server.close();fs.rmSync(dir,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}`,config=await(await fetch(base+'/api/config')).json(),session=instance.store.create();
  const request=(url,method='GET',body,token=config.token)=>fetch(base+url,{method,headers:{'Content-Type':'application/json','X-Studio-Token':token},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const f=await designFixture(),idMap=new Map();for(const [id,bytes] of f.assets){const image=instance.store.addImage(session,bytes,{kind:'upload',demo:false});idMap.set(id,image.id);}
  for(const o of f.document.pages[0].objects)if(o.type==='image')o.assetId=idMap.get(o.assetId);
  instance.documents.createFromDocument(session.id,f.document);
  return {...instance,request,session,url:`/api/sessions/${session.id}/design`};
}
const body={revision:1,format:'pdf',colorSpace:'cmyk',dpi:300,print:{profileId:'default',bleedMm:3,cropMarks:true,blackText:'preserve'}};

test('original-size image JPG keeps native dimensions and fine color edges',async t=>{
  const f=await fixture(t),width=128,height=96,pixels=Buffer.alloc(width*height*3);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const offset=(y*width+x)*3,color=(Math.floor(x/8)+Math.floor(y/8))%2===0?[240,30,30]:[20,40,240];
    pixels.set(color,offset);
  }
  const source=await sharp(pixels,{raw:{width,height,channels:3}}).png().toBuffer();
  const image=f.store.addImage(f.session,source,{kind:'generated',demo:false,width,height});
  const response=await f.request(f.url+'/export-image','POST',{imageId:image.id,format:'jpeg'});
  assert.equal(response.status,200,await response.clone().text());
  const jpeg=Buffer.from(await response.arrayBuffer()),metadata=await sharp(jpeg).metadata();
  assert.equal(metadata.width,width);assert.equal(metadata.height,height);assert.equal(metadata.chromaSubsampling,'4:4:4');
  const output=await sharp(jpeg).raw().toBuffer();
  const difference=pixels.reduce((sum,value,i)=>sum+Math.abs(value-output[i]),0)/pixels.length;
  assert.ok(difference<5,`native JPG color edge difference: ${difference}`);
});

test('print API checks before delivery, validates ICC import, keeps file geometry and rejects unsupported settings',async t=>{
  const f=await fixture(t),before=f.documents.require(f.session.id);
  const check=await f.request(f.url+'/export-check','POST',body);assert.equal(check.status,200);
  const report=await check.json();assert.equal(report.canExport,true);assert.ok(report.warnings>0);assert.equal(report.pdfX,false);assert.equal(report.pages.length,1);assert.ok(report.issues.some(i=>i.message.includes('300 PPI')));
  assert.equal((await f.request(f.url+'/export','POST',body)).status,422);
  const file=await f.request(f.url+'/export','POST',{...body,acknowledgeWarnings:true});assert.equal(file.status,200);assert.equal(file.headers.get('x-design-print-verified'),'true');assert.match(decodeURIComponent(file.headers.get('content-disposition')),/-r1-p1-cmyk.pdf/);
  const pdf=await PDFDocument.load(await file.arrayBuffer()),page=pdf.getPage(0);assert.ok(Math.abs(page.getTrimBox().width-180*72/25.4)<.001);assert.ok(Math.abs(page.getWidth()-202*72/25.4)<.001);
  const profile=await getDefaultPrintProfile();
  assert.equal((await f.request('/api/design/profiles','POST',{name:'印刷方ICC',description:'目标印刷条件',data:profile.icc.toString('base64')},'')).status,403);
  const imported=await f.request('/api/design/profiles','POST',{name:'印刷方ICC',description:'目标印刷条件',data:profile.icc.toString('base64')});assert.equal(imported.status,201);const selected=await imported.json();assert.equal(selected.hash,profile.hash);assert.ok(!JSON.stringify(selected).includes('target'));
  assert.equal((await(await f.request('/api/design/profiles')).json()).length,2);
  const selectedReport=await(await f.request(f.url+'/export-check','POST',{...body,print:{...body.print,profileId:selected.id}})).json();assert.equal(selectedReport.profile.id,selected.id);assert.equal(selectedReport.issues.some(i=>i.code==='proof_profile'),false);
  const selectedPdf=await f.request(f.url+'/export','POST',{...body,print:{...body.print,profileId:selected.id},acknowledgeWarnings:true});assert.equal(selectedPdf.status,200);assert.equal(selectedPdf.headers.get('x-design-print-verified'),'true');
  for(const invalid of [{...body,print:{...body.print,bleedMm:-1}},{...body,print:{...body.print,profileId:'../secret'}},{...body,format:'png'},{...body,colorSpace:'rgb'},{...body,dpi:1000},{...body,pdfX:true},{...body,revision:2}])assert.ok((await f.request(f.url+'/export-check','POST',invalid)).status>=400);
  const unknown=await f.request(f.url+'/export','POST',{...body,print:{...body.print,profileId:'icc-'+'f'.repeat(64)},acknowledgeWarnings:true});assert.equal(unknown.status,404);
  assert.deepEqual(f.documents.require(f.session.id),before);
});

test('exports keep captured revision while editing continues; bitmap PDF uses requested physical size without creating a design',async t=>{
  const f=await fixture(t),before=f.documents.require(f.session.id),original=f.store.image.bind(f.store);let changed=false;
  t.mock.method(f.store,'image',(...args)=>{
    if(!changed){changed=true;const next=structuredClone(before.document);next.pages[0].objects.find(o=>o.id==='title').text='另一个窗口的新标题';f.documents.update(f.session.id,next,before.revision);}
    return original(...args);
  });
  const file=await f.request(f.url+'/export','POST',{revision:1,format:'pdf'});assert.equal(file.status,200);assert.equal(file.headers.get('x-design-revision'),'1');
  const pages=await readPdfPages(await file.arrayBuffer());assert.match(pages[0],/让好想法/);assert.doesNotMatch(pages[0],/新标题/);assert.equal(f.documents.require(f.session.id).revision,2);
  const other=f.store.create(),image=f.store.addImage(other,await sharp({create:{width:120,height:180,channels:3,background:'#abc'}}).png().toBuffer(),{kind:'generated',demo:false});
  const url=`/api/sessions/${other.id}/design`,imageBody={imageId:image.id,format:'pdf',colorSpace:'cmyk',width:130,height:190,unit:'mm',dpi:150,print:{bleedMm:1,cropMarks:false}};
  const report=await(await f.request(url+'/export-image-check','POST',imageBody)).json();assert.equal(report.revision,null);assert.ok(report.issues.some(i=>i.code==='low_resolution'));
  assert.equal((await f.request(url+'/export-image','POST',imageBody)).status,422);
  const bitmap=await f.request(url+'/export-image','POST',{...imageBody,acknowledgeWarnings:true});assert.equal(bitmap.status,200);const pdf=await PDFDocument.load(await bitmap.arrayBuffer());assert.ok(Math.abs(pdf.getPage(0).getTrimBox().width-130*72/25.4)<.001);assert.equal(f.documents.get(other.id),null);assert.equal(other.versions.length,1);
});

test('print preview uses the checked source/range/settings, stays available for fixing errors and never mutates documents',async t=>{
  const f=await fixture(t),record=f.documents.require(f.session.id),next=structuredClone(record.document);
  next.pages[0].objects.find(o=>o.id==='photo').x=0;
  next.pages.push({...structuredClone(next.pages[0]),id:'other-page',objects:[]});
  f.documents.update(f.session.id,next,record.revision);const before=structuredClone(f.documents.require(f.session.id));
  const previewBody={...body,revision:2,pageId:next.pages[0].id,print:{...body.print,bleedMode:'objects',safeMm:6}};
  assert.equal((await f.request(f.url+'/export-preview','POST',previewBody,'')).status,403);
  const response=await f.request(f.url+'/export-preview','POST',previewBody);assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
  const preview=await response.json();assert.equal(preview.pageId,next.pages[0].id);assert.equal(preview.revision,2);assert.ok(preview.width<=1400&&preview.height<=1400);assert.match(preview.dataUrl,/^data:image\/png;base64,/);
  const info=await sharp(Buffer.from(preview.dataUrl.split(',')[1],'base64')).metadata();assert.equal(info.width,preview.width);assert.equal(info.height,preview.height);assert.ok(Math.abs(preview.geometry.safe-6*72/25.4)<.001);
  assert.equal((await f.request(f.url+'/export-preview','POST',{...previewBody,previewPageId:'other-page'})).status,404);
  assert.equal((await f.request(f.url+'/export-preview','POST',{...previewBody,revision:1})).status,409);
  assert.equal((await f.request(f.url+'/export-preview','POST',{...previewBody,colorSpace:'rgb'})).status,400);
  assert.equal((await f.request(f.url+'/export-preview','POST',{...previewBody,print:{...previewBody.print,safeMm:-1}})).status,400);
  assert.deepEqual(f.documents.require(f.session.id),before);
  const invalid=structuredClone(before.document),photo=invalid.pages[0].objects.find(o=>o.id==='photo');photo.bleed=true;photo.fit='contain';
  f.documents.update(f.session.id,invalid,2);
  const broken={...previewBody,revision:3},report=await(await f.request(f.url+'/export-check','POST',broken)).json();
  assert.equal(report.canExport,false);assert.ok(report.issues.some(i=>i.code==='bleed_requires_cover'));
  assert.equal((await f.request(f.url+'/export-preview','POST',broken)).status,200);
  assert.equal((await f.request(f.url+'/export','POST',{...broken,acknowledgeWarnings:true})).status,422);
  const imageId=f.session.versions[0].id,imageBody={format:'pdf',colorSpace:'cmyk',imageId,width:100,height:150,unit:'mm',print:previewBody.print};
  const imageCheck=await(await f.request(f.url+'/export-image-check','POST',imageBody)).json();
  const imagePreview=await(await f.request(f.url+'/export-image-preview','POST',{...imageBody,previewPageId:imageCheck.pages[0].id})).json();
  assert.equal(imagePreview.pageId,imageCheck.pages[0].id);assert.equal(imagePreview.revision,null);assert.ok(Math.abs(imagePreview.geometry.trimWidth-100*72/25.4)<.001);
  assert.equal(f.documents.require(f.session.id).revision,3);assert.equal(f.documents.require(f.session.id).versions.length,before.versions.length);
});

test('print-ready RGB PDFs use native source pixels, derive 300 PPI page size, and reject enlargement without enough detail',async t=>{
  const f=await fixture(t),other=f.store.create(),source=await sharp({create:{width:900,height:1500,channels:3,background:'#c93618'}}).png().toBuffer();
  const working=await sharp(source).resize(180,300).png().toBuffer();
  const image=f.store.addImage(other,working,{kind:'generated',demo:false,width:180,height:300,adaptation:{method:'resize',sourceWidth:900,sourceHeight:1500,upscaled:false,background:'#fff'}},{originalBytes:source});
  const endpoint=`/api/sessions/${other.id}/design`,request={imageId:image.id,format:'pdf',colorSpace:'rgb',printReady:true,dpi:300},before=JSON.stringify(other);
  const ordinary=await f.request(endpoint+'/export-image','POST',{imageId:image.id,format:'pdf',colorSpace:'rgb'});
  assert.equal(ordinary.status,200);const ordinaryPdf=await PDFDocument.load(await ordinary.arrayBuffer());
  assert.ok(Math.abs(ordinaryPdf.getPage(0).getWidth()-135)<.001,'ordinary PDF keeps the working image page size');
  const ordinaryImage=ordinaryPdf.context.enumerateIndirectObjects().map(([,o])=>o).find(o=>o instanceof PDFRawStream&&o.dict.get(PDFName.of('Subtype'))?.toString()==='/Image'&&o.dict.get(PDFName.of('ColorSpace'))?.toString()==='/DeviceRGB');
  assert.equal(ordinaryImage.dict.get(PDFName.of('Width')).asNumber(),900);assert.equal(ordinaryImage.dict.get(PDFName.of('Height')).asNumber(),1500);
  assert.deepEqual(Buffer.from(decodePDFRawStream(ordinaryImage).decode()),await sharp(source).removeAlpha().raw().toBuffer());
  const checked=await f.request(endpoint+'/export-image-check','POST',request);assert.equal(checked.status,200);const report=await checked.json();
  assert.equal(report.canExport,true);assert.equal(report.errors,0);assert.equal(report.profile,null);assert.equal(report.settings.printReady,true);
  assert.ok(Math.abs(report.pages[0].width-216)<.001);assert.ok(Math.abs(report.pages[0].height-360)<.001);
  const exported=await f.request(endpoint+'/export-image','POST',request);assert.equal(exported.status,200);const pdf=await PDFDocument.load(await exported.arrayBuffer());
  assert.ok(Math.abs(pdf.getPage(0).getWidth()-216)<.001);assert.ok(Math.abs(pdf.getPage(0).getHeight()-360)<.001);
  const embedded=pdf.context.enumerateIndirectObjects().map(([,o])=>o).find(o=>o instanceof PDFRawStream&&o.dict.get(PDFName.of('Subtype'))?.toString()==='/Image'&&o.dict.get(PDFName.of('ColorSpace'))?.toString()==='/DeviceRGB');
  assert.equal(embedded.dict.get(PDFName.of('Width')).asNumber(),900);assert.equal(embedded.dict.get(PDFName.of('Height')).asNumber(),1500);
  assert.deepEqual(Buffer.from(decodePDFRawStream(embedded).decode()),await sharp(source).removeAlpha().raw().toBuffer(),'print RGB pixels must match the native source');
  const enlarged={...request,width:304.8,height:508,unit:'mm',acknowledgeWarnings:true};
  const blocked=await(await f.request(endpoint+'/export-image-check','POST',enlarged)).json();assert.equal(blocked.canExport,false);assert.ok(blocked.issues.some(i=>i.code==='low_resolution'&&i.severity==='error'&&i.message.includes('3600 × 6000')));
  assert.equal((await f.request(endpoint+'/export-image','POST',enlarged)).status,422,'acknowledging warnings cannot bypass missing print detail');
  const fullRecord=f.documents.createFromDocument(other.id,{schemaVersion:1,title:'打印原稿',pages:[{id:'native-page',name:'原图',width:76.2,height:127,unit:'mm',background:'#ffffff',objects:[{id:'photo',type:'image',assetId:image.id,x:0,y:0,width:76.2,height:127,fit:'contain'}]}]});
  const designCheck=await(await f.request(endpoint+'/export-check','POST',{revision:fullRecord.revision,format:'pdf',printReady:true,dpi:300})).json();assert.equal(designCheck.canExport,true,'editable designs must also use native print assets');
  const ordinaryDesign=await f.request(endpoint+'/export','POST',{revision:fullRecord.revision,format:'pdf',colorSpace:'rgb'});
  assert.equal(ordinaryDesign.status,200);const designPdf=await PDFDocument.load(await ordinaryDesign.arrayBuffer());
  const designImage=designPdf.context.enumerateIndirectObjects().map(([,o])=>o).find(o=>o instanceof PDFRawStream&&o.dict.get(PDFName.of('Subtype'))?.toString()==='/Image'&&o.dict.get(PDFName.of('ColorSpace'))?.toString()==='/DeviceRGB');
  assert.equal(designImage.dict.get(PDFName.of('Width')).asNumber(),900);assert.equal(designImage.dict.get(PDFName.of('Height')).asNumber(),1500);
  assert.equal(JSON.stringify(other),before);assert.equal(f.documents.require(other.id).revision,1);
});

test('print-ready auto sizing detects the native limit of an upscaled working image',async t=>{
  const f=await fixture(t),other=f.store.create(),source=await sharp({create:{width:60,height:100,channels:3,background:'#652a17'}}).png().toBuffer(),working=await sharp(source).resize(600,1000).png().toBuffer();
  const image=f.store.addImage(other,working,{kind:'generated',demo:false,width:600,height:1000,adaptation:{method:'resize',sourceWidth:60,sourceHeight:100,upscaled:true,background:'#ffffff'}},{originalBytes:source});
  const endpoint=`/api/sessions/${other.id}/design`,body={imageId:image.id,format:'pdf',printReady:true,dpi:300};
  const ordinary=await f.request(endpoint+'/export-image','POST',{imageId:image.id,format:'pdf'});
  assert.equal(ordinary.status,200);const ordinaryPdf=await PDFDocument.load(await ordinary.arrayBuffer());
  const ordinaryImage=ordinaryPdf.context.enumerateIndirectObjects().map(([,o])=>o).find(o=>o instanceof PDFRawStream&&o.dict.get(PDFName.of('Subtype'))?.toString()==='/Image'&&o.dict.get(PDFName.of('ColorSpace'))?.toString()==='/DeviceRGB');
  assert.equal(ordinaryImage.dict.get(PDFName.of('Width')).asNumber(),600);assert.equal(ordinaryImage.dict.get(PDFName.of('Height')).asNumber(),1000);
  const report=await(await f.request(endpoint+'/export-image-check','POST',body)).json();assert.equal(report.canExport,true);assert.ok(Math.abs(report.pages[0].width-14.4)<.001);
  const enlarged=await(await f.request(endpoint+'/export-image-check','POST',{...body,width:50.8,height:254/3,unit:'mm'})).json();assert.equal(enlarged.canExport,false);assert.ok(enlarged.issues.some(i=>i.code==='low_resolution'));
  assert.equal((await f.request(endpoint+'/export-image-check','POST',{...body,format:'png'})).status,400);
  assert.equal((await f.request(endpoint+'/export-image-check','POST',{...body,vectorize:true})).status,400);
});
