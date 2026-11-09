import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {Store} from '../server/store.js';
import {createLiveRuntime,runAgent} from '../server/agent.js';

for(const adapter of ['openai-responses','openai-chat-completions'])test(`${adapter}: message attachments reach vision and edits after drafts clear, including historical follow-ups`,async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'canvas-multi-reference-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const store=new Store(dir),session=store.create();session.skillId='menu-design';
 const image=async color=>sharp({create:{width:40,height:30,channels:3,background:color}}).png().toBuffer();
 const menu=await image('#cba'),logo=await image('#07f'),result=await image('#cad');
 const first=store.addImage(session,menu,{kind:'upload',demo:false,label:'菜单明细.png'});
 const second=store.addImage(session,logo,{kind:'upload',demo:false,label:'Logo.png'});
 const config={apiKey:'chat-test-key',baseURL:'https://chat.example.invalid/v1',conversationAdapter:adapter,imageApiKey:'image-test-key',imageBaseURL:'https://images.example.invalid/v1',agentModel:'chat-test',imageModel:'image-test',maxImages:2,maxTurns:8,sandboxMode:'off'};
 let turn=0,step=0,imageCalls=0,firstGenerated;
 t.mock.method(globalThis,'fetch',async(url,init)=>{
  const target=new URL(url),body=typeof init.body==='string'?JSON.parse(init.body):init.body;
  const json=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
  if(target.hostname==='images.example.invalid'){
   imageCalls++;assert.equal(target.pathname,'/v1/images/edits','references use edits even when the tool asks for a new design');
   const files=body.getAll('image[]');
   const expected=turn===0?[menu,logo]:turn===1?[result,menu,logo]:turn===2?[result,logo]:[result,result];
   assert.equal(files.length,expected.length);
   for(const [index,file] of files.entries())assert.deepEqual(Buffer.from(await file.arrayBuffer()),expected[index],`input ${index+1} retains the original full-resolution bytes`);
   assert.ok(init.signal);
   return json({data:[{b64_json:result.toString('base64')}]});
  }
  assert.equal(target.hostname,'chat.example.invalid');
  const isResponses=adapter==='openai-responses';
  assert.equal(target.pathname,isResponses?'/v1/responses':'/v1/chat/completions');
  let output;
  if(step++===0){
   const content=(isResponses?body.input:body.messages).filter(m=>m.role==='user').at(-1).content;
   const images=content.filter(c=>c.type===(isResponses?'input_image':'image_url'));
   assert.equal(images.length,turn===0?2:turn===1?1:2,'current visual input uses this turn’s attachments plus the selected design');
   if(turn===0){
    assert.match(JSON.stringify(content),/参考图 1/);assert.match(JSON.stringify(content),/参考图 2/);
    assert.match(JSON.stringify(content),/菜单明细.png/);
   }else{
    const historical=(isResponses?body.input:body.messages).filter(m=>m.role==='user')[0].content;
    assert.equal(historical.filter(c=>c.type===(isResponses?'input_image':'image_url')).length,2,'the original message keeps both visual attachments in model history');
    assert.match(JSON.stringify(historical),/菜单明细.png/);assert.match(JSON.stringify(historical),/Logo.png/);
    assert.doesNotMatch(JSON.stringify(content),/菜单明细.png/,'past attachments are not presented as newly attached files');
   }
   if(turn===0||turn===2)assert.match(JSON.stringify(content),/Logo.png/);
   if(turn===3)assert.match(JSON.stringify(content),/参考图 1 · V1 · 菜单/,'a historical generated version is labeled as this turn’s reference');
   const args=JSON.stringify({prompt:'使用菜单内容和 Logo 制作菜单，保持价格准确',sourceId:turn===0?null:session.selectedId,label:'菜单'});
   output=isResponses?[{id:'fc_test',type:'function_call',status:'completed',call_id:'call_test',name:'render_image',arguments:args}]:{role:'assistant',content:null,tool_calls:[{id:'call_test',type:'function',function:{name:'render_image',arguments:args}}]};
  }else output=isResponses?[{id:'msg_test',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'已完成菜单。',annotations:[]}]}]:{role:'assistant',content:'已完成菜单。'};
  return isResponses?json({id:'resp_test',object:'response',created_at:1,status:'completed',model:'chat-test',output,usage:{input_tokens:1,output_tokens:1,total_tokens:2}}):json({id:'chat_test',object:'chat.completion',created:1,model:'chat-test',choices:[{index:0,message:output,finish_reason:step===1?'tool_calls':'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}});
 });
 const runtime=createLiveRuntime(config);
 for(turn=0;turn<4;turn++){
  step=0;const referenceIds=turn===0?[first.id,second.id]:turn===1?[]:turn===2?[second.id]:[firstGenerated.id];
  const prompt=turn===0?'第一张是菜单明细，第二张是 Logo，请一起使用':'调整菜单风格';
  const message={id:`user-${turn}`,role:'user',text:prompt,referenceIds};session.messages.push(message);
  session.referenceIds=[];
  const output=await runAgent({session,skill:null,skills:null,store,config,runtime,emit:()=>{},signal:new AbortController().signal,prompt,job:{userMessageId:message.id,referenceIds}});
  assert.equal(output,'已完成菜单。');
  session.messages.push({id:`assistant-${turn}`,role:'assistant',text:output});
  assert.deepEqual(session.referenceIds,[],'sent attachments never return to the composer');
  assert.deepEqual(session.versions.at(-1).referenceIds,turn===3?[firstGenerated.id]:turn===2?[second.id]:[first.id,second.id]);
  assert.equal(session.versions.at(-1).renderSourceIds.length,turn===1?3:2);
  if(turn===0)firstGenerated=session.versions.at(-1);
  if(turn===3)assert.equal(session.versions.at(-1).renderSourceIds[1],firstGenerated.id,'the original chosen version reaches the image edit request');
 }
 assert.equal(imageCalls,4);
});
