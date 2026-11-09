import express from 'express';
import path from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import sharp from 'sharp';
import { z } from 'zod';
import { Store, MAX_REFERENCE_IMAGES } from './store.js';
import { Skills } from './skills.js';
import { createLiveRuntime, runAgent, runDemo } from './agent.js';
import { listConnectors } from './connectors.js';
import { ModelSettings } from './model-settings.js';
import { getAdapter } from './adapters.js';
import { isProductSkill, productPatchSchema, productSizes, syncProduct, updateProduct } from './product.js';
import { registerDesignRoutes } from './design/routes.js';
import {createDocument,designTurnSchema,designError} from './design/document.js';
import {imageTargetSchema,imageGenerationSchema} from './image-target.js';
import {generationSettings,imageGenerationPlan} from '../shared/image-generation.js';
import {composeImageSchema,composeLogoOnImage} from './image-compose.js';
import {preservingResizeRequest,runPreservingResize} from './image-resize.js';
import {registerImagePdfRoute} from './image-pdf.js';

const sizes=productSizes;
export function createApp(config, overrides={}) {
  const store=new Store(config.dataDir);
  const skills=new Skills([path.join(config.root,'skills'),...(config.skillsDir?[config.skillsDir]:[])],path.join(config.dataDir,'skills'));
  const app=express(), token=randomBytes(24).toString('hex'), controllers=new Map(), stoppers=new Map();
  const imageOperations=new Set();
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
  const busy=s=>{if(s.job?.status==='running'||imageOperations.has(s.id))throw Object.assign(new Error('本轮或图片操作仍在执行，请等待完成后再操作'),{status:409});};
  app.disable('x-powered-by');
  app.use((req,res,next)=>{
    const host=req.hostname;
    if(!['127.0.0.1','localhost','[::1]'].includes(host)) return res.status(403).json({error:'仅允许本地访问'});
    res.set({'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});
    if(config.frontend!=='next'||req.path.startsWith('/api/')||req.path.startsWith('/images/')||req.path.startsWith('/legacy'))res.set({'Content-Security-Policy':"default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'"});
    if(req.path.startsWith('/api/')) res.set('Cache-Control','no-store');
    if(!['GET','HEAD','OPTIONS'].includes(req.method)) {
      if(req.get('X-Studio-Token')!==token) return res.status(403).json({error:'页面访问令牌已失效，请刷新页面'});
      if(req.get('origin') && req.get('origin')!==`${req.protocol}://${req.get('host')}`) return res.status(403).json({error:'禁止跨站请求'});
    }
    next();
  });
  app.use(express.json({limit:'15mb'}));
  registerImagePdfRoute(app);
  app.get('/api/config',(_req,res)=>res.json({token,mode:config.demo?'demo':'live',editableDesign:!config.demo,agentModel:config.agentModel,imageModel:config.imageModel,imageBaseURL:config.imageBaseURL,providers:{conversation:modelSettings.routeInfo('conversation'),image:modelSettings.routeInfo('image')},imageSize:config.imageSize||'auto',maxImages:Number.isFinite(config.maxImages)?config.maxImages:'unlimited',maxReferenceImages:MAX_REFERENCE_IMAGES,maxTurns:config.maxTurns===null?'unlimited':config.maxTurns,sandboxMode:config.sandboxMode}));
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
    const body=z.object({skillId:z.string().nullable().optional(),selectedId:z.string().nullable().optional(),referenceIds:z.array(z.string()).max(MAX_REFERENCE_IMAGES).refine(ids=>new Set(ids).size===ids.length).optional(),size:z.enum(sizes).optional(),imageTarget:imageTargetSchema.nullable().optional(),imageGeneration:imageGenerationSchema.optional(),title:z.string().min(1).max(60).optional(),product:productPatchSchema.optional()}).strict().parse(req.body);
    const skill=Object.hasOwn(body,'skillId')?skills.get(body.skillId):skills.list().find(skill=>skill.id===s.skillId);
    if(body.product&&!isProductSkill(skill))throw Object.assign(new Error('商品资料仅适用于商品推广设计技能'),{status:400});
    if(body.selectedId) store.image(s,body.selectedId);
    const changingGeneration=Object.hasOwn(body,'imageTarget')||Object.hasOwn(body,'imageGeneration');
    const chosen=body.selectedId?s.versions.find(v=>v.id===body.selectedId):null;
    if(chosen&&chosen.kind!=='upload'&&!Object.hasOwn(body,'imageGeneration'))body.imageGeneration=generationSettings(chosen.imageGeneration);
    if(chosen&&chosen.kind!=='upload'&&!Object.hasOwn(body,'imageTarget'))body.imageTarget=structuredClone(chosen.imageTarget??null);
    if(body.imageTarget===null&&!body.imageGeneration)body.imageGeneration={...generationSettings(s.imageGeneration),resolution:'auto'};
    if(changingGeneration){
      try{imageGenerationPlan(Object.hasOwn(body,'imageTarget')?body.imageTarget:s.imageTarget,body.imageGeneration||s.imageGeneration,config.imageModel,config.imageSize,config.imageBaseURL);}
      catch(error){throw Object.assign(error,{status:400});}
    }
    if(body.referenceIds)for(const id of body.referenceIds){
      const {version}=store.image(s,id);
      if(version.demo)throw new Error('演示图片不可用作参考图，请上传真实图片或生成新图');
    }
    const references=body.referenceIds?[...body.referenceIds]:[...s.referenceIds];
    if(body.selectedId&&store.image(s,body.selectedId).version.kind==='upload'&&!references.includes(body.selectedId)){
      if(Object.hasOwn(body,'referenceIds'))throw new Error('选中的原始图片必须包含在参考图中');
      if(references.length>=MAX_REFERENCE_IMAGES)throw new Error(`最多参考 ${MAX_REFERENCE_IMAGES} 张图片，请先移除不需要的参考图`);
      references.push(body.selectedId);
    }
    const {product,...patch}=body;
    patch.referenceIds=body.selectedId===null&&!Object.hasOwn(body,'referenceIds')?[]:references;
    if(!Object.hasOwn(body,'selectedId')&&body.referenceIds&&s.versions.find(v=>v.id===s.selectedId)?.kind==='upload'&&!references.includes(s.selectedId))patch.selectedId=references.at(-1)||null;
    if(Object.hasOwn(patch,'skillId')&&patch.skillId!==s.skillId)s.product=null;
    Object.assign(s,patch);
    if(body.selectedId&&!Object.hasOwn(body,'imageTarget')){
      const version=s.versions.find(v=>v.id===body.selectedId);
      if(version.kind!=='upload')s.imageTarget=structuredClone(version.imageTarget??null);
    }
    if(patch.selectedId===null)s.product=null;
    if(isProductSkill(skill)&&(s.selectedId||product))syncProduct(s,{restoreVersion:Object.hasOwn(patch,'selectedId')});
    if(product)updateProduct(s,product);
    store.save(s);res.json(s);
  });

  app.post('/api/sessions/:id/upload',async(req,res)=>{
    const s=store.get(req.params.id);busy(s);
    const {data,name,purpose}=z.object({data:z.string().max(14000000),name:z.string().max(150),purpose:z.enum(['reference','asset']).default('reference')}).parse(req.body);
    if(purpose==='reference'&&s.referenceIds.length>=MAX_REFERENCE_IMAGES)throw new Error(`最多参考 ${MAX_REFERENCE_IMAGES} 张图片，请先移除不需要的参考图`);
    if(!/^data:image\/(png|jpeg|webp);base64,/.test(data)) throw Object.assign(new Error('支持 PNG、JPEG、WebP 图片'),{status:400});
    const input=Buffer.from(data.split(',')[1],'base64');
    if(input.length>10*1024*1024) throw Object.assign(new Error('图片最大 10 MB'),{status:400});
    let bytes,info;
    try { const image=sharp(input,{limitInputPixels:25000000}).rotate(); bytes=await image.png().toBuffer();info=await sharp(bytes).metadata(); }
    catch { throw Object.assign(new Error('图片无效或超过 2500 万像素'),{status:400}); }
    busy(s); // another request may have started a turn while the decoder was awaiting
    const version=store.addImage(s,bytes,{label:name,parentId:null,skillId:null,width:info.width,height:info.height,kind:'upload',demo:false},{reference:purpose==='reference'});
    // Keep the established product record when a second/third reference is
    // uploaded; the latest attachment may be a font, layout, or copy sample.
    if(purpose==='reference'&&isProductSkill(skills.list().find(skill=>skill.id===s.skillId))&&!s.product?.sourceId){syncProduct(s);store.save(s);}
    res.status(201).json({session:s,version});
  });
  app.post('/api/sessions/:id/compose',async(req,res)=>{
    const session=store.get(req.params.id);busy(session);
    const options=composeImageSchema.parse(req.body);
    imageOperations.add(session.id);
    try{
      const version=await composeLogoOnImage({session,store,...options});
      session.imageTarget=structuredClone(version.imageTarget??null);store.save(session);
      res.status(201).json({session,version});
    }finally{imageOperations.delete(session.id);}
  });
  app.post('/api/sessions/:id/turns',(req,res)=>{
    const s=store.get(req.params.id);
    const {text,requestId,design}=z.object({text:z.string().trim().min(1).max(12000),requestId:z.string().uuid(),design:designTurnSchema.optional()}).parse(req.body);
    if(s.requests.includes(requestId)) return res.json({session:s,duplicate:true});
    busy(s);const skill=skills.get(s.skillId);
    if(design){
      if(config.demo)throw designError('当前为演示模式，AI 设计未启用。请配置创作引擎后重启；本次未调用模型',503);
      const record=documents.get(s.id);
      if((record?.revision??null)!==design.revision)throw designError('设计稿已更新，请刷新后再发起 AI 修改',409);
      createDocument(design.canvas);
      if(record){const p=design.pageId?record.document.pages.find(p=>p.id===design.pageId):record.document.pages[0];if(!p)throw designError('当前页面不存在',404);if(p.unit!==design.canvas.unit||Math.abs(p.width-design.canvas.width)>.00001||Math.abs(p.height-design.canvas.height)>.00001)throw designError('画布尺寸已变化，请先保存画布设置');}
      else if(design.pageId)throw designError('尚无设计稿，不能指定页面');
      for(const id of design.referenceIds){const image=s.versions.find(v=>v.id===id);if(!image||image.demo)throw designError('AI 参考图必须来自当前会话的真实素材');}
    }
    if(!design&&isProductSkill(skill))syncProduct(s);
    if(!design&&!config.demo && s.selectedId && store.image(s,s.selectedId).version.demo) throw Object.assign(new Error('当前为演示图片，请上传真实图片，或通过输入框上方的 × 取消选中图片后再生成。'),{status:400});
    const referenceIds=[...(design?design.referenceIds:s.referenceIds)];
    const resizeRequest=!design?preservingResizeRequest(text):null;
    const resizeSourceId=resizeRequest&&referenceIds.length<=1?referenceIds[0]||s.selectedId:null;
    const message={id:randomUUID(),role:'user',text,skillId:skill?.id||null,skillName:skill?.name||null,sourceId:s.selectedId,referenceIds,createdAt:new Date().toISOString(),...(design?{outputMode:'design'}:{})};
    s.messages.push(message);s.requests.push(requestId);
    if(s.messages.filter(m=>m.role==='user').length===1)s.title=text.slice(0,28);
    const job={id:randomUUID(),status:'running',events:[],imageCalls:0,userMessageId:message.id,referenceIds,createdAt:new Date().toISOString(),skillId:skill?.id||null,skillVersion:skill?.version||null,models:{agent:config.agentModel,image:config.imageModel},providers:{agent:modelSettings.routeInfo('conversation'),image:modelSettings.routeInfo('image')},usage:[],...(!design&&skill?.workflow==='logo-design'?{logoRevision:documents.get(s.id)?.revision??null}:{}),productSourceId:!design&&isProductSkill(skill)?s.product.sourceId:null,...(design?{outputMode:'design',designRevision:design.revision,designCanvas:design.canvas,designPageId:design.pageId||documents.get(s.id)?.document.pages[0]?.id}:{})};
    s.job=job;s.referenceIds=s.referenceIds.filter(id=>!referenceIds.includes(id));store.save(s);
    const controller=new AbortController();controllers.set(s.id,controller);
    const turnTimeoutMs=Number.isFinite(config.turnTimeoutMs)&&config.turnTimeoutMs>0?config.turnTimeoutMs:900000;
    const imageGraceMs=Number.isFinite(config.imageGraceMs)&&config.imageGraceMs>0?config.imageGraceMs:300000;
    const settleGraceMs=Number.isFinite(config.settleGraceMs)&&config.settleGraceMs>0?config.settleGraceMs:30000;
    const durationLabel=ms=>ms%60000===0?`${ms/60000} 分钟`:ms%1000===0?`${ms/1000} 秒`:`${ms} 毫秒`;
    const timeoutLabel=durationLabel(turnTimeoutMs);
    const retained=design?'已有设计版本会保留。':'已返回的图片会保留。';
    const timeoutText=design?`本轮 AI 设计执行超时（${timeoutLabel}），已中止。${retained}`:`本轮执行超时（${timeoutLabel}），已中止。${retained}，已提交的 API 请求不保证取消计费。`;
    const cancelText=design?'本轮 AI 设计已停止，已保存的设计版本保留。':`本轮已停止。${retained}，已提交的 API 请求不保证取消计费。`;
    // 模型或图片接口可能不响应 abort signal。停止后无论如何都要收尾，
    // 否则 job 会永远停在 running，会话被 busy 检查永久锁死。
    let finished=false,timer=null,guard=null,extended=false;
    const persist=(status,{text,isError=false}={})=>{
      if(finished)return false;
      finished=true;clearTimeout(timer);clearTimeout(guard);
      if(controllers.get(s.id)===controller)controllers.delete(s.id);
      if(stoppers.get(s.id)===stop)stoppers.delete(s.id);
      job.status=status;job.finishedAt=new Date().toISOString();
      if(text){if(isError)job.error=text;s.messages.push({id:randomUUID(),role:'assistant',text,error:isError,events:[...job.events],task:job,createdAt:new Date().toISOString()});}
      store.save(s);return true;
    };
    const finishRunningUsage=()=>{
      for(const call of job.usage||[])if(call.status==='running'){
        call.finishedAt=new Date().toISOString();
        call.durationMs=Date.parse(call.finishedAt)-Date.parse(call.startedAt);
        call.status='cancelled';
      }
    };
    const forceClose=why=>{
      if(finished)return;
      const timedOut=controller.signal.reason?.code==='TURN_TIMEOUT';
      console.error(`[turn ${job.id}] ${why}（${timedOut?'执行超时':'已停止'}），强制收尾，释放会话`);
      finishRunningUsage();
      persist('cancelled',{text:timedOut?timeoutText:cancelText,isError:true});
    };
    const stop=kind=>{
      if(finished)return;
      controller.abort(Object.assign(new Error(kind==='timeout'?`执行超时（${timeoutLabel}）`:'用户停止本轮'),{code:kind==='timeout'?'TURN_TIMEOUT':'USER_CANCEL'}));
      clearTimeout(timer);clearTimeout(guard);
      guard=setTimeout(()=>forceClose('中止后底层请求仍未结束'),settleGraceMs);guard.unref?.();
    };
    stoppers.set(s.id,stop);
    const onDeadline=()=>{
      if(finished)return;
      // 生图请求已发出、正在等结果时先把时限顺延一次，避免掐掉已经计费的一次生图。
      if(!extended&&(job.usage||[]).some(call=>call.kind==='image'&&call.status==='running')){
        extended=true;
        console.warn(`[turn ${job.id}] 已达单轮时限 ${timeoutLabel}，但生图请求仍在执行，延长 ${durationLabel(imageGraceMs)}`);
        timer=setTimeout(onDeadline,imageGraceMs);timer.unref?.();return;
      }
      console.error(`[turn ${job.id}] 单轮执行超时（${timeoutLabel}），已中止。usage=${JSON.stringify((job.usage||[]).map(call=>({kind:call.kind,status:call.status,responses:(call.responses||[]).length})))}`);
      stop('timeout');
    };
    timer=setTimeout(onDeadline,turnTimeoutMs);timer.unref?.();
    const emit=(type,data)=>{job.events.push({id:randomUUID(),type,...data,at:new Date().toISOString()});store.save(s);};
    res.status(202).json({session:s});
    const execute=resizeRequest&&resizeSourceId
      ?args=>runPreservingResize({...args,request:resizeRequest,sourceId:resizeSourceId})
      :overrides.execute || (config.demo?runDemo:runAgent);
    Promise.resolve().then(()=>execute({session:s,skill,skills,store,documents,config,runtime,emit,signal:controller.signal,prompt:text,job})).then(reply=>{
      controller.signal.throwIfAborted();
      if(!persist('completed',{text:reply}))console.warn(`[turn ${job.id}] 已收尾，忽略迟到的成功结果`);
    }).catch(error=>{
      if(finished){console.warn(`[turn ${job.id}] 已收尾，忽略迟到的错误：${error?.message||error}`);return;}
      const aborted=controller.signal.aborted,timedOut=aborted&&controller.signal.reason?.code==='TURN_TIMEOUT',code=error?.status;
      const safeDetail=String(error?.message||'').replace(/Bearer\s+[^\s]+/gi,'Bearer [redacted]').slice(0,500);
      if(aborted)console.warn(`[turn ${job.id}] 本轮${timedOut?'超时':'中止'}：${safeDetail}`);else console.error(`[turn ${job.id}]`,error);
      const upstreamDetail=String(error?.error?.message||safeDetail||'');
      const text=aborted?(timedOut?timeoutText:cancelText):error?.name==='MaxTurnsExceededError'?`本轮步骤过多，Agent 未能在回合上限内完成。请缩小一次任务的范围后继续。${retained}`:code===401?'API Key 无效，请检查服务端配置。':code===403&&/(quota|insufficient|余额|额度|preconsumed)/i.test(upstreamDetail)?'API 余额或额度不足（403），请充值或更换有余额的中转站。':code===403?'接口拒绝请求（403），请检查当前模型权限或中转站配置。':code===429?'API 额度或频率限制，请检查账号后重试。':code===400?`请求参数被接口拒绝（400）：${safeDetail||'未返回详细原因'}。请检查模型、Skill 工具参数或接口兼容性。${retained}`:`本轮未完成（${code||error?.name||'执行错误'}）。请检查模型权限、网络或技能依赖；${retained}`;
      persist(aborted?'cancelled':'failed',{text,isError:true});
    });
  });
  app.post('/api/sessions/:id/cancel',(req,res)=>{store.get(req.params.id);const stop=stoppers.get(req.params.id);if(stop)stop('user');else controllers.get(req.params.id)?.abort();res.json({ok:true});});
  const documents=registerDesignRoutes(app,store);
  app.use('/images',express.static(store.imagesDir,{immutable:true,maxAge:'1y',dotfiles:'deny'}));
  app.use('/legacy',express.static(path.join(config.root,'public'),{dotfiles:'deny'}));
  if(config.frontend!=='next')app.use(express.static(path.join(config.root,'public'),{dotfiles:'deny'}));
  app.use((error,_req,res,_next)=>{const status=error instanceof z.ZodError?400:error.status||400;res.status(status).json({error:error instanceof z.ZodError?error.issues.find(i=>i.path[0]==='imageTarget'&&i.code==='custom')?.message||'请求参数格式不正确':status===413?'文件过大':error.message||'请求失败'});});
  return {app,store,skills,documents,shutdown(){for(const c of controllers.values())c.abort();}};
}
