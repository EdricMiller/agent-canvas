import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {createApp} from '../server/app.js';
import {mockDesignRuntime,boundDesign} from './helpers/design-agent.mjs';
import {Store} from '../server/store.js';
import {DocumentStore} from '../server/design/store.js';

const root=path.resolve(import.meta.dirname,'..');
async function fixture(t,plan,{demo=false}={}){
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'canvas-design-turn-')),mock=mockDesignRuntime(plan);
  const instance=createApp({root,dataDir,demo,apiKey:'fixture-only',agentModel:'test',imageModel:'test',maxTurns:8,sandboxMode:'off'},{runtime:mock.runtime});
  const server=await new Promise((resolve,reject)=>{const s=instance.app.listen(0,'127.0.0.1');s.once('listening',()=>resolve(s));s.once('error',reject);});
  t.after(()=>{instance.shutdown();server.closeAllConnections();server.close();fs.rmSync(dataDir,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}`,config=await(await fetch(base+'/api/config')).json(),session=instance.store.create();
  const request=async(body,token=config.token)=>fetch(`${base}/api/sessions/${session.id}/turns`,{method:'POST',headers:{'Content-Type':'application/json','X-Studio-Token':token},body:JSON.stringify(body)});
  return {...instance,session,request,mock};
}
const canvas={title:'通用设计',width:180,height:240,unit:'mm',background:'#ffffff'};
test('design turns attach exact references, persist real document snapshots, and remain idempotent',async t=>{
  let document;
  const f=await fixture(t,(_body,index)=>index===0?{name:'create_design_document',arguments:{document,label:'AI 初稿'}}:'可编辑稿已生成。');
  const bytes=await sharp({create:{width:200,height:200,channels:3,background:'#abc'}}).png().toBuffer();
  const first=f.store.addImage(f.session,bytes,{kind:'upload',demo:false,label:'明细'}),logo=f.store.addImage(f.session,bytes,{kind:'upload',demo:false,label:'Logo'}),unsent=f.store.addImage(f.session,bytes,{kind:'upload',demo:false,label:'下一轮素材'});
  document=boundDesign({sourceId:first.id,logoId:logo.id});
  const body={text:'结合两张参考图生成可编辑设计',requestId:randomUUID(),design:{revision:null,canvas,referenceIds:[first.id,logo.id]}};
  assert.equal((await f.request(body,'')).status,403);
  assert.equal((await f.request(body)).status,202);
  for(let n=0;n<200&&f.session.job.status==='running';n++)await new Promise(r=>setTimeout(r,10));
  assert.equal(f.session.job.status,'completed');assert.equal(f.session.job.outputMode,'design');assert.equal(f.session.job.designResult.objectCount,3);
  assert.deepEqual(f.session.messages[0].referenceIds,[first.id,logo.id]);assert.deepEqual(f.session.referenceIds,[unsent.id]);
  assert.equal(f.session.messages.at(-1).task.designResult.revision,1);assert.equal(f.documents.require(f.session.id).versions.length,1);
  assert.equal(f.session.versions.length,3);assert.equal(f.mock.requests[0].input.at(-1).content.filter(c=>c.type==='input_image').length,2);
  const count=f.session.messages.length,requests=f.mock.requests.length;
  assert.equal((await(await f.request(body)).json()).duplicate,true);assert.equal(f.mock.requests.length,requests);
  assert.equal((await f.request({...body,requestId:randomUUID()})).status,409);assert.equal(f.session.messages.length,count);
});

test('design turns reject demo mode and foreign references before accepting work',async t=>{
  const f=await fixture(t,()=>{throw new Error('should not call model');});
  const body={text:'设计海报',requestId:randomUUID(),design:{revision:null,canvas,referenceIds:[randomUUID()]}};
  assert.equal((await f.request(body)).status,400);assert.equal(f.session.messages.length,0);assert.equal(f.mock.requests.length,0);
  const demo=await fixture(t,()=>{throw new Error('should not call model');},{demo:true});
  assert.equal((await demo.request({...body,design:{...body.design,referenceIds:[]}})).status,503);assert.equal(demo.session.messages.length,0);
});

test('restart interrupts AI design work while preserving the draft and design versions',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'canvas-design-restart-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const store=new Store(dir),documents=new DocumentStore(dir),session=store.create();
  const record=documents.commit(session.id,boundDesign(),null,'已保存的 AI 稿');
  session.job={id:randomUUID(),status:'running',outputMode:'design',usage:[]};store.save(session);
  const restored=new Store(dir).get(session.id);assert.equal(restored.job.status,'interrupted');assert.match(restored.job.error,/已有设计稿/);
  assert.deepEqual(documents.require(session.id),record);assert.equal(restored.versions.length,0);
});
