import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {Store} from '../server/store.js';
import {runAgent,explicitReferenceSourceId,continuationReferenceIds} from '../server/agent.js';
import {syncProduct,updateProduct,productForSource} from '../server/product.js';
import {mockDesignRuntime} from './helpers/design-agent.mjs';

const skill={id:'product-promotion',name:'商品推广设计',version:'test',workflow:'product-promotion',body:'根据用户需求设计。',files:[]};
const config={agentModel:'test',imageModel:'test',maxImages:1,maxTurns:4,sandboxMode:'off'};
const image=color=>sharp({create:{width:40,height:60,channels:3,background:color}}).png().toBuffer();

test('numbered product references and planning-turn follow-ups resolve deterministically',()=>{
 const session={referenceIds:[],messages:[{id:'plan',role:'user',referenceIds:['style','product','copy']} ]};
 const ids=continuationReferenceIds(session,{userMessageId:'followup',referenceIds:[]},'好，你生图下');
 assert.deepEqual(ids,['style','product','copy']);
 assert.deepEqual(continuationReferenceIds(session,{userMessageId:'new',referenceIds:[]},'好，我想做一个新产品'),[]);
 assert.equal(explicitReferenceSourceId('根据图二的麻辣烫，图三是文案',ids),'product');
 assert.equal(explicitReferenceSourceId('图三只参考文案字体',ids),null);
});

test('planning follow-up edits the previously named product, not the last uploaded copy image',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'canvas-plan-followup-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const store=new Store(dir),session=store.create(),inputs=await Promise.all(['#aaa','#b22','#111'].map(image));
  const versions=inputs.map((bytes,index)=>store.addImage(session,bytes,{kind:'upload',demo:false,label:`图${index+1}`,width:40,height:60}));
  const ids=versions.map(version=>version.id),plan='根据图一风格，做一版图二的麻辣烫，然后麻辣烫文案是图三，你先理解下';
  session.messages.push({id:'plan',role:'user',text:plan,referenceIds:ids},{id:'answer',role:'assistant',text:'图一参考风格，图二是产品，图三参考文案。'},{id:'followup',role:'user',text:'好，你生图下',referenceIds:[]});
  session.referenceIds=[];
  const mock=mockDesignRuntime((_body,step)=>step===0?{name:'save_product_brief',arguments:{facts:[{basis:'observed',text:'麻辣烫使用红碗'}]}}:step===1?{name:'render_image',arguments:{prompt:'制作麻辣烫海报',sourceId:versions[2].id,label:'麻辣烫海报'}}:'已生成。');
  let edited=false;
  mock.runtime.imageAdapter={generate:()=>assert.fail('must edit the product photo'),edit:async(_client,_args,editInputs)=>{
    edited=true;assert.deepEqual(editInputs[0],inputs[1]);
    return {data:[{b64_json:(await image('#fff')).toString('base64')}]};
  }};
  const job={userMessageId:'followup',referenceIds:[]};
  await runAgent({session,store,skill,config,runtime:mock.runtime,emit:()=>{},signal:new AbortController().signal,prompt:'好，你生图下',job});
  assert.equal(edited,true);assert.equal(session.versions.at(-1).parentId,versions[1].id);
  assert.deepEqual(session.versions.at(-1).referenceIds,ids);
  assert.equal(session.versions.at(-1).product.sourceId,versions[1].id);
  assert.deepEqual(session.versions.at(-1).product.facts,[{basis:'observed',text:'麻辣烫使用红碗'}]);
});

for(const scenario of [
  {name:'second image supplies lettering',source:0,prompt:'图一是编辑底图，图二仅参考书法笔触，保留图一的菜品与背景'},
  {name:'second image supplies color',source:0,prompt:'图一是编辑底图，图二仅参考配色，不参考字体或构图'},
  {name:'first image supplies product material',source:1,prompt:'图一是商品素材，图二是编辑底图，用图一的商品替换图二的商品，保留图二版式'},
  {name:'historical attachments retain their described roles',source:0,historical:true,prompt:'按刚才说明修改：图一是编辑底图，图二只参考构图，保留图一字体'},
])test(scenario.name,async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'canvas-image-roles-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const store=new Store(dir),session=store.create(),bytes=[await image('#cba'),await image('#123')],output=await image('#def');
  const versions=bytes.map((data,index)=>store.addImage(session,data,{kind:'upload',demo:false,label:`素材${index+1}.png`,width:40,height:60}));
  assert.equal(session.selectedId,versions[1].id,'uploading a second attachment reproduces the selected-image conflict');
  updateProduct(session,{facts:[{basis:'observed',text:'第二张图专属资料'}]});
  const before=session.versions.map(v=>({...v})),ids=versions.map(v=>v.id);
  const userMessage={id:'attached-message',role:'user',text:scenario.prompt,referenceIds:ids};session.messages.push(userMessage);session.referenceIds=[];
  const source=versions[scenario.source],job={userMessageId:scenario.historical?'followup':userMessage.id,referenceIds:scenario.historical?[]:ids};
  const mock=mockDesignRuntime((body,step)=>{
    if(step===0){
      assert.match(body.instructions,/用途.*用户本轮描述/);
      assert.match(body.instructions,/不要求重新上传或在界面解除绑定/);
      const attached=body.input.find(m=>m.role==='user'&&Array.isArray(m.content)&&m.content.filter(c=>c.type==='input_image').length===2);
      assert.ok(attached,'the model receives both attachments');
      assert.match(JSON.stringify(attached),/参考图 1/);assert.match(JSON.stringify(attached),/参考图 2/);
      return {name:'render_image',arguments:{prompt:scenario.prompt,sourceId:source.id,label:'按用户说明编辑'}};
    }
    const toolOutput=JSON.parse(body.input.filter(i=>i.type==='function_call_output').at(-1).output);
    assert.ok(toolOutput.id,JSON.stringify(toolOutput));return '已按用户说明生成。';
  });
  let edits=0;
  mock.runtime.imageAdapter={generate:()=>assert.fail('must edit the specified base'),edit:async(_client,args,inputs)=>{
    edits++;assert.equal(inputs.length,2);
    assert.deepEqual(inputs[0],bytes[scenario.source],'the requested base is always the first edit input');
    assert.deepEqual(inputs[1],bytes[1-scenario.source]);
    assert.ok(args.prompt.startsWith(scenario.prompt),'the image request retains the described roles');
    assert.ok(args.prompt.includes(`1. 当前编辑底图（用户参考图 ${scenario.source+1}`),'reordered edit inputs preserve the original user-facing image numbers');
    if(scenario.source===0)assert.doesNotMatch(args.prompt,/第二张图专属资料/,'unrelated product facts must not migrate to the edited base');
    return {data:[{b64_json:output.toString('base64')}]};
  }};
  await runAgent({session,store,skill,config,runtime:mock.runtime,emit:()=>{},signal:new AbortController().signal,prompt:scenario.prompt,job});
  assert.equal(edits,1);assert.equal(job.imageCalls,1);assert.equal(job.productSourceId,source.id);
  assert.deepEqual(session.versions.slice(0,2),before,'source metadata is preserved');
  const result=session.versions.at(-1);
  assert.equal(result.renderSourceId,source.id);assert.deepEqual(result.renderSourceIds,[source.id,versions[1-scenario.source].id]);
  assert.equal(result.productSourceId,source.id);assert.equal(session.product.sourceId,source.id);assert.equal(result.product.sourceId,source.id);
  assert.deepEqual(result.referenceIds,ids);assert.deepEqual(session.referenceIds,[]);
  assert.deepEqual(session.product.facts,scenario.source===0?[]:[{basis:'observed',text:'第二张图专属资料'}]);
});

test('switching to a historical design restores its own product context without mutating the current selection',()=>{
  const original={id:'original',kind:'upload'},other={id:'other',kind:'upload'};
  const session={selectedId:original.id,versions:[original,other]};
  updateProduct(session,{brief:'旧设计方案',facts:[{basis:'user',text:'真实商品资料'}]});
  const snapshot=structuredClone(session.product),design={id:'poster',kind:'generated',parentId:original.id,productSourceId:original.id,product:snapshot};session.versions.push(design);
  session.selectedId=other.id;syncProduct(session);updateProduct(session,{facts:[{basis:'observed',text:'其他图片资料'}]});
  const current=structuredClone(session.product),resolved=productForSource(session,design.id);
  assert.deepEqual(resolved,snapshot);assert.deepEqual(session.product,current);assert.equal(session.selectedId,other.id);
  resolved.facts[0].text='修改副本';assert.equal(design.product.facts[0].text,'真实商品资料');
});

test('same-session editing restriction still rejects a source from another session before image calls',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'canvas-image-roles-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const store=new Store(dir),session=store.create(),foreign=store.addImage(store.create(),await image('#abc'),{kind:'upload',demo:false});
  const mock=mockDesignRuntime((_body,step)=>step===0?{name:'render_image',arguments:{prompt:'编辑指定底图',sourceId:foreign.id,label:'越界'}}:'没有生成。');
  mock.runtime.imageAdapter={generate:()=>assert.fail('foreign source cannot generate'),edit:()=>assert.fail('foreign source cannot edit')};
  try{await runAgent({session,store,skill,config,runtime:mock.runtime,emit:()=>{},signal:new AbortController().signal,prompt:'编辑指定底图',job:{}});}catch(error){assert.match(error.message,/不属于当前会话/);}
  assert.equal(session.versions.length,0);
});
