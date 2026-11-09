import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {Store} from '../server/store.js';
import {runAgent,createLiveRuntime} from '../server/agent.js';
import {createApp} from '../server/app.js';
import {ModelSettings} from '../server/model-settings.js';
import {mockDesignRuntime} from './helpers/design-agent.mjs';

const root=path.resolve(import.meta.dirname,'..'),model='gpt-image-2.5-sunburst';
const target={mode:'ratio',width:13,height:24,fit:'contain',background:'#ffffff'},settings={quality:'max',resolution:'4k'};
const config=dataDir=>({root,dataDir,demo:true,apiKey:'fixture-conversation',baseURL:'https://ffka.example.invalid/v1',imageApiKey:'fixture-old-provider',imageBaseURL:'https://images.example.invalid/v1',agentModel:'test',imageModel:model,maxImages:1,maxTurns:8,sandboxMode:'off'});
function temporary(t){const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'canvas-image-generation-'));t.after(()=>fs.rmSync(dataDir,{recursive:true,force:true}));return dataDir;}

test('real SDK passes native size and quality to ffka generations and multipart edits; dialogue-only settings incur no image calls',async t=>{
  const dataDir=temporary(t),registry=new ModelSettings(config(dataDir));
  const prepared=registry.prepareModel({providerId:'conversation',model,kind:'image',name:'ffka image'});registry.save(prepared.data);
  registry.save(registry.prepareRoutes({...registry.data.routes,image:prepared.id}));
  const c={...config(dataDir),...registry.runtimeConfig()},store=new Store(dataDir),session=store.create();session.skillId=null;
  const requests=[],raw=await sharp({create:{width:2080,height:3840,channels:3,background:'#50756a'}}).png().toBuffer();
  t.mock.method(globalThis,'fetch',async(url,init)=>{
    const u=new URL(url);assert.equal(u.hostname,'ffka.example.invalid');assert.ok(init.signal);
    assert.equal(new Headers(init.headers).get('authorization'),'Bearer fixture-conversation');
    const body=typeof init.body==='string'?JSON.parse(init.body):init.body,get=key=>body instanceof FormData?body.get(key):body[key];
    assert.equal(get('size'),'2080x3840');assert.equal(get('quality'),'max');assert.equal(get('model'),model);assert.equal(Number(get('n')),1);
    if(u.pathname.endsWith('/edits'))assert.ok(body.get('image') instanceof File);
    requests.push(u.pathname);return new Response(JSON.stringify({data:[{b64_json:raw.toString('base64')}]}),{headers:{'Content-Type':'application/json'}});
  });
  const runtime=createLiveRuntime(c);
  async function turn(actions){const mock=mockDesignRuntime((_body,index)=>actions[index]);return runAgent({session,skill:null,skills:null,store,config:c,runtime:{...runtime,runner:mock.runtime.runner},emit:()=>{},signal:new AbortController().signal,prompt:'用户要求',job:{}});}
  await turn([{name:'set_image_target',arguments:{target}},{name:'set_image_generation',arguments:{settings}},'后续按13:24、4K、最高精细度制作，先不生成。']);
  assert.equal(requests.length,0);assert.deepEqual(new Store(dataDir).get(session.id).imageGeneration,settings);
  await turn([{name:'render_image',arguments:{prompt:'产品广告',sourceId:null,label:'高清广告'}},'已完成']);
  const first=session.versions.at(-1);assert.equal(first.generation.size,'2080x3840');assert.equal(first.generation.sourceWidth,2080);assert.equal(first.adaptation.method,'native');
  await turn([{name:'render_image',arguments:{prompt:'改成蓝色',sourceId:first.id,label:'高清修改'}},'已完成']);
  assert.deepEqual(requests,['/v1/images/generations','/v1/images/edits']);assert.deepEqual(session.versions.at(-1).imageGeneration,settings);
});

test('settings API persists atomically, enforces busy/validation guards, and restores history without blocking old models',async t=>{
  const dataDir=temporary(t),instance=createApp(config(dataDir)),server=await new Promise((resolve,reject)=>{const s=instance.app.listen(0,'127.0.0.1');s.once('listening',()=>resolve(s));s.once('error',reject);});
  t.after(()=>{instance.shutdown();server.closeAllConnections();server.close();});
  const base=`http://127.0.0.1:${server.address().port}`,token=(await(await fetch(base+'/api/config')).json()).token,s=instance.store.create(),url=base+'/api/sessions/'+s.id;
  async function patch(body){const r=await fetch(url,{method:'PATCH',headers:{'Content-Type':'application/json','X-Studio-Token':token},body:JSON.stringify(body)});return {status:r.status,data:await r.json()};}
  assert.equal((await patch({imageTarget:target,imageGeneration:settings})).status,200);assert.deepEqual(new Store(dataDir).get(s.id).imageGeneration,settings);
  for(const body of [{imageGeneration:{quality:'max',resolution:'8k'}},{imageTarget:null,imageGeneration:settings},{imageTarget:{...target,width:0},imageGeneration:{quality:'low',resolution:'auto'}}]){
    assert.equal((await patch(body)).status,400);assert.deepEqual(s.imageGeneration,settings);assert.deepEqual(s.imageTarget,target);
  }
  s.job={status:'running'};assert.equal((await patch({imageGeneration:{quality:'low',resolution:'auto'}})).status,409);s.job=null;
  const bytes=await sharp({create:{width:16,height:16,channels:3,background:'#abc'}}).png().toBuffer();
  const high=instance.store.addImage(s,bytes,{kind:'generated',imageTarget:target,imageGeneration:settings}),legacy=instance.store.addImage(s,bytes,{kind:'generated'});
  assert.equal((await patch({selectedId:legacy.id})).status,200);assert.deepEqual(s.imageGeneration,{quality:'high',resolution:'auto'});assert.equal(s.imageTarget,null);
  assert.equal((await patch({selectedId:high.id})).status,200);assert.deepEqual(s.imageGeneration,settings);
  assert.equal((await patch({imageTarget:null})).status,200);assert.equal(s.imageTarget,null);assert.equal(s.imageGeneration.resolution,'auto');
});

test('provider rejection preserves settings and cannot trigger hidden retries or quality downgrades',async t=>{
  const dataDir=temporary(t),store=new Store(dataDir),session=store.create(),events=[],job={},c=config(dataDir);
  session.skillId=null;session.imageTarget=target;session.imageGeneration=settings;
  const render={name:'render_image',arguments:{prompt:'产品广告',sourceId:null,label:'高清广告'}},actions=[render,render,'接口拒绝了高清请求，本轮未生成。'];
  const mock=mockDesignRuntime((_body,index)=>actions[index]);let calls=0;
  mock.runtime.imageAdapter={async generate(_client,args){calls++;assert.equal(args.quality,'max');assert.equal(args.size,'2080x3840');throw Object.assign(new Error('unsupported size'),{status:400});},async edit(){assert.fail('unexpected edit');}};
  await runAgent({session,skill:null,skills:null,store,config:c,runtime:mock.runtime,emit:(type,data)=>events.push({type,...data}),signal:new AbortController().signal,prompt:'制作高清产品广告',job});
  assert.equal(calls,1);assert.equal(session.versions.length,0);assert.deepEqual(session.imageGeneration,settings);assert.equal(job.imageCalls,1);
  assert.ok(events.some(e=>e.type==='tool_error'&&e.text.includes('不自动降低质量')));
});
