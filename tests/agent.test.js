import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import OpenAI from 'openai';
import {Runner,OpenAIProvider} from '@openai/agents';
import {Store} from '../server/store.js';
import {Skills} from '../server/skills.js';
import {createLiveRuntime,runAgent} from '../server/agent.js';
import {renderMenu,validateMenu} from '../server/menu.js';
import {usageSummary} from '../public/product.js';
import {updateProduct} from '../server/product.js';

test('menu data is validated and rendered with exact text layout',async t=>{
 const menu={title:'春日咖啡',subtitle:'Coffee & Tea',currency:'CNY',sections:[{name:'咖啡',items:[{name:'美式',price:'¥18'},{name:'燕麦拿铁',price:'¥28',description:'丝滑燕麦奶'}]},{name:'甜点',items:[{name:'巴斯克芝士蛋糕',price:'¥32'}]}]};
 const valid=validateMenu(menu);assert.equal(valid.valid,true);assert.equal(valid.itemCount,3);
 const rendered=await renderMenu(menu,'1024x1536','warm editorial');
 assert.equal(rendered.width,1024);assert.equal(rendered.height,1536);assert.ok(rendered.bytes.length>1000);
 const metadata=await sharp(rendered.bytes).metadata();assert.equal(metadata.format,'png');
 assert.equal(validateMenu({sections:[{name:'咖啡',items:[{name:'美式',price:'not-a-price'}]}]}).warnings.length,1);
 const renderedWithSeparateCurrency=await renderMenu({...menu,sections:[{name:'咖啡',items:[{name:'美式',price:'18'}]}]},'1024x1536');
 const raw=await sharp(renderedWithSeparateCurrency.bytes).raw().toBuffer();
 assert.ok(raw.length>0);
});

test('real SDK adapter accepts persisted assistant history and selected image on next turn',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'canvas-adapter-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const store=new Store(dir),session=store.create();
 const image=await sharp({create:{width:20,height:20,channels:3,background:'#abc'}}).png().toBuffer();
 store.addImage(session,image,{label:'source',demo:false,width:20,height:20});
 session.messages=[{id:'one',role:'user',text:'画一个花瓶'},{id:'two',role:'assistant',text:'花瓶已生成。'},{id:'three',role:'user',text:'背景淡一点'}];
 let captured;
 const client=new OpenAI({apiKey:'test-not-a-real-key',maxRetries:0,fetch:async(_url,init)=>{
   captured=JSON.parse(init.body);
   return new Response(JSON.stringify({id:'resp_test',object:'response',created_at:1,status:'completed',model:'test',output:[{id:'msg_test',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'已理解修改需求。',annotations:[]}]}],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}),{headers:{'Content-Type':'application/json'}});
 }});
 const runner=new Runner({modelProvider:new OpenAIProvider({openAIClient:client}),tracingDisabled:true});
 const skills=new Skills([path.resolve(import.meta.dirname,'../skills')],path.join(dir,'skills'));
 const output=await runAgent({session,skill:skills.get('editorial'),skills,store,config:{agentModel:'test',imageModel:'test',maxImages:2},runtime:{client,runner},emit:()=>{},signal:new AbortController().signal,prompt:'背景淡一点',job:{userMessageId:'three'}});
 assert.equal(output,'已理解修改需求。');
 const history=captured.input.find(m=>m.role==='assistant');assert.equal(history.content[0].text,'花瓶已生成。');
 const last=captured.input.at(-1);assert.equal(last.content[0].text,'背景淡一点');assert.match(last.content[1].image_url,/^data:image\/jpeg;base64,/);
 assert.equal(captured.parallel_tool_calls,false);
});

test('generation and edits use the image provider while planning uses the conversation provider without image inspection',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'canvas-routing-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const store=new Store(dir),session=store.create();
 const bytes=await sharp({create:{width:20,height:20,channels:3,background:'#abc'}}).png().toBuffer();
 const config={apiKey:'chat-test-key',baseURL:'https://chat.example.invalid/v1',imageApiKey:'image-test-key',imageBaseURL:'https://images.example.invalid/v1',agentModel:'gpt-6.1-sol',imageModel:'gpt-image-2.5-sunburst',maxImages:2,maxTurns:10,sandboxMode:'off'};
 const requests=[];let step=0;
 t.mock.method(globalThis,'fetch',async(url,init)=>{
  const target=new URL(url),headers=new Headers(init.headers);
  const body=typeof init.body==='string'?JSON.parse(init.body):init.body;
  requests.push({url:target,authorization:headers.get('authorization'),model:body instanceof FormData?body.get('model'):body.model});
  const json=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
  if(target.hostname==='images.example.invalid') {
   assert.ok(['/v1/images/generations','/v1/images/edits'].includes(target.pathname));
   return json({data:[{b64_json:bytes.toString('base64')}]});
  }
  assert.equal(target.hostname,'chat.example.invalid');assert.equal(target.pathname,'/v1/responses');
  assert.ok(body.tools.every(tool=>tool.name!=='inspect_image'),'inspection is not an available tool');
  let output;
  if(step++%2===0) output=[{id:`fc_${step}`,type:'function_call',status:'completed',call_id:`call_${step}`,name:'render_image',arguments:JSON.stringify({prompt:'一个花瓶',sourceId:session.selectedId,label:'花瓶'})}];
  else {
   const result=body.input.filter(item=>item.type==='function_call_output').at(-1);
   assert.match(result.output,/向用户交付/);assert.doesNotMatch(result.output,/inspect_image/);
   output=[{id:`msg_${step}`,type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'图片已生成。',annotations:[]}]}];
  }
  return json({id:`resp_${requests.length}`,object:'response',created_at:1,status:'completed',model:config.agentModel,output,usage:{input_tokens:1,output_tokens:1,total_tokens:2}});
 });
 const runtime=createLiveRuntime(config);
 for(const prompt of ['画一个花瓶','背景淡一点']) {
  assert.equal(await runAgent({session,skill:null,skills:null,store,config,runtime,emit:()=>{},signal:new AbortController().signal,prompt,job:{}}),'图片已生成。');
 }
 const imageRequests=requests.filter(request=>request.url.hostname==='images.example.invalid');
 assert.deepEqual(imageRequests.map(request=>request.url.pathname),['/v1/images/generations','/v1/images/edits']);
 for(const request of imageRequests) {assert.equal(request.authorization,'Bearer image-test-key');assert.equal(request.model,config.imageModel);}
 const chatRequests=requests.filter(request=>request.url.hostname==='chat.example.invalid');
 assert.equal(chatRequests.length,4);
 for(const request of chatRequests) {assert.equal(request.authorization,'Bearer chat-test-key');assert.equal(request.model,config.agentModel);}
 assert.equal(session.versions.length,2);assert.equal(session.versions[1].parentId,session.versions[0].id);
 assert.ok(session.versions.every(version=>!('reviewed' in version)&&!('reviewSkipped' in version)&&!('reviewResult' in version)));
});

test('product generation and subsequent edits preserve agent direction, original source and usage',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'canvas-product-agent-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const store=new Store(dir),session=store.create();
 const png=background=>sharp({create:{width:20,height:20,channels:3,background}}).png().toBuffer();
 const originalBytes=await png('#abc'),previousBytes=await png('#123'),firstBytes=await png('#def'),editedBytes=await png('#f90');
 const original=store.addImage(session,originalBytes,{kind:'upload',demo:false});
 const previous=store.addImage(session,previousBytes,{kind:'generated',demo:false,parentId:original.id});
 const skills=new Skills([path.resolve(import.meta.dirname,'../skills')],path.join(dir,'skills'));
 const config={apiKey:'test-key',baseURL:'https://test.example.invalid/v1',agentModel:'chat-test',imageModel:'image-test',maxImages:1,maxTurns:8,sandboxMode:'off'};
 const job={status:'running',createdAt:new Date().toISOString()};session.job=job;
 let step=0,firstInput,editing=false,imageCalls=0;
 t.mock.method(globalThis,'fetch',async(url,init)=>{
  const body=typeof init.body==='string'?JSON.parse(init.body):init.body;
  const json=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
  if(new URL(url).pathname==='/v1/images/edits'){
   imageCalls++;
   assert.equal(body.get('model'),'image-test');
   assert.deepEqual(Buffer.from(await body.get('image').arrayBuffer()),originalBytes,'the actual edit input stays the uploaded product');
   assert.match(body.get('prompt'),/森林苔藓/);assert.match(body.get('prompt'),/observed/);
   assert.ok(body.get('prompt').includes(editing?'1024x1024':'1536x1024'),'the agent can arrange the canvas without a user control');
   assert.ok(body.get('prompt').includes(editing?'给日常，一点微光':'把微光，戴进日常'));
   return json({data:[{b64_json:(editing?editedBytes:firstBytes).toString('base64')}]}); // provider omitted usage
  }
  assert.ok(body.tools.every(tool=>!['inspect_image','compose_product_poster'].includes(tool.name)));
  if(step===0){
   if(!editing)firstInput=body.input;
   assert.equal(body.parallel_tool_calls,false);
   const briefTool=body.tools.find(tool=>tool.name==='save_product_brief');assert.ok(briefTool);
   assert.equal(briefTool.parameters.properties.shot,undefined);
   assert.doesNotMatch(JSON.stringify(briefTool.parameters.properties.campaign),/"mode"|"layout"|"palette"/);
  }
  const headline=editing?'给日常，一点微光':'把微光，戴进日常';
  const actions=[
   ['save_product_brief',{size:editing?'1024x1024':'1536x1024',brief:'森林苔藓背景，柔和晨光，标题沿手链弧线排布',facts:[{text:'可见浅色珠子',basis:'observed'}],campaign:{theme:'腕间微光',headline,visual:'森林苔藓背景，柔和晨光'}}],
   ['render_image',{prompt:'森林苔藓背景，标题沿手链弧线排布，文字为“'+headline+'”',sourceId:session.selectedId,label:editing?'调整标题':'商品新版本'}],
   ...(editing?[['render_image',{prompt:'不要追加生成',sourceId:session.selectedId,label:'不应新增'}]]:[])
  ];
  const action=actions[step++];
  if(!action&&editing)assert.match(body.input.filter(item=>item.type==='function_call_output').at(-1).output,/禁止自动返工/);
  const output=action?[{id:'fc'+step,type:'function_call',status:'completed',call_id:'c'+step,name:action[0],arguments:JSON.stringify(action[1])}]:[{id:'done',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'已生成商品新版本。',annotations:[]}]}];
  return json({id:'resp_'+step,object:'response',created_at:1,status:'completed',model:'chat-test',output,usage:{input_tokens:10,output_tokens:2,total_tokens:12}});
 });
 await runAgent({session,skill:skills.get('product-promotion'),skills,store,config,runtime:createLiveRuntime(config),emit:()=>{},signal:new AbortController().signal,prompt:'森林苔藓背景，标题沿手链弧线排布',job});
 assert.equal(imageCalls,1);assert.equal(session.size,'1536x1024');
 assert.equal(firstInput.at(-1).content.filter(c=>c.type==='input_image').length,2,'planning sees selected design and original');
 const version=session.versions.at(-1);
 assert.equal(version.parentId,previous.id);assert.equal(version.renderSourceId,original.id);assert.equal(version.productSourceId,original.id);
 assert.equal(version.product.facts[0].basis,'observed');assert.match(version.product.brief,/弧线/);assert.equal(version.generation.model,'image-test');assert.equal(version.usage,null);
 assert.equal(version.kind,'generated');assert.equal(version.width,20);assert.equal(version.height,20);assert.equal(session.versions.length,3);
 assert.deepEqual(store.image(session,version.id).bytes,firstBytes,'the provider image is not rearranged or typeset locally');
 assert.equal('poster' in version,false);assert.equal('reviewResult' in version,false);assert.equal(job.usage.some(call=>call.kind==='review'),false);
 assert.equal(job.usage.find(c=>c.kind==='agent').responses.length,3);
 assert.equal(usageSummary(job).totalTokens,36);assert.equal(usageSummary(job).complete,false);
 editing=true;step=0;const editJob={status:'running'};session.job=editJob;
 await runAgent({session,skill:skills.get('product-promotion'),skills,store,config,runtime:createLiveRuntime(config),emit:()=>{},signal:new AbortController().signal,prompt:'把标题改成给日常，一点微光，保留森林苔藓',job:editJob});
 const updated=session.versions.at(-1);
 assert.equal(imageCalls,2,'a requested edit uses one image call and the extra automatic attempt is blocked');
 assert.equal(editJob.imageCalls,1);assert.equal(session.size,'1024x1024');
 assert.equal(updated.parentId,version.id);assert.equal(updated.renderSourceId,original.id);assert.equal(updated.product.campaign.headline,'给日常，一点微光');assert.equal(version.product.campaign.headline,'把微光，戴进日常');assert.equal(session.versions.length,4);
 assert.deepEqual(store.image(session,updated.id).bytes,editedBytes);
 editJob.status='completed';store.save(session);
 assert.equal(new Store(dir).get(session.id).versions.at(-1).renderSourceId,original.id);
});

test('failed and cancelled model requests retain unknown usage instead of zero',async t=>{
 for(const mode of ['failed','cancelled'])await t.test(mode,async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'canvas-usage-error-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const store=new Store(dir),session=store.create(),job={},controller=new AbortController();
  const config={apiKey:'test-key',baseURL:'https://test.example.invalid/v1',agentModel:'chat-test',imageModel:'image-test',maxTurns:3,sandboxMode:'off'};
  let requests=0;
  t.mock.method(globalThis,'fetch',async()=>{
   if(mode==='cancelled'){controller.abort();throw controller.signal.reason;}
   if(requests++===0)return new Response(JSON.stringify({id:'partial',object:'response',created_at:1,status:'completed',model:'chat-test',output:[{id:'fc_partial',type:'function_call',status:'completed',call_id:'partial_call',name:'update_plan',arguments:JSON.stringify({steps:['准备创作']})}],usage:{input_tokens:10,output_tokens:2,total_tokens:12}}),{headers:{'Content-Type':'application/json'}});
   return new Response(JSON.stringify({error:{message:'test failure',type:'server_error'}}),{status:500,headers:{'Content-Type':'application/json'}});
  });
  await assert.rejects(()=>runAgent({session,skill:null,skills:null,store,config,runtime:createLiveRuntime(config),emit:()=>{},signal:controller.signal,prompt:'测试',job}));
  assert.equal(job.usage.length,1);assert.equal(job.usage[0].status,mode);assert.equal(usageSummary(job).totalTokens,mode==='failed'?12:null);assert.equal(usageSummary(job).complete,false);
 });
});

test('product rendering accepts free direction and checks factual claims before billing',async t=>{
 const points=Array.from({length:6},(_,i)=>'已知特点'+i);
 for(const scenario of [
  {name:'no mandatory saved plan'},
  {name:'a promotion can omit the headline',campaign:{offer:'¥99'},facts:[{basis:'user',text:'价格 ¥99'}]},
  {name:'custom scene and long headline',campaign:{headline:'长'.repeat(80),visual:'机械实验室中的微缩世界，环绕式文字'}},
  {name:'more than three grounded selling points',campaign:{sellingPoints:points},facts:points.map(text=>({basis:'user',text}))},
  {name:'unfounded offer',campaign:{offer:'¥99'},error:/用户依据/},
  {name:'unknown claims',campaign:{sellingPoints:['纯天然']},facts:[{basis:'unknown',text:'纯天然'}],error:/缺少商品资料依据/},
 ])await t.test(scenario.name,async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'canvas-product-direction-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const store=new Store(dir),session=store.create(),skills=new Skills([path.resolve(import.meta.dirname,'../skills')],path.join(dir,'skills'));
  const bytes=await sharp({create:{width:60,height:80,channels:3,background:'#abc'}}).png().toBuffer();
  store.addImage(session,bytes,{kind:'upload',demo:false});
  if(scenario.campaign||scenario.facts)updateProduct(session,{...(scenario.campaign?{campaign:scenario.campaign}:{}),...(scenario.facts?{facts:scenario.facts}:{})});
  const config={apiKey:'test',baseURL:'https://test.example.invalid/v1',agentModel:'chat-test',imageModel:'image-test',maxImages:1,maxTurns:3,sandboxMode:'off'};
  let step=0,imageRequests=0;
  t.mock.method(globalThis,'fetch',async(url,init)=>{
   const json=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
   if(new URL(url).pathname==='/v1/images/edits'){
    imageRequests++;const prompt=init.body.get('prompt');assert.match(prompt,/遵循用户描述的构图/);
    if(scenario.campaign?.visual)assert.ok(prompt.includes(scenario.campaign.visual));
    return json({data:[{b64_json:bytes.toString('base64')}]});
   }
   const body=JSON.parse(init.body);let output;
   assert.ok(body.tools.every(tool=>tool.name!=='compose_product_poster'));
   if(step++===0)output=[{id:'fc',type:'function_call',status:'completed',call_id:'call',name:'render_image',arguments:JSON.stringify({prompt:'遵循用户描述的构图，完整展示商品。'+(scenario.campaign?.visual||''),sourceId:session.selectedId,label:'商品图'})}];
   else{
    const result=JSON.parse(body.input.filter(item=>item.type==='function_call_output').at(-1).output);
    if(scenario.error)assert.match(result.error,scenario.error);else{assert.ok(result.id);assert.equal('editableCopy' in result,false);}
    output=[{id:'done',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'本轮结束',annotations:[]}]}];
   }
   return json({id:'resp_'+step,object:'response',created_at:1,status:'completed',model:'chat-test',output,usage:{input_tokens:1,output_tokens:1,total_tokens:2}});
  });
  const job={};await runAgent({session,skill:skills.get('product-promotion'),skills,store,config,runtime:createLiveRuntime(config),emit:()=>{},signal:new AbortController().signal,prompt:'制作商品图',job});
  assert.equal(imageRequests,scenario.error?0:1);assert.equal(job.imageCalls||0,imageRequests);assert.equal(session.versions.length,scenario.error?1:2);
  if(!scenario.error){assert.equal('poster' in session.versions.at(-1),false);assert.equal(session.versions.at(-1).width,60);assert.equal(session.versions.at(-1).height,80);assert.deepEqual(store.image(session,session.selectedId).bytes,bytes);}
 });
});

test('product image budget blocks unrequested extra generations, even when the global limit is unlimited',async t=>{
 for(const scenario of [
  {name:'single with a later user edit',prompts:['做一张手链宣传图','按建议修改'],limit:1,maxImages:Infinity},
  {name:'explicit two images',prompts:['生成两张手链商品图'],limit:2,maxImages:Infinity},
  {name:'configured cap still applies',prompts:['生成两张手链商品图'],limit:1,maxImages:1},
  {name:'failed attempt uses the single-call budget',prompts:['做一张手链宣传图'],limit:1,maxImages:Infinity,fail:true},
 ])await t.test(scenario.name,async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'canvas-product-limit-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const store=new Store(dir),session=store.create(),skills=new Skills([path.resolve(import.meta.dirname,'../skills')],path.join(dir,'skills'));
  const bytes=await sharp({create:{width:20,height:20,channels:3,background:'#abc'}}).png().toBuffer();store.addImage(session,bytes,{kind:'upload',demo:false});
  const config={apiKey:'test-key',baseURL:'https://test.example.invalid/v1',agentModel:'chat-test',imageModel:'image-test',maxImages:scenario.maxImages,maxTurns:10,sandboxMode:'off'};
  let step=0,imageRequests=0,blocked=0;
  t.mock.method(globalThis,'fetch',async(url,init)=>{
   const body=typeof init.body==='string'?JSON.parse(init.body):init.body;
   const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
   if(new URL(url).pathname==='/v1/images/edits'){
    imageRequests++;
    return scenario.fail?json({error:{message:'test image failure',type:'server_error'}},500):json({data:[{b64_json:bytes.toString('base64')}]});
   }
   assert.ok(body.tools.every(tool=>tool.name!=='inspect_image'));
   let output;
   const actions=Array(scenario.limit+1).fill('render_image');
   const action=actions[step++];
   if(action){const args={prompt:'保留手链并优化背景',sourceId:session.selectedId,label:'商品图'};output=[{id:`fc${step}`,type:'function_call',status:'completed',call_id:`call${step}`,name:action,arguments:JSON.stringify(args)}];}
   else{
    const last=body.input.filter(item=>item.type==='function_call_output').at(-1);
    assert.match(last.output,/禁止自动返工/);blocked++;
    output=[{id:'done',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'本轮已交付，等待用户下一条修改请求。',annotations:[]}]}];
   }
   return json({id:`resp_${step}`,object:'response',created_at:1,status:'completed',model:'chat-test',output,usage:{input_tokens:1,output_tokens:1,total_tokens:2}});
  });
  const runtime=createLiveRuntime(config);
  for(const prompt of scenario.prompts){
   step=0;const job={};
   const reply=await runAgent({session,skill:skills.get('product-promotion'),skills,store,config,runtime,emit:()=>{},signal:new AbortController().signal,prompt,job});
   assert.match(reply,/等待用户/);assert.equal(job.imageCalls,scenario.limit);assert.equal(job.imageLimit,scenario.limit);assert.equal(job.usage.some(call=>call.kind==='review'),false);
  }
  assert.equal(imageRequests,scenario.limit*scenario.prompts.length);assert.equal(blocked,scenario.prompts.length);
  assert.equal(session.versions.length,1+(scenario.fail?0:imageRequests));
  assert.ok(session.versions.slice(1).every(version=>!('reviewResult' in version)));
 });
});
