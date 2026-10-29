import OpenAI, { toFile } from 'openai';
import { OpenAIProvider } from '@openai/agents';

// Business code uses this contract; provider-specific protocols belong here.
const adapters = new Map();
export function registerAdapter(id, adapter) {
  if(adapters.has(id))throw new Error(`适配器已注册：${id}`);
  for(const method of ['createClient','modelProvider','generate','edit','listModels']) {
    if(typeof adapter[method]!=='function')throw new Error(`适配器缺少 ${method}`);
  }
  adapters.set(id,adapter);
}
export function getAdapter(id='openai-responses') {
  const adapter=adapters.get(id);
  if(!adapter)throw Object.assign(new Error('不支持的接口适配器'),{status:400});
  return adapter;
}
export function listAdapters() {
  return [...adapters].map(([id,adapter])=>({id,name:adapter.name}));
}

function compatibleAdapter(name,useResponses) {
  return {
    name,
    createClient:provider=>new OpenAI({apiKey:provider.apiKey,baseURL:provider.baseURL||undefined,maxRetries:0,timeout:180000}),
    modelProvider:client=>new OpenAIProvider({openAIClient:client,useResponses}),
    generate:(client,args,options)=>client.images.generate(args,options),
    async edit(client,args,bytes,options) {
      return client.images.edit({...args,image:await toFile(bytes,'source.png',{type:'image/png'})},options);
    },
    async listModels(client,options) {
      const result=await client.models.list(options);
      return [...new Set((result.data||[]).map(model=>model.id).filter(id=>typeof id==='string'))].sort();
    },
  };
}
registerAdapter('openai-responses',compatibleAdapter('OpenAI 兼容 · Responses',true));
registerAdapter('openai-chat-completions',compatibleAdapter('OpenAI 兼容 · Chat Completions',false));
