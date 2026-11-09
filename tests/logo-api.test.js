import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {createApp} from '../server/app.js';
import {assertTransparentImage} from '../server/image-output.js';

const root=path.resolve(import.meta.dirname,'..');
async function fixture(t){
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'canvas-logo-api-'));
  const instance=createApp({root,dataDir,demo:true,agentModel:'test',imageModel:'test',sandboxMode:'off'});
  const server=await new Promise((resolve,reject)=>{const s=instance.app.listen(0,'127.0.0.1');s.once('listening',()=>resolve(s));s.once('error',reject);});
  t.after(()=>{instance.shutdown();server.closeAllConnections();server.close();fs.rmSync(dataDir,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}`,config=await(await fetch(base+'/api/config')).json(),session=instance.store.create();
  const request=(url,method='GET',body,token=config.token)=>fetch(base+url,{method,headers:{'Content-Type':'application/json','X-Studio-Token':token},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {...instance,session,request,url:`/api/sessions/${session.id}/design`};
}

test('transparent canvas API round trips, versions and PNG/JPG downloads keep the intended background',async t=>{
  const f=await fixture(t),skills=await(await f.request('/api/skills')).json();
  assert.ok(skills.some(s=>s.workflow==='logo-design'&&s.name==='品牌 Logo'));
  const created=await f.request(f.url,'POST',{title:'透明Logo',width:300,height:200,unit:'px',background:'transparent'});assert.equal(created.status,201);
  const document=(await created.json()).design.document;
  document.pages[0].objects=[{id:'shape',type:'rect',x:40,y:40,width:80,height:80,fill:'#ffffff'}];
  assert.equal((await f.request(f.url,'PUT',{revision:1,document},'')).status,403);
  assert.equal((await f.request(f.url,'PUT',{revision:1,document})).status,200);
  const snapshot=await(await f.request(f.url+'/versions','POST',{revision:2,label:'透明版本'})).json();
  const png=await f.request(f.url+'/export','POST',{revision:3,pageId:document.pages[0].id,format:'png'});assert.equal(png.status,200);
  await assertTransparentImage(Buffer.from(await png.arrayBuffer()));
  const jpg=await f.request(f.url+'/export','POST',{revision:3,pageId:document.pages[0].id,format:'jpeg'});assert.equal(jpg.status,200);
  const {data}=await sharp(Buffer.from(await jpg.arrayBuffer())).raw().toBuffer({resolveWithObject:true});assert.deepEqual([...data.subarray(0,3)],[255,255,255]);
  document.pages[0].background='#123456';assert.equal((await f.request(f.url,'PUT',{revision:3,document})).status,200);
  const restored=await(await f.request(f.url+'/restore','POST',{revision:4,versionId:snapshot.design.versions[0].id})).json();
  assert.equal(restored.design.document.pages[0].background,'transparent');
  document.pages[0].background='rgba(0,0,0,0)';assert.equal((await f.request(f.url,'PUT',{revision:5,document})).status,400);
});

test('raw transparent images retain alpha when resized and exported to PNG, JPEG uses white',async t=>{
  const f=await fixture(t),bytes=await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><circle cx="50" cy="50" r="20" fill="white"/></svg>')).png().toBuffer();
  const image=f.store.addImage(f.session,bytes,{kind:'generated',demo:false,width:100,height:100});
  const png=await f.request(f.url+'/export-image','POST',{imageId:image.id,format:'png',scale:2});assert.equal(png.status,200);
  await assertTransparentImage(Buffer.from(await png.arrayBuffer()));
  const jpg=await f.request(f.url+'/export-image','POST',{imageId:image.id,format:'jpeg'});assert.equal(jpg.status,200);
  const {data}=await sharp(Buffer.from(await jpg.arrayBuffer())).raw().toBuffer({resolveWithObject:true});assert.deepEqual([...data.subarray(0,3)],[255,255,255]);
});
