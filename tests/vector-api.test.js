import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createApp} from '../server/app.js';
import {vectorFixture,vectorAssetId} from './helpers/vector.mjs';

const root=path.resolve(import.meta.dirname,'..');
async function fixture(t){
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'canvas-vector-api-')),instance=createApp({root,dataDir,demo:true,agentModel:'test',imageModel:'test',sandboxMode:'off'});
  const server=await new Promise((resolve,reject)=>{const s=instance.app.listen(0,'127.0.0.1');s.once('listening',()=>resolve(s));s.once('error',reject);});
  t.after(()=>{instance.shutdown();server.closeAllConnections();server.close();fs.rmSync(dataDir,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}`,config=await(await fetch(base+'/api/config')).json(),session=instance.store.create();
  const request=(url,body,token=config.token)=>fetch(base+url,{method:'POST',headers:{'Content-Type':'application/json','X-Studio-Token':token},body:JSON.stringify(body)});
  const f=await vectorFixture(),image=instance.store.addImage(session,f.bytes,{kind:'generated',demo:false,width:200,height:160});
  f.document.pages[0].objects.find(o=>o.assetId===vectorAssetId).assetId=image.id;
  const record=instance.documents.createFromDocument(session.id,f.document);
  return {...instance,session,request,record,image,url:`/api/sessions/${session.id}/design`};
}

test('SVG, EPS, AI and vector PDF export through authenticated routes with matching revision and filenames',async t=>{
  const f=await fixture(t),before=JSON.stringify(f.documents.require(f.session.id)),body={revision:f.record.revision,pageId:f.record.document.pages[0].id,format:'svg'};
  assert.equal((await f.request(f.url+'/export',body,'')).status,403);
  assert.equal((await f.request(f.url+'/export',{...body,revision:99})).status,409);
  const checked=await f.request(f.url+'/export-check',body);assert.equal(checked.status,200);const report=await checked.json();assert.ok(report.vector.pathCount>4);assert.equal(report.vector.approximate,true);
  assert.equal((await f.request(f.url+'/export',body)).status,422,'vector download must require explicit preview acknowledgment');
  const proof=await f.request(f.url+'/export-preview',body);assert.equal(proof.status,200);assert.match((await proof.json()).dataUrl,/^data:image\/png;base64,/);
  for(const [format,mime] of [['svg','image/svg+xml'],['eps','application/postscript'],['ai','application/postscript'],['pdf','application/pdf']]){
    const response=await f.request(f.url+'/export',{...body,format,...(format==='pdf'?{vectorize:true}:{}),acknowledgeWarnings:true});assert.equal(response.status,200,await response.clone().text());
    assert.equal(response.headers.get('content-type').split(';')[0],mime);assert.match(response.headers.get('content-disposition'),new RegExp('\\.'+format));assert.ok(Number(response.headers.get('x-design-vector-paths'))>4);
    const bytes=Buffer.from(await response.arrayBuffer());if(format==='svg')assert.doesNotMatch(bytes.toString(),/<image|base64/);else assert.match(bytes.toString('ascii',0,30),format==='pdf'?/^%PDF/:/^%!PS-Adobe/);
  }
  assert.equal(JSON.stringify(f.documents.require(f.session.id)),before,'export must not mutate the design, revision or versions');
});

test('raw images also support traced exports; foreign assets, invalid combinations and multipage vector PDF are rejected',async t=>{
  const f=await fixture(t),body={imageId:f.image.id,format:'svg',acknowledgeWarnings:true};
  assert.equal((await f.request(f.url+'/export-image-check',body)).status,200);
  assert.equal((await f.request(f.url+'/export-image-preview',body)).status,200);
  assert.equal((await f.request(f.url+'/export-image',body)).status,200);
  assert.equal((await f.request(f.url+'/export-image',{...body,imageId:vectorAssetId})).status,404);
  for(const change of [{format:'webp'},{dpi:300},{scale:2},{colorSpace:'cmyk'},{vectorize:true},{print:{}}])assert.equal((await f.request(f.url+'/export-image',{...body,...change})).status,400);
  const doc=structuredClone(f.record.document);doc.pages.push({...doc.pages[0],id:'second',objects:[]});const updated=f.documents.update(f.session.id,doc,f.record.revision);
  assert.equal((await f.request(f.url+'/export',{revision:updated.revision,format:'pdf',vectorize:true,acknowledgeWarnings:true})).status,400);
  assert.equal((await f.request(f.url+'/export',{revision:updated.revision,format:'pdf',vectorize:true,pageId:doc.pages[0].id,acknowledgeWarnings:true})).status,200);
});
