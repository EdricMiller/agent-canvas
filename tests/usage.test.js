import test from 'node:test';
import assert from 'node:assert/strict';
import {readUsage,startUsage,finishUsage,finishAgentUsage} from '../server/usage.js';
import {usageSummary,taskMarkup} from '../public/product.js';

test('usage preserves omitted fields as unknown and actual zeroes as zero',()=>{
 assert.equal(readUsage(undefined),null);assert.equal(readUsage({}),null);assert.equal(readUsage({input_tokens:-1}),null);
 assert.equal(readUsage({total_tokens:8}).inputTokens,null);
 assert.equal(readUsage({input_tokens:0,output_tokens:0}).totalTokens,0);
 const usage=readUsage({input_tokens:10,output_tokens:2,input_tokens_details:{cached_tokens:4,text_tokens:6,image_tokens:4},output_tokens_details:{reasoning_tokens:1}});
 assert.deepEqual(usage,{inputTokens:10,outputTokens:2,totalTokens:12,cachedTokens:4,textInputTokens:6,imageInputTokens:4,reasoningTokens:1});
});

test('agent usage reads raw provider data and ignores SDK normalized zeroes',()=>{
 const job={},call=startUsage(job,'agent','chat');
 finishAgentUsage(call,{rawResponses:[{usage:{inputTokens:0,outputTokens:0,totalTokens:0}},{rawUsage:{input_tokens:4,output_tokens:2,total_tokens:6},responseId:'r'}]});
 assert.equal(call.responses[0].usage,null);assert.equal(call.responses[1].usage.totalTokens,6);
 assert.equal(call.requestedModel,'chat');assert.equal(call.status,'completed');assert.ok(call.durationMs>=0);
 assert.equal(usageSummary(job).complete,false);assert.equal(usageSummary(job).totalTokens,6);
});

test('planning and image usage sum once, including partial failures',()=>{
 const task={models:{agent:'chat',image:'image'},usage:[]};
 const agent=startUsage(task,'agent','chat');finishAgentUsage(agent,{rawResponses:[{rawUsage:{input_tokens:10,output_tokens:5}}]});
 const image=startUsage(task,'image','image');finishUsage(image,{usage:{input_tokens:2,output_tokens:8},model:'actual-image'});
 assert.deepEqual(usageSummary(task),{inputTokens:12,outputTokens:13,totalTokens:25,complete:true,requests:2});
 assert.equal(image.responseModel,'actual-image');
 finishUsage(image,null,'failed');
 assert.equal(usageSummary(task).totalTokens,15);assert.equal(usageSummary(task).complete,false);
 assert.match(taskMarkup(task),/记录不完整/);assert.match(taskMarkup(task),/实际扣费：未知/);
 assert.match(taskMarkup({models:task.models,usage:[]}),/未知 tokens/);
 assert.equal(taskMarkup({status:'completed'}),'');
});
