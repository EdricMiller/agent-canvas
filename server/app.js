import express from 'express';
import path from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import sharp from 'sharp';
import { z } from 'zod';
import { Store } from './store.js';
import { Skills } from './skills.js';
import { createLiveRuntime, runAgent, runDemo } from './agent.js';
import { listConnectors } from './connectors.js';
import { ModelSettings } from './model-settings.js';
import { getAdapter } from './adapters.js';
import { isProductSkill, productPatchSchema, productSizes, syncProduct, updateProduct } from './product.js';

const sizes=productSizes;
export function createApp(config, overrides={}) {
  const store=new Store(config.dataDir);
  const skills=new Skills([path.join(config.root,'skills'),...(config.skillsDir?[config.skillsDir]:[])],path.join(config.dataDir,'skills'));
  const app=express(), token=randomBytes(24).toString('hex'), controllers=new Map();
  const modelSettings=new ModelSettings(config);
  Object.assign(config,modelSettings.runtimeConfig());
  let runtime=config.demo?null:(overrides.runtime||createLiveRuntime(config));
  const debugState=()=>({...modelSettings.publicState(),mode:config.demo?'demo':'live',busy:controllers.size>0});
  const idle=()=>{if(controllers.size)throw Object.assign(new Error('任务执行中，请在完成或停止后修改模型与中转站'),{status:409});};
  const applyModels=data=>{
    const nextConfig={...config,...modelSettings.runtimeConfig(data)};
    const nextRuntime=config.demo?null:(overrides.runtime||createLiveRuntime(nextConfig));
    modelSettings.save(data);Object.assign(config,nextConfig);runtime=nextRuntime;
  };
  const busy=s=>{if(s.job?.status==='running')throw Object.assign(new Error('本轮仍在执行，请等待或停止后再操作'),{status:409});};
  app.disable('x-powered-by');
  app.use((req,res,next)=>{
    const host=req.hostname;
    if(!['127.0.0.1','localhost','[::1]'].includes(host)) return res.status(403).json({error:'仅允许本地访问'});
    res.set({'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'"});
    if(req.path.startsWith('/api/')) res.set('Cache-Control','no-store');
    if(!['GET','HEAD','OPTIONS'].includes(req.method)) {
      if(req.get('X-Studio-Token')!==token) return res.status(403).json({error:'页面访问令牌已失效，请刷新页面'});
      if(req.get('origin') && req.get('origin')!==`${req.protocol}://${req.get('host')}`) return res.status(403).json({error:'禁止跨站请求'});
    }
    next();
  });
  app.use(express.json({limit:'15mb'}));
  app.get('/api/config',(_req,res)=>res.json({token,mode:config.demo?'demo':'live',agentModel:config.agentModel,imageModel:config.imageModel,providers:{conversation:modelSettings.routeInfo('conversation'),image:modelSettings.routeInfo('image')},imageSize:config.imageSize||'auto',maxImages:Number.isFinite(config.maxImages)?config.maxImages:'unlimited',maxTurns:config.maxTurns===null?'unlimited':config.maxTurns,sandboxMode:config.sandboxMode}));
  app.get('/api/debug',(_req,res)=>res.json(debugState()));
  app.patch('/api/debug/routes',(req,res)=>{idle();applyModels(modelSettings.prepareRoutes(req.body));res.json(debugState());});
  app.post('/api/debug/providers',(req,res)=>{idle();const prepared=modelSettings.prepareProvider(req.body);applyModels(prepared.data);res.status(201).json({...debugState(),savedProviderId:prepared.id});});
  app.patch('/api/debug/providers/:id',(req,res)=>{idle();const prepared=modelSettings.prepareProvider(req.body,req.params.id);applyModels(prepared.data);res.json({...debugState(),savedProviderId:prepared.id});});
  app.post('/api/debug/models',(req,res)=>{idle();const prepared=modelSettings.prepareModel(req.body);applyModels(prepared.data);res.status(201).json({...debugState(),savedModelId:prepared.id});});
  app.patch('/api/debug/models/:id',(req,res)=>{idle();const prepared=modelSettings.prepareModel(req.body,req.params.id);applyModels(prepared.data);res.json({...debugState(),savedModelId:prepared.id});});
  app.post('/api/debug/providers/:id/models',async(req,res)=>{
    const provider=modelSettings.provider(req.params.id);
    if(!provider.apiKey)throw Object.assign(new Error('请先配置该中转站的密钥'),{status:400});
    const adapter=getAdapter(provider.adapter);
    try{res.json({models:await adapter.listModels(adapter.createClient(provider),{signal:AbortSignal.timeout(15000)})});}
    catch(error){res.status(502).json({error:`读取模型列表失败（${error.status||error.name||'连接错误'}），请检查该站点的地址、密钥和网络。也可手动填写模型 ID。`});}
  });
  app.get('/api/connectors',(_req,res)=>res.json(listConnectors(config)));
  app.get('/api/skills',(_req,res)=>res.json(skills.list()));
  app.post('/api/skills',async(req,res)=>{
    const body=z.object({text:z.string().min(1).max(64000).optional(),sourceUrl:z.string().url().optional()}).refine(value=>Boolean(value.text||value.sourceUrl),{message:'需要提供 SKILL.md 内容或 GitHub 地址'}).parse(req.body);
    if(body.sourceUrl) return res.status(201).json(await skills.importGitHub(body.sourceUrl));
    res.status(201).json(skills.import(body.text));
  });
  app.get('/api/sessions',(_req,res)=>res.json(store.list()));
  app.post('/api/sessions',(_req,res)=>res.status(201).json(store.create()));
  app.get('/api/sessions/:id',(req,res)=>{
    const session=store.get(req.params.id);
    if(isProductSkill(skills.list().find(skill=>skill.id===session.skillId)))syncProduct(session);
    res.json(session);
  });
  app.patch('/api/sessions/:id',(req,res)=>{
    const s=store.get(req.params.id);busy(s);
    const body=z.object({skillId:z.string().nullable().optional(),selectedId:z.string().nullable().optional(),size:z.enum(sizes).optional(),title:z.string().min(1).max(60).optional(),product:productPatchSchema.optional()}).strict().parse(req.body);
    const skill=Object.hasOwn(body,'skillId')?skills.get(body.skillId):skills.list().find(skill=>skill.id===s.skillId);
    if(body.product&&!isProductSkill(skill))throw Object.assign(new Error('商品资料仅适用于商品推广设计技能'),{status:400});
    if(body.selectedId) store.image(s,body.selectedId);
    const {product,...patch}=body;
    if(Object.hasOwn(patch,'skillId')&&patch.skillId!==s.skillId)s.product=null;
    Object.assign(s,patch);
    if(Object.hasOwn(body,'selectedId')&&body.selectedId===null)s.product=null;
    if(isProductSkill(skill)&&(s.selectedId||product))syncProduct(s,{restoreVersion:Object.hasOwn(body,'selectedId')});
    if(product)updateProduct(s,product);
    store.save(s);res.json(s);
  });

  app.post('/api/sessions/:id/upload',async(req,res)=>{
    const s=store.get(req.params.id);busy(s);
    const {data,name}=z.object({data:z.string().max(14000000),name:z.string().max(150)}).parse(req.body);
    if(!/^data:image\/(png|jpeg|webp);base64,/.test(data)) throw Object.assign(new Error('支持 PNG、JPEG、WebP 图片'),{status:400});
    const input=Buffer.from(data.split(',')[1],'base64');
    if(input.length>10*1024*1024) throw Object.assign(new Error('图片最大 10 MB'),{status:400});
    let bytes,info;
    try { const image=sharp(input,{limitInputPixels:25000000}).rotate(); bytes=await image.png().toBuffer();info=await sharp(bytes).metadata(); }
    catch { throw Object.assign(new Error('图片无效或超过 2500 万像素'),{status:400}); }
    busy(s); // another request may have started a turn while the decoder was awaiting
    const version=store.addImage(s,bytes,{label:name,parentId:null,skillId:null,width:info.width,height:info.height,kind:'upload',demo:false});
    if(isProductSkill(skills.list().find(skill=>skill.id===s.skillId))){syncProduct(s);store.save(s);}
    res.status(201).json({session:s,version});
  });
  app.post('/api/sessions/:id/turns',(req,res)=>{
    const s=store.get(req.params.id);
    const {text,requestId}=z.object({text:z.string().trim().min(1).max(12000),requestId:z.string().uuid()}).parse(req.body);
    if(s.requests.includes(requestId)) return res.json({session:s,duplicate:true});
    busy(s);const skill=skills.get(s.skillId);
    if(isProductSkill(skill))syncProduct(s);
    if(!config.demo && s.selectedId && store.image(s,s.selectedId).version.demo) throw Object.assign(new Error('当前为演示图片，请上传真实图片，或通过输入框上方的 × 取消选中图片后再生成。'),{status:400});
    const message={id:randomUUID(),role:'user',text,skillId:skill?.id||null,skillName:skill?.name||null,sourceId:s.selectedId,createdAt:new Date().toISOString()};
    s.messages.push(message);s.requests.push(requestId);
    if(s.messages.filter(m=>m.role==='user').length===1)s.title=text.slice(0,28);
    const job={id:randomUUID(),status:'running',events:[],imageCalls:0,userMessageId:message.id,createdAt:new Date().toISOString(),skillId:skill?.id||null,skillVersion:skill?.version||null,models:{agent:config.agentModel,image:config.imageModel},providers:{agent:modelSettings.routeInfo('conversation'),image:modelSettings.routeInfo('image')},usage:[],productSourceId:isProductSkill(skill)?s.product.sourceId:null};
    s.job=job;store.save(s);
    const controller=new AbortController();controllers.set(s.id,controller);
    const timer=setTimeout(()=>controller.abort(new Error('执行超时，请缩小任务后重试')),300000);
    const emit=(type,data)=>{job.events.push({id:randomUUID(),type,...data,at:new Date().toISOString()});store.save(s);};
    res.status(202).json({session:s});
    const execute=overrides.execute || (config.demo?runDemo:runAgent);
    Promise.resolve().then(()=>execute({session:s,skill,skills,store,config,runtime,emit,signal:controller.signal,prompt:text,job})).then(reply=>{
      controller.signal.throwIfAborted();
      job.status='completed';s.messages.push({id:randomUUID(),role:'assistant',text:reply,createdAt:new Date().toISOString(),events:[...job.events],task:job});
    }).catch(error=>{
      job.status=controller.signal.aborted?'cancelled':'failed';
      const code=error.status;
      const safeDetail=String(error.message||'').replace(/Bearer\s+[^\s]+/gi,'Bearer [redacted]').slice(0,500);
      if (!controller.signal.aborted) console.error(`[turn ${job.id}]`,error);
      job.error=controller.signal.aborted ? '本轮已停止。已返回的图片会保留，已提交的 API 请求不保证取消计费。' : error.name==='MaxTurnsExceededError' ? '本轮步骤过多，Agent 未能在回合上限内完成。请减少一次任务中的页面/图片数量，或继续发送“继续完成剩余部分”。已有图片会保留。' : code===401 ? 'API Key 无效，请检查服务端配置。' : code===429 ? 'API 额度或频率限制，请检查账号后重试。' : code===400 ? `请求参数被接口拒绝（400）：${safeDetail||'未返回详细原因'}。请检查模型、Skill 工具参数或接口兼容性。已有图片会保留。` : `本轮未完成（${code||error.name||'执行错误'}）。请检查模型权限、网络或技能依赖；已有图片会保留。`;
      s.messages.push({id:randomUUID(),role:'assistant',text:job.error,error:true,events:[...job.events],task:job,createdAt:new Date().toISOString()});
    }).finally(()=>{clearTimeout(timer);controllers.delete(s.id);job.finishedAt=new Date().toISOString();store.save(s);});
  });
  app.post('/api/sessions/:id/cancel',(req,res)=>{store.get(req.params.id);controllers.get(req.params.id)?.abort();res.json({ok:true});});
  app.use('/images',express.static(store.imagesDir,{immutable:true,maxAge:'1y',dotfiles:'deny'}));
  app.use(express.static(path.join(config.root,'public'),{dotfiles:'deny'}));
  app.use((error,_req,res,_next)=>{const status=error instanceof z.ZodError?400:error.status||400;res.status(status).json({error:error instanceof z.ZodError?'请求参数格式不正确':status===413?'文件过大':error.message||'请求失败'});});
  return {app,store,skills,shutdown(){for(const c of controllers.values())c.abort();}};
}
