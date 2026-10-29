import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {ModelSettings} from '../server/model-settings.js';
import {createApp} from '../server/app.js';

const root=path.resolve(import.meta.dirname,'..');
function fixtureConfig(t) {
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'canvas-models-'));
  t.after(()=>fs.rmSync(dataDir,{recursive:true,force:true}));
  return {root,dataDir,demo:false,apiKey:'chat-fixture-secret',baseURL:'https://chat.example.invalid/v1',imageApiKey:'image-fixture-secret',imageBaseURL:'https://images.example.invalid/v1',agentModel:'chat-original',imageModel:'image-original',sandboxMode:'off'};
}
function assertPrivate(value) {
  const text=JSON.stringify(value);
  for(const secret of ['chat-fixture-secret','image-fixture-secret','other-fixture-secret'])assert.ok(!text.includes(secret));
  assert.ok(!text.includes('"apiKey"'));
}
test('model registry keeps providers, models and routes separate and persists private credentials',t=>{
  const config=fixtureConfig(t),settings=new ModelSettings(config);
  assert.equal(fs.existsSync(settings.file),false,'reading defaults does not write credentials');
  assert.equal(settings.publicState().providers.length,2);assertPrivate(settings.publicState());
  const added=settings.prepareProvider({name:'New relay',baseURL:'https://other.example.invalid/v1/',adapter:'openai-chat-completions',apiKey:'other-fixture-secret'});
  settings.save(added.data);
  const model=settings.prepareModel({providerId:added.id,model:'chat-next',kind:'conversation',name:'Next chat'});settings.save(model.data);
  const imageRoute=settings.data.routes.image;
  settings.save(settings.prepareRoutes({conversation:model.id,image:imageRoute}));
  assert.equal(settings.runtimeConfig().baseURL,'https://other.example.invalid/v1');
  assert.equal(settings.runtimeConfig().conversationAdapter,'openai-chat-completions');
  assert.equal(settings.runtimeConfig().apiKey,'other-fixture-secret');
  assert.equal(settings.runtimeConfig().imageApiKey,'image-fixture-secret');
  const restored=new ModelSettings({...config,apiKey:'ignored-default',agentModel:'ignored-default'});
  assert.equal(restored.runtimeConfig().agentModel,'chat-next');assert.equal(restored.data.routes.image,imageRoute);
  assert.equal(fs.statSync(settings.file).mode&0o777,0o600);assertPrivate(restored.publicState());
  const edit=settings.prepareProvider({name:'Renamed',baseURL:'https://other.example.invalid/v1',adapter:'openai-chat-completions',apiKey:''},added.id);settings.save(edit.data);
  assert.equal(settings.runtimeConfig().apiKey,'other-fixture-secret');
  assert.throws(()=>settings.prepareProvider({name:'Changed',baseURL:'https://different.example.invalid/v1',adapter:'openai-responses'},added.id),/重新|密钥/);
  assert.throws(()=>settings.prepareProvider({name:'Unsafe',baseURL:'https://user:password@example.invalid/v1',adapter:'openai-responses',apiKey:'x'}),/认证信息/);
  assert.throws(()=>settings.prepareProvider({name:'Unknown',baseURL:'https://example.invalid/v1',adapter:'unknown',apiKey:'x'}),/适配器/);
  assert.throws(()=>settings.prepareRoutes({conversation:imageRoute,image:model.id}),/用途/);
  assert.throws(()=>settings.prepareModel({providerId:'missing',model:'x',kind:'image'}),/中转站不存在/);
  assert.throws(()=>settings.prepareModel({providerId:added.id,model:'x',kind:'image'},model.id),/用途/,'an active conversation cannot be converted into an image model');
  assert.equal(settings.data.models.find(item=>item.id===model.id).kind,'conversation','failed changes leave the active registry intact');
  const same=settings.prepareModel({providerId:added.id,model:'chat-next',kind:'conversation'});assert.equal(same.id,model.id,'adding the same model updates its record');
});

async function apiFixture(t,config,overrides) {
  const instance=createApp({...config},overrides);
  const server=await new Promise((resolve,reject)=>{const s=instance.app.listen(0,'127.0.0.1');s.once('listening',()=>resolve(s));s.once('error',reject);});
  t.after(()=>{instance.shutdown();server.closeAllConnections();server.close();});
  const base=`http://127.0.0.1:${server.address().port}`,initial=await(await fetch(base+'/api/config')).json();
  const req=async(url,method='GET',body,headers={})=>{const response=await fetch(base+url,{method,headers:{'Content-Type':'application/json','X-Studio-Token':initial.token,...headers},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,data:await response.json()};};
  const wait=async id=>{for(let i=0;i<100;i++){const result=await req(`/api/sessions/${id}`);if(result.data.job.status!=='running')return result.data;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('task did not finish');};
  return {...instance,req,wait};
}
test('debug API applies independent routes to the next runtime and rejects writes during a task',async t=>{
  const config=fixtureConfig(t),calls=[];let release;
  const paused=new Promise(resolve=>release=resolve);t.after(()=>release());
  const f=await apiFixture(t,config,{execute:async({config,runtime,signal})=>{
    calls.push({model:config.agentModel,imageModel:config.imageModel,chatURL:runtime.client.baseURL,imageURL:runtime.imageClient.baseURL,key:runtime.client.apiKey,imageKey:runtime.imageClient.apiKey});
    if(calls.length===1)await Promise.race([paused,new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}))]);
    return 'fixture done';
  }});
  const initial=(await f.req('/api/debug')).data;assertPrivate(initial);
  assert.equal((await f.req('/api/debug/routes','PATCH',initial.routes,{'X-Studio-Token':''})).status,403);
  const {data:session}=await f.req('/api/sessions','POST');
  await f.req(`/api/sessions/${session.id}/turns`,'POST',{text:'first task',requestId:randomUUID()});
  assert.equal((await f.req('/api/debug')).data.busy,true);
  assert.equal((await f.req('/api/debug/routes','PATCH',initial.routes)).status,409);
  assert.equal((await f.req('/api/debug/models','POST',{providerId:'conversation',model:'blocked',kind:'conversation'})).status,409);
  release();await f.wait(session.id);
  const {data:added,status}=await f.req('/api/debug/providers','POST',{name:'Other relay',baseURL:'https://other.example.invalid/v1',adapter:'openai-chat-completions',apiKey:'other-fixture-secret'});
  assert.equal(status,201);assertPrivate(added);
  const {data:model}=await f.req('/api/debug/models','POST',{providerId:added.savedProviderId,model:'chat-next',kind:'conversation'});
  const selected=await f.req('/api/debug/routes','PATCH',{...initial.routes,conversation:model.savedModelId});assert.equal(selected.status,200);assertPrivate(selected.data);
  assert.equal((await f.req('/api/debug/routes','PATCH',{conversation:initial.routes.image,image:initial.routes.image})).status,400);
  const current=(await f.req('/api/config')).data;assert.equal(current.agentModel,'chat-next');assert.equal(current.imageModel,'image-original');assertPrivate(current);
  await f.req(`/api/sessions/${session.id}/turns`,'POST',{text:'second task',requestId:randomUUID()});
  const done=await f.wait(session.id);assertPrivate(done);
  assert.deepEqual(calls[1],{model:'chat-next',imageModel:'image-original',chatURL:'https://other.example.invalid/v1',imageURL:'https://images.example.invalid/v1',key:'other-fixture-secret',imageKey:'image-fixture-secret'});
  assert.equal(done.job.providers.agent.providerName,'Other relay');assert.equal(done.messages[1].task.models.agent,'chat-original','earlier task snapshots stay unchanged');
  const restored=await apiFixture(t,config);const afterRestart=(await restored.req('/api/config')).data;
  assert.equal(afterRestart.agentModel,'chat-next');assert.equal(afterRestart.imageModel,'image-original');assertPrivate(afterRestart);
});
test('model discovery queries only the selected provider and returns a sanitized error',async t=>{
  const config=fixtureConfig(t),originalFetch=globalThis.fetch;let fail=false;
  t.mock.method(globalThis,'fetch',async(url,init)=>{
    if(new URL(url).hostname!=='images.example.invalid')return originalFetch(url,init);
    assert.equal(new URL(url).pathname,'/v1/models');assert.equal(new Headers(init.headers).get('authorization'),'Bearer image-fixture-secret');
    return new Response(JSON.stringify(fail?{error:{message:'image-fixture-secret private upstream detail'}}:{data:[{id:'z-image'},{id:'a-image'},{id:'z-image'}]}),{status:fail?401:200,headers:{'Content-Type':'application/json'}});
  });
  const f=await apiFixture(t,config);
  const discovered=await f.req('/api/debug/providers/images/models','POST');assert.equal(discovered.status,200);assert.deepEqual(discovered.data.models,['a-image','z-image']);
  fail=true;const error=await f.req('/api/debug/providers/images/models','POST');assert.equal(error.status,502);assert.match(error.data.error,/手动/);assertPrivate(error.data);
});
