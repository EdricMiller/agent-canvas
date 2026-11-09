import OpenAI from 'openai';
import {Runner,OpenAIProvider} from '@openai/agents';

// Use the real SDK loop and schema conversion; replace only network responses.
export function mockDesignRuntime(plan){
  const requests=[];
  const client=new OpenAI({apiKey:'design-fixture-not-a-key',maxRetries:0,fetch:async(_url,init)=>{
    const body=JSON.parse(init.body),index=requests.length;requests.push(body);
    const action=await plan(body,index);
    const output=typeof action==='string'?[{id:`msg_${index}`,type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:action,annotations:[]}]}]:[{id:`fc_${index}`,type:'function_call',status:'completed',call_id:`call_${index}`,name:action.name,arguments:JSON.stringify(action.arguments)}];
    return new Response(JSON.stringify({id:`resp_${index}`,object:'response',created_at:1,status:'completed',model:'test',output,usage:{input_tokens:10,output_tokens:10,total_tokens:20}}),{headers:{'Content-Type':'application/json'}});
  }});
  return {requests,runtime:{client,runner:new Runner({modelProvider:new OpenAIProvider({openAIClient:client}),tracingDisabled:true})}};
}

export function boundDesign({width=180,height=240,unit='mm',sourceId,logoId}={}){
  return {schemaVersion:1,title:'通用品牌设计',content:[{id:'title',label:'标题',value:'今日精选',status:'confirmed',...(sourceId?{sourceId}:{})},{id:'price',label:'产品价格',value:'68',status:'confirmed',...(sourceId?{sourceId}:{})}],pages:[{id:'page-one',name:'第 1 页',width,height,unit,background:'#ffffff',objects:[
    {id:'title-object',type:'text',text:'今日精选',bindingId:'title',x:width*.1,y:height*.12,width:width*.8,height:height*.15,fontSize:24,lineHeight:1.35,color:'#17365d',align:'left'},
    {id:'price-object',type:'text',text:'68',bindingId:'price',x:width*.1,y:height*.4,width:width*.5,height:height*.1,fontSize:18,lineHeight:1.35,color:'#17365d',align:'left'},
    ...(logoId?[{id:'logo-object',type:'image',assetId:logoId,x:width*.6,y:height*.4,width:width*.25,height:height*.2,fit:'contain'}]:[]),
  ]}]};
}
