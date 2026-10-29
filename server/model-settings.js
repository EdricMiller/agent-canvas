import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getAdapter, listAdapters } from './adapters.js';

const text=z.string().trim().min(1).max(200);
const kind=z.enum(['conversation','image']);
const providerInput=z.object({name:text,baseURL:z.string().trim().url().max(2000),adapter:text,apiKey:z.string().trim().max(2000).optional()}).strict();
const modelInput=z.object({providerId:text,model:text,name:z.string().trim().max(200).optional(),kind}).strict();
const stateSchema=z.object({version:z.literal(1),providers:z.array(z.object({id:text,name:text,baseURL:z.string().trim().url().max(2000),adapter:text,apiKey:z.string().max(2000)}).strict()).min(1),models:z.array(z.object({id:text,providerId:text,model:text,name:text,kind}).strict()).min(2),routes:z.object({conversation:text,image:text}).strict()}).strict();
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
function baseURL(value) {
  const url=new URL(value);
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)fail('接口地址需为不含认证信息或查询参数的 HTTP(S) 地址');
  return url.href.replace(/\/+$/,'');
}
function providerName(url) {
  const host=new URL(url).hostname;
  return host==='ffka.com'?'ffka':host==='api.apiyi.com'?'API易':host;
}

export class ModelSettings {
  constructor(config) {
    this.file=path.join(config.dataDir,'model-settings.json');
    this.requireCredentials=!config.demo;
    if(fs.existsSync(this.file))this.data=this.validate(JSON.parse(fs.readFileSync(this.file,'utf8')));
    else {
      const conversation={id:'conversation',name:providerName(config.baseURL||'https://api.openai.com/v1'),baseURL:baseURL(config.baseURL||'https://api.openai.com/v1'),apiKey:config.apiKey||'',adapter:config.conversationAdapter||'openai-responses'};
      const imageURL=baseURL(config.imageBaseURL||conversation.baseURL),imageKey=config.imageApiKey??conversation.apiKey;
      const shared=imageURL===conversation.baseURL&&imageKey===conversation.apiKey&&(config.imageAdapter||'openai-responses')===conversation.adapter;
      const image=shared?conversation:{id:'images',name:providerName(imageURL),baseURL:imageURL,apiKey:imageKey,adapter:config.imageAdapter||'openai-responses'};
      this.data=this.validate({version:1,providers:shared?[conversation]:[conversation,image],models:[
        {id:'conversation-default',providerId:conversation.id,model:config.agentModel,name:config.agentModel,kind:'conversation'},
        {id:'image-default',providerId:image.id,model:config.imageModel,name:config.imageModel,kind:'image'},
      ],routes:{conversation:'conversation-default',image:'image-default'}});
    }
  }
  validate(data) {
    const parsed=stateSchema.parse(data),ids=new Set(),modelIds=new Set();
    for(const provider of parsed.providers) {
      if(ids.has(provider.id))fail('中转站标识重复');ids.add(provider.id);
      provider.baseURL=baseURL(provider.baseURL);getAdapter(provider.adapter);
    }
    for(const model of parsed.models) {
      if(modelIds.has(model.id))fail('模型标识重复');modelIds.add(model.id);
      if(!ids.has(model.providerId))fail('模型所属的中转站不存在');
    }
    for(const role of ['conversation','image']) {
      const model=parsed.models.find(model=>model.id===parsed.routes[role]);
      if(!model||model.kind!==role)fail('所选模型用途不匹配');
      if(this.requireCredentials&&!parsed.providers.find(provider=>provider.id===model.providerId).apiKey)fail('所选中转站尚未配置密钥');
    }
    return parsed;
  }
  provider(id,data=this.data) {
    const provider=data.providers.find(provider=>provider.id===id);
    if(!provider)fail('中转站不存在',404);
    return provider;
  }
  routeInfo(role,data=this.data) {
    const model=data.models.find(model=>model.id===data.routes[role]);
    const {id,name,baseURL,adapter}=this.provider(model.providerId,data);
    return {providerId:id,providerName:name,baseURL,adapter,modelId:model.id,model:model.model};
  }
  runtimeConfig(data=this.data) {
    const conversation=this.routeInfo('conversation',data),image=this.routeInfo('image',data);
    return {apiKey:this.provider(conversation.providerId,data).apiKey,baseURL:conversation.baseURL,conversationAdapter:conversation.adapter,agentModel:conversation.model,
      imageApiKey:this.provider(image.providerId,data).apiKey,imageBaseURL:image.baseURL,imageAdapter:image.adapter,imageModel:image.model};
  }
  publicState() {
    return {adapters:listAdapters(),providers:this.data.providers.map(({apiKey,...provider})=>({...provider,configured:Boolean(apiKey)})),models:structuredClone(this.data.models),routes:{...this.data.routes}};
  }
  prepareRoutes(input) {
    const routes=z.object({conversation:text,image:text}).strict().parse(input);
    return this.validate({...structuredClone(this.data),routes});
  }
  prepareProvider(input,id) {
    const body=providerInput.parse(input),data=structuredClone(this.data),existing=id?this.provider(id,data):null;
    getAdapter(body.adapter);const url=baseURL(body.baseURL);
    if(!body.apiKey&&(!existing||url!==existing.baseURL))fail('新增中转站或修改接口地址时，请输入该站点的密钥');
    const provider={id:existing?.id||randomUUID(),name:body.name,baseURL:url,adapter:body.adapter,apiKey:body.apiKey||existing.apiKey};
    if(existing)Object.assign(existing,provider);else data.providers.push(provider);
    return {data:this.validate(data),id:provider.id};
  }
  prepareModel(input,id) {
    const body=modelInput.parse(input),data=structuredClone(this.data);this.provider(body.providerId,data);
    const existing=id?data.models.find(model=>model.id===id):data.models.find(model=>model.providerId===body.providerId&&model.model===body.model&&model.kind===body.kind);
    if(id&&!existing)fail('模型不存在',404);
    const model={...body,id:existing?.id||randomUUID(),name:body.name||body.model};
    if(existing)Object.assign(existing,model);else data.models.push(model);
    return {data:this.validate(data),id:model.id};
  }
  save(data) {
    const validated=this.validate(data),temporary=`${this.file}.tmp`;
    fs.mkdirSync(path.dirname(this.file),{recursive:true});
    fs.writeFileSync(temporary,JSON.stringify(validated,null,2),{mode:0o600});fs.chmodSync(temporary,0o600);
    fs.renameSync(temporary,this.file);this.data=validated;
  }
}
