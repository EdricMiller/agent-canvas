import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {Store} from '../server/store.js';
import {runAgent} from '../server/agent.js';
import {createApp} from '../server/app.js';
import {mockDesignRuntime} from './helpers/design-agent.mjs';

const root=path.resolve(import.meta.dirname,'..');
const target={mode:'pixels',width:585,height:1080,fit:'contain',background:'#ffffff'};
function tempStore(t){const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'canvas-image-target-'));t.after(()=>fs.rmSync(dataDir,{recursive:true,force:true}));return {dataDir,store:new Store(dataDir)};}

test('real SDK records conversational dimensions without generating, then applies them to generation and edits',async t=>{
  const {dataDir,store}=tempStore(t),session=store.create(),events=[],calls=[];
  session.skillId=null;
  const raw=await sharp({create:{width:100,height:100,channels:3,background:'#cc7044'}}).png().toBuffer();
  async function turn(prompt,actions){
    const mock=mockDesignRuntime((body,index)=>{assert.ok(body.tools.some(tool=>tool.name==='set_image_target'));return actions[index];});
    mock.runtime.imageAdapter={
      async generate(_client,args){calls.push({kind:'generate',args});return {data:[{b64_json:raw.toString('base64')}]};},
      async edit(_client,args,bytes){calls.push({kind:'edit',args,bytes});return {data:[{b64_json:raw.toString('base64')}]};},
    };
    return runAgent({session,skill:null,skills:null,store,config:{agentModel:'test',imageModel:'test',maxImages:1,maxTurns:6},runtime:mock.runtime,emit:(event,data)=>events.push({event,...data}),signal:new AbortController().signal,prompt,job:{}});
  }
  await turn('先确认：宽585，高1080像素，先不要生成。',[{name:'set_image_target',arguments:{target}},'已确认宽585、高1080像素，比例13:24。']);
  assert.equal(calls.length,0);assert.equal(session.versions.length,0);assert.deepEqual(new Store(dataDir).get(session.id).imageTarget,target);
  assert.ok(events.some(e=>e.event==='image_target'&&e.text.includes('13:24')));
  await turn('按刚才的尺寸做一张产品广告。',[{name:'render_image',arguments:{prompt:'新鲜食材产品广告',sourceId:null,label:'广告初稿'}},'已完成。']);
  const first=session.versions.at(-1);
  assert.deepEqual([first.width,first.height],[585,1080]);assert.deepEqual(first.imageTarget,target);assert.equal(first.adaptation.method,'contain');
  assert.match(calls[0].args.prompt,/宽 585 × 高 1080 px/);assert.match(calls[0].args.prompt,/13:24/);assert.equal(calls[0].args.size,'auto');
  assert.deepEqual(fs.readFileSync(path.join(store.imagesDir,`${first.id}-source.png`)),raw);
  const output=await sharp(store.image(session,first.id).bytes).metadata();assert.deepEqual([output.width,output.height],[585,1080]);
  await turn('产品和尺寸保留，把背景改成蓝色。',[{name:'render_image',arguments:{prompt:'背景改成蓝色',sourceId:first.id,label:'蓝色版本'}},'已完成。']);
  assert.equal(calls[1].kind,'edit');assert.deepEqual([session.versions.at(-1).width,session.versions.at(-1).height],[585,1080]);assert.deepEqual(calls[1].bytes,store.image(session,first.id).bytes);
  const ratio={...target,mode:'ratio',width:13,height:24};
  await turn('只固定13:24比例，像素等比例即可。',[{name:'set_image_target',arguments:{target:ratio}},'已调整为比例模式。']);
  await turn('重新生成一张。',[{name:'render_image',arguments:{prompt:'新广告',sourceId:null,label:'比例版本'}},'已完成。']);
  assert.deepEqual([session.versions.at(-1).width,session.versions.at(-1).height],[832,1536]);
  await turn('取消固定尺寸。',[{name:'set_image_target',arguments:{target:null}},'已取消。']);assert.equal(session.imageTarget,null);
  await turn('自由比例做一张。',[{name:'render_image',arguments:{prompt:'自由广告',sourceId:null,label:'自由版本'}},'已完成。']);
  assert.equal(session.versions.at(-1).imageTarget,null);assert.deepEqual([session.versions.at(-1).width,session.versions.at(-1).height],[100,100]);assert.equal(calls.length,4,'no hidden retries or extra image calls');
});

async function apiFixture(t){
  const {dataDir}=tempStore(t),instance=createApp({root,dataDir,demo:true,maxImages:1,agentModel:'test',imageModel:'test'});
  const server=await new Promise((resolve,reject)=>{const s=instance.app.listen(0,'127.0.0.1');s.once('listening',()=>resolve(s));s.once('error',reject);});
  t.after(()=>{instance.shutdown();server.closeAllConnections();server.close();});
  const base=`http://127.0.0.1:${server.address().port}`,config=await(await fetch(base+'/api/config')).json();
  const req=async(url,body)=>{const res=await fetch(base+url,{method:body===undefined?'GET':'PATCH',headers:{'Content-Type':'application/json','X-Studio-Token':config.token},...(body!==undefined?{body:JSON.stringify(body)}:{})});return {status:res.status,data:await res.json()};};
  return {...instance,base,req,token:config.token,dataDir};
}

test('session targets persist, reject invalid or busy writes, and restore the chosen version target',async t=>{
  const f=await apiFixture(t),s=f.store.create(),other=f.store.create(),url=`/api/sessions/${s.id}`;
  assert.equal((await f.req(url,{imageTarget:target})).status,200);assert.deepEqual(new Store(f.dataDir).get(s.id).imageTarget,target);assert.equal(other.imageTarget,null);
  for(const patch of [{width:8193},{width:8192,height:8192},{mode:'ratio',width:1,height:8192},{fit:'fill'},{unknown:true}]){
    assert.equal((await f.req(url,{imageTarget:{...target,...patch}})).status,400);assert.deepEqual(s.imageTarget,target);
  }
  s.job={status:'running'};assert.equal((await f.req(url,{imageTarget:null})).status,409);assert.deepEqual(s.imageTarget,target);s.job=null;
  const bytes=await sharp({create:{width:16,height:16,channels:3,background:'#aaa'}}).png().toBuffer();
  const first=f.store.addImage(s,bytes,{kind:'generated',imageTarget:target,width:16,height:16,demo:false});
  const ratio={...target,mode:'ratio',width:16,height:9},second=f.store.addImage(s,bytes,{kind:'generated',imageTarget:ratio,width:16,height:16,demo:false});
  const upload=f.store.addImage(s,bytes,{kind:'upload',demo:false});
  await f.req(url,{selectedId:second.id});assert.deepEqual(s.imageTarget,ratio);
  await f.req(url,{selectedId:upload.id});assert.deepEqual(s.imageTarget,ratio,'uploads do not replace the confirmed target');
  await f.req(url,{selectedId:first.id});assert.deepEqual(s.imageTarget,target);
  await f.req(url,{selectedId:second.id,imageTarget:null});assert.equal(s.imageTarget,null,'explicit target overrides version restoration');
  const legacy=f.store.addImage(s,bytes,{kind:'generated',demo:false});
  await f.req(url,{imageTarget:target});await f.req(url,{selectedId:legacy.id});assert.equal(s.imageTarget,null,'legacy versions retain free dimensions');
  const foreign=f.store.addImage(other,bytes,{kind:'generated',demo:false});assert.equal((await f.req(url,{selectedId:foreign.id})).status,400);assert.equal(s.imageTarget,null);
});

test('demo output and its original download honor manually confirmed dimensions without claiming AI understanding',async t=>{
  const f=await apiFixture(t),s=f.store.create(),url=`/api/sessions/${s.id}`;
  await f.req(url,{imageTarget:target});
  const res=await fetch(f.base+url+'/turns',{method:'POST',headers:{'Content-Type':'application/json','X-Studio-Token':f.token},body:JSON.stringify({text:'本地演示',requestId:randomUUID()})});assert.equal(res.status,202);
  for(let i=0;i<80&&s.job.status==='running';i++)await new Promise(r=>setTimeout(r,30));
  assert.equal(s.job.status,'completed');assert.match(s.messages.at(-1).text,/没有 AI 理解/);
  const version=s.versions.at(-1),download=await fetch(f.base+version.url),meta=await sharp(Buffer.from(await download.arrayBuffer())).metadata();
  assert.deepEqual([meta.width,meta.height],[585,1080]);assert.deepEqual(version.imageTarget,target);
  const original=await fetch(f.base+version.sourceUrl),raw=await sharp(Buffer.from(await original.arrayBuffer())).metadata();assert.deepEqual([raw.width,raw.height],[1080,1440]);assert.equal(s.versions.length,1,'raw model/source image is not a separate output version');
});
