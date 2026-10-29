import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {createLiveRuntime,runAgent} from '../server/agent.js';
import {Store} from '../server/store.js';

test('Chat Completions supports discussion, generation and follow-up edits without inspection requests',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'canvas-chat-adapter-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const store=new Store(dir),session=store.create(),bytes=await sharp({create:{width:20,height:20,channels:3,background:'#abc'}}).png().toBuffer();
  const config={apiKey:'chat-test-key',baseURL:'https://chat.example.invalid/v1',conversationAdapter:'openai-chat-completions',imageApiKey:'image-test-key',imageBaseURL:'https://images.example.invalid/v1',agentModel:'chat-test',imageModel:'image-test',maxImages:2,maxTurns:8,sandboxMode:'off'};
  let turn=0,step=0;const requests=[];
  t.mock.method(globalThis,'fetch',async(url,init)=>{
    const target=new URL(url),body=typeof init.body==='string'?JSON.parse(init.body):init.body;
    requests.push({target,body});assert.ok(init.signal);
    const json=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json','x-request-id':'request-fixture'}});
    if(target.hostname==='images.example.invalid'){
      assert.equal(new Headers(init.headers).get('authorization'),'Bearer image-test-key');
      assert.equal(body instanceof FormData?body.get('model'):body.model,'image-test');
      assert.equal(Number(body instanceof FormData?body.get('n'):body.n),1);
      if(target.pathname==='/v1/images/edits')assert.deepEqual(Buffer.from(await body.get('image').arrayBuffer()),bytes);
      return json({data:[{b64_json:bytes.toString('base64')}]});
    }
    assert.equal(target.hostname,'chat.example.invalid');assert.equal(target.pathname,'/v1/chat/completions');
    assert.equal(new Headers(init.headers).get('authorization'),'Bearer chat-test-key');assert.equal(body.model,'chat-test');
    assert.ok(body.tools?.length,'all conversation requests are part of the main Agent');
    assert.ok(body.tools.every(tool=>tool.function.name!=='inspect_image'));
    assert.equal(body.parallel_tool_calls,false);
    if(turn>0){
      assert.ok(body.messages.some(message=>message.role==='user'&&JSON.stringify(message.content).includes('先讨论')));
      assert.ok(body.messages.some(message=>message.role==='assistant'&&JSON.stringify(message.content).includes('可以使用柔和侧光')));
    }
    if(turn===2)assert.ok(body.messages.some(message=>Array.isArray(message.content)&&message.content.some(item=>item.type==='image_url'&&item.image_url.url.startsWith('data:image/jpeg;base64,'))),'selected image reaches the conversation model');
    let message,finish_reason='stop';
    if(turn===0)message={role:'assistant',content:'可以使用柔和侧光，先确定背景颜色。'};
    else if(step++===0){
      finish_reason='tool_calls';message={role:'assistant',content:null,tool_calls:[{id:`call_${turn}`,type:'function',function:{name:'render_image',arguments:JSON.stringify({prompt:turn===1?'奶油背景的花瓶，柔和侧光':'改成淡紫色背景，保留花瓶',sourceId:session.selectedId,label:'花瓶'})}}]};
    }else{
      const result=body.messages.filter(item=>item.role==='tool').at(-1);
      assert.match(result.content,/直接向用户交付/);
      message={role:'assistant',content:'图片已生成，可以继续对话修改。'};
    }
    return json({id:`chat_${requests.length}`,object:'chat.completion',created:1,model:'chat-test',choices:[{index:0,message,finish_reason}],usage:{prompt_tokens:10,completion_tokens:2,total_tokens:12,prompt_tokens_details:{cached_tokens:3}}});
  });
  const runtime=createLiveRuntime(config);
  for(const prompt of ['先讨论花瓶的摄影方案，不生图','用奶油色背景画一个花瓶','背景改成淡紫色']) {
    step=0;
    const job={};const output=await runAgent({session,skill:null,skills:null,store,config,runtime,emit:()=>{},signal:new AbortController().signal,prompt,job});
    assert.equal(output,turn===0?'可以使用柔和侧光，先确定背景颜色。':'图片已生成，可以继续对话修改。');
    assert.equal(session.versions.length,turn,'discussion creates no image; each requested generation/edit adds one');
    assert.deepEqual(job.usage.map(item=>item.kind),turn===0?['agent']:['agent','image']);
    assert.equal(job.usage[0].responses.length,turn===0?1:2);
    session.messages.push({id:`user_${turn}`,role:'user',text:prompt},{id:`assistant_${turn}`,role:'assistant',text:output});store.save(session);
    turn++;
  }
  assert.deepEqual(requests.filter(item=>item.target.hostname==='images.example.invalid').map(item=>item.target.pathname),['/v1/images/generations','/v1/images/edits']);
  assert.equal(requests.filter(item=>item.target.hostname==='chat.example.invalid').length,5);
  assert.ok(session.versions.every(item=>!('reviewed' in item)&&!('reviewSkipped' in item)&&!('reviewResult' in item)));
  assert.equal(session.versions[1].parentId,session.versions[0].id);
});
