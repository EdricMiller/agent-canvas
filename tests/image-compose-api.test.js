import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {PDFDocument,PDFName,PDFRawStream,decodePDFRawStream} from 'pdf-lib';
import {createApp} from '../server/app.js';
import {Store} from '../server/store.js';
import {composeRaster} from '../server/image-compose.js';

const root=path.resolve(import.meta.dirname,'..');
async function fixture(t){
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'canvas-compose-api-'));
  const instance=createApp({root,dataDir,demo:true,agentModel:'test',imageModel:'test',sandboxMode:'off'});
  const server=await new Promise((resolve,reject)=>{const s=instance.app.listen(0,'127.0.0.1');s.once('listening',()=>resolve(s));s.once('error',reject);});
  t.after(()=>{instance.shutdown();server.closeAllConnections();server.close();fs.rmSync(dataDir,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}`,config=await(await fetch(base+'/api/config')).json();
  const request=(url,body,token=config.token)=>fetch(base+url,{method:'POST',headers:{'Content-Type':'application/json','X-Studio-Token':token},body:JSON.stringify(body)});
  const session=instance.store.create(),working=await sharp({create:{width:120,height:160,channels:3,background:'#f3e8cf'}}).png().toBuffer();
  const native=await sharp(working).resize(240,320).png().toBuffer();
  const logo=await sharp(Buffer.from('<svg width="48" height="48"><rect x="4" y="4" width="40" height="40" fill="#b32327"/><circle cx="24" cy="24" r="7" fill="white"/></svg>')).png().toBuffer();
  const source=instance.store.addImage(session,working,{kind:'generated',demo:false,width:120,height:160,adaptation:{method:'resize',sourceWidth:240,sourceHeight:320,upscaled:false}},{originalBytes:native});
  const upload=await request(`/api/sessions/${session.id}/upload`,{data:`data:image/png;base64,${logo.toString('base64')}`,name:'品牌.png',purpose:'asset'});
  assert.equal(upload.status,201);const mark=(await upload.json()).version;
  const options={sourceId:source.id,logoId:mark.id,placement:{x:.1,y:.15,width:.3,height:.25,fit:'contain',opacity:.6},label:'组合稿'};
  return {...instance,base,request,session,source,mark,options,working,native,logo,dataDir};
}
const pixels=bytes=>sharp(bytes).ensureAlpha().raw().toBuffer();

test('manual composition saves a separate version and exports exact PNG and native RGB PDF without a model',async t=>{
  const f=await fixture(t),s=f.session,references=[...s.referenceIds];
  const res=await f.request(`/api/sessions/${s.id}/compose`,f.options);assert.equal(res.status,201);
  const {version,session}=await res.json();assert.equal(session.selectedId,version.id);assert.equal(s.job,null);assert.equal(s.messages.length,0);
  assert.equal(s.versions.length,3);assert.deepEqual(s.referenceIds,references);assert.equal(version.parentId,f.source.id);
  assert.deepEqual(f.store.image(s,f.source.id).bytes,f.working);assert.deepEqual(f.store.image(s,f.mark.id).bytes,f.logo);
  const expected=await composeRaster(f.working,f.logo,f.options.placement),download=await fetch(f.base+version.url);
  assert.deepEqual(await pixels(Buffer.from(await download.arrayBuffer())),await pixels(expected.bytes));
  const exportRes=await f.request(`/api/sessions/${s.id}/design/export-image`,{imageId:version.id,format:'png',colorSpace:'rgb',scale:1});
  assert.equal(exportRes.status,200);assert.deepEqual(await pixels(Buffer.from(await exportRes.arrayBuffer())),await pixels(expected.bytes));
  const pdfRes=await f.request(`/api/sessions/${s.id}/design/export-image`,{imageId:version.id,format:'pdf',colorSpace:'rgb',printReady:true,dpi:300});assert.equal(pdfRes.status,200);
  const pdf=await PDFDocument.load(await pdfRes.arrayBuffer()),image=pdf.context.enumerateIndirectObjects().map(([,o])=>o).find(o=>o instanceof PDFRawStream&&o.dict.get(PDFName.of('Subtype'))?.toString()==='/Image'&&o.dict.get(PDFName.of('ColorSpace'))?.toString()==='/DeviceRGB');
  assert.ok(image);assert.equal(image.dict.get(PDFName.of('Width')).asNumber(),240);assert.equal(image.dict.get(PDFName.of('Height')).asNumber(),320);
  const nativeExpected=await composeRaster(f.native,f.logo,f.options.placement);
  assert.deepEqual(Buffer.from(decodePDFRawStream(image).decode()),await sharp(nativeExpected.bytes).removeAlpha().raw().toBuffer());
  const restored=new Store(f.dataDir).get(s.id);assert.equal(restored.selectedId,version.id);assert.deepEqual(restored.versions.at(-1).composition,version.composition);
  const moved=await f.request(`/api/sessions/${s.id}/compose`,{...f.options,placement:{...f.options.placement,x:.5}});assert.equal(moved.status,201);
  assert.equal(s.versions.length,4);assert.equal(s.versions.at(-1).composition.baseId,f.source.id,'adjustments keep the original base');
});

test('composition rejects opaque and foreign assets, invalid placement, missing token, and running jobs',async t=>{
  const f=await fixture(t),s=f.session,url=`/api/sessions/${s.id}/compose`;
  const opaque=f.store.addImage(s,f.working,{kind:'upload',demo:false,width:120,height:160},{reference:false});
  const foreign=f.store.addImage(f.store.create(),f.logo,{kind:'upload',demo:false,width:48,height:48});
  for(const [options,status] of [
    [{...f.options,logoId:opaque.id},422],
    [{...f.options,logoId:foreign.id},400],
    [{...f.options,sourceId:foreign.id},400],
    [{...f.options,logoId:f.source.id},400],
    [{...f.options,placement:{...f.options.placement,x:.9}},400],
    [{...f.options,placement:{...f.options.placement,opacity:2}},400],
    [{...f.options,unexpected:true},400],
  ]){assert.equal((await f.request(url,options)).status,status);}
  assert.equal((await f.request(url,f.options,'invalid')).status,403);
  s.job={status:'running'};assert.equal((await f.request(url,f.options)).status,409);s.job=null;
  assert.equal(s.versions.length,3);assert.equal((await f.request(url,f.options)).status,201,'failed requests release the composition lock');
});
