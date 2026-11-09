import {z} from 'zod';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {DocumentStore} from './store.js';
import {createDocument,designError,documentSchema,designCanvasSchema,backgroundSchema} from './document.js';
import {layoutDocument,renderPreview,renderPdf,designCapabilities,editorTextLayers} from './render.js';
import {validateDesignAssets} from './operations.js';
import {paginateDesign,paginationOptionsSchema} from './pagination.js';
import {PrintProfiles,MAX_PROFILE_BYTES} from './profiles.js';
import {exportSettingsSchema,exportReport,assertExportReport,validateExportSettings,pageGeometry} from './export-settings.js';
import {isVectorExport,buildVectorScene,renderVector,vectorPreview} from './vector.js';
import {printImageSource} from './print-source.js';

const revision=z.number().int().positive();
const creation=z.object({title:z.string().trim().min(1).max(100).optional(),width:z.number().positive().max(20000).optional(),height:z.number().positive().max(20000).optional(),unit:z.enum(['px','mm']).optional(),background:backgroundSchema.optional()}).strict();
const exportSchema=exportSettingsSchema;
const imageExportSchema=exportSchema.omit({revision:true,versionId:true,pageId:true,pageIds:true}).extend({imageId:z.string().uuid(),width:creation.shape.width,height:creation.shape.height,unit:creation.shape.unit});
const previewPageId=z.string().min(1).max(80).optional();

export function registerDesignRoutes(app,store){
  const profiles=new PrintProfiles(store.root),documents=new DocumentStore(store.root),base='/api/sessions/:id/design';
  const session=req=>store.get(req.params.id);
  const response=(record,s)=>({design:documents.view(record),assets:s.versions.filter(v=>!v.demo).map(v=>({id:v.id,name:v.label||'图片',url:v.url,width:v.width,height:v.height,kind:v.kind}))});
  const prepare=async(req,record,{printReady=false,highQualityPdf=false}={})=>{
    const s=session(req),document=structuredClone(record.document);
    return layoutDocument(document,id=>printReady?printImageSource(store,s,id):highQualityPdf?printImageSource(store,s,id,{preferWorkingPixels:true}):store.image(s,id).bytes);
  };
  const imageDocument=async(s,imageId,options={},printPpi=null,highQualityPdf=false)=>{
    const image=s.versions.find(v=>v.id===imageId);
    if(!image)throw designError('图片不属于当前会话',404);
    if(image.demo)throw designError('演示图片不能作为真实作品导出或导入设计稿');
    const working=store.image(s,imageId).bytes,workingInfo=await sharp(working,{limitInputPixels:25000000}).metadata();
    const bytes=printPpi?await printImageSource(store,s,imageId):highQualityPdf?await printImageSource(store,s,imageId,{preferWorkingPixels:true}):working;
    const info=bytes===working?workingInfo:await sharp(bytes,{limitInputPixels:25000000}).metadata();
    const dimensions=printPpi?{width:info.width*25.4/printPpi,height:info.height*25.4/printPpi,unit:'mm'}:{width:workingInfo.width,height:workingInfo.height,unit:'px'};
    const document=createDocument({title:s.title.slice(0,100),...dimensions,background:info.hasAlpha?'transparent':'#ffffff',...options});
    const p=document.pages[0];
    p.id=`image-${imageId}`;
    p.objects.push({id:randomUUID(),type:'image',assetId:imageId,x:0,y:0,width:p.width,height:p.height,fit:'contain'});
    return {document,bytes,info};
  };
  app.get('/api/design/capabilities',async(_req,res)=>res.json(await designCapabilities()));
  app.get(base,(req,res)=>{const s=session(req);res.json(response(documents.get(s.id),s));});
  app.post(base,async(req,res)=>{
    const s=session(req),{sourceId,...options}=creation.extend({sourceId:z.string().uuid().optional()}).parse(req.body);
    const record=sourceId?documents.createFromDocument(s.id,(await imageDocument(s,sourceId,options)).document):documents.create(s.id,options);
    res.status(201).json(response(record,s));
  });
  app.get('/api/design/profiles',async(_req,res)=>res.json(await profiles.list()));
  app.post('/api/design/profiles',async(req,res)=>{
    const body=z.object({name:z.string().trim().min(1).max(100).optional(),description:z.string().trim().max(200).optional(),data:z.string().min(1).max(Math.ceil(MAX_PROFILE_BYTES/3)*4).regex(/^[A-Za-z0-9+/]+={0,2}$/)}).strict().parse(req.body);
    const bytes=Buffer.from(body.data,'base64');if(bytes.toString('base64')!==body.data)throw designError('ICC 文件编码无效');
    res.status(201).json(await profiles.import(bytes,body));
  });
  const inspect=async(layout,body,metadata)=>{
    validateExportSettings(body);
    const profile=body.colorSpace==='cmyk'?await profiles.resolve(body.print?.profileId):null;
    const report=exportReport(layout,body,{...metadata,profile});
    const vectorScene=isVectorExport(body)&&report.canExport?await buildVectorScene(layout,body):null;
    if(vectorScene)report.vector={pathCount:vectorScene.pathCount,imageCount:vectorScene.imageCount,outlinedText:true,approximate:vectorScene.imageCount>0};
    return {profile,report,vectorScene};
  };
  const sendFile=(res,body,layout,result,report,metadata)=>{
    const extension=body.format==='jpeg'?'jpg':body.format;
    const numbers=report.pages.map(p=>p.number).join('-'),suffix=metadata.imageId?`image-${metadata.imageId.slice(0,8)}`:body.versionId?`v-${body.versionId.slice(0,8)}`:`r${report.revision}`;
    const filename=`${layout.document.title}-${suffix}-p${numbers}-${body.colorSpace}.${extension}`;
    const mime={pdf:'application/pdf',svg:'image/svg+xml',eps:'application/postscript',ai:'application/postscript'}[body.format]||`image/${body.format}`;
    res.set({'Content-Type':mime,'Content-Disposition':`attachment; filename="canvas-design.${extension}"; filename*=UTF-8''${encodeURIComponent(filename)}`,'X-Design-Color-Space':body.colorSpace,'X-Design-Page-Count':String(report.pages.length),...(report.revision?{'X-Design-Revision':String(report.revision)}:{}),...(metadata.imageId?{'X-Image-Source':metadata.imageId}:{}),...(result.verification?{'X-Design-Print-Verified':'true'}:{}),...(result.vector?{'X-Design-Vector-Paths':String(result.vector.pathCount)}:{})}).send(result.bytes);
  };
  const sendPrintPreview=async(res,body,layout,report)=>{
    if(body.format!=='pdf'||body.colorSpace!=='cmyk'||!body.print)throw designError('裁切预览需要印刷 PDF 设置');
    const id=body.previewPageId||report.pages[0].id;
    if(!report.pages.some(p=>p.id===id))throw designError('预览页面不在所选下载范围内',404);
    const page=layout.pages.find(p=>p.id===id),g=pageGeometry(page,body.print),scale=Math.min(1,1400/(Math.max(g.width,g.height)/72*96));
    const result=await renderPreview(layout,{pageId:id,scale,print:body.print,allowErrors:true});
    res.set('Cache-Control','no-store').json({pageId:id,revision:report.revision,width:result.width,height:result.height,geometry:result.geometry,dataUrl:`data:image/png;base64,${result.bytes.toString('base64')}`});
  };
  // Snapshot the source before awaiting layout. Checks and downloads use the same contracts.
  const imageExport=async(req,res,action)=>{
    const s=session(req),body=(action==='preview'?imageExportSchema.extend({previewPageId}):imageExportSchema).parse(req.body);validateExportSettings(body);
    const options=Object.fromEntries(['width','height','unit'].filter(key=>body[key]!==undefined).map(key=>[key,body[key]]));
    const {document,bytes,info}=await imageDocument(s,body.imageId,options,body.printReady?body.dpi||300:null,body.format==='pdf'&&!isVectorExport(body)),layout=await layoutDocument(document,()=>bytes),p=document.pages[0];
    const {profile,report,vectorScene}=await inspect(layout,body,{revision:null});
    if(action==='preview'&&isVectorExport(body)){
      if(!vectorScene)throw designError('请先处理文件检查中的错误',422,report.issues);
      return res.set('Cache-Control','no-store').json(await vectorPreview(vectorScene));
    }
    if(action==='preview')return sendPrintPreview(res,body,layout,report);
    if(action==='check')return res.json(report);
    assertExportReport(report,body);
    const nativeSize=body.dpi===undefined&&body.scale===1&&p.unit==='px'&&p.width===info.width&&p.height===info.height;
    let result;
    if(vectorScene)result=await renderVector(vectorScene,body.format);
    else if(nativeSize&&body.format==='png')result={bytes};
    else if(nativeSize&&body.format==='jpeg')result={bytes:await sharp(bytes).flatten({background:'#ffffff'}).withIccProfile('srgb').withMetadata({density:96}).jpeg({quality:100,chromaSubsampling:'4:4:4'}).toBuffer()};
    else if(body.format==='pdf')result=await renderPdf(layout,{...body,profile});
    else result=await renderPreview(layout,body);
    sendFile(res,body,layout,result,report,{imageId:body.imageId});
  };
  app.post(base+'/export-image-check',(req,res)=>imageExport(req,res,'check'));
  app.post(base+'/export-image-preview',(req,res)=>imageExport(req,res,'preview'));
  app.post(base+'/export-image',(req,res)=>imageExport(req,res,'export'));
  app.post(base+'/paginate',async(req,res)=>{
    const s=session(req),body=z.object({revision:revision.nullable(),canvas:designCanvasSchema,options:paginationOptionsSchema}).strict().parse(req.body);
    const current=documents.get(s.id);
    if((current?.revision??null)!==body.revision)throw designError('设计稿已更新，请重新载入后分页',409);
    const result=paginateDesign(body.canvas,body.options,current?.document);
    validateDesignAssets(result.document,s);
    const layout=await layoutDocument(result.document,id=>store.image(s,id).bytes);
    const errors=layout.issues.filter(i=>i.severity==='error'&&i.code!=='unconfirmed_content');
    if(errors.length)throw designError('分页校验未通过，未保存任何页面',422,errors);
    const record=documents.commit(s.id,result.document,body.revision,'自动分页');
    res.status(201).json({...response(record,s),addedPageIds:result.pageIds});
  });
  app.put(base,(req,res)=>{
    const s=session(req),body=z.object({revision,document:z.unknown()}).strict().parse(req.body);
    // Parse first so malformed objects cannot reach asset traversal.
    const record=documents.require(s.id);documents.check(record,body.revision);
    const parsed=documentSchema.parse(body.document);validateDesignAssets(parsed,s);
    res.json(response(documents.update(s.id,parsed,body.revision),s));
  });
  app.post(base+'/editor-text',async(req,res)=>{
    const s=session(req),body=z.object({revision,pageId:z.string().min(1).max(80),document:documentSchema}).strict().parse(req.body);
    documents.check(documents.require(s.id),body.revision);validateDesignAssets(body.document,s);
    if(!body.document.pages.some(p=>p.id===body.pageId))throw designError('页面不存在',404);
    // A read-only draft render. Invalid layout can still be inspected and fixed;
    // malformed schemas and foreign assets cannot reach rendering.
    const page=body.document.pages.find(p=>p.id===body.pageId);
    const layout=await layoutDocument({...body.document,pages:[page]},id=>store.image(s,id).bytes);
    res.set('Cache-Control','no-store').json({revision:body.revision,...editorTextLayers(layout,body.pageId)});
  });
  app.post(base+'/versions',(req,res)=>{
    const s=session(req),body=z.object({revision,label:z.string().trim().min(1).max(100).default('保存设计版本')}).strict().parse(req.body);
    res.status(201).json(response(documents.snapshot(s.id,body.revision,body.label),s));
  });
  app.post(base+'/restore',(req,res)=>{
    const s=session(req),body=z.object({revision,versionId:z.string().uuid()}).strict().parse(req.body);
    res.json(response(documents.restore(s.id,body.revision,body.versionId),s));
  });
  app.get(base+'/preflight',async(req,res)=>{
    const s=session(req),record=documents.require(s.id),layout=await prepare(req,record);
    res.json({revision:record.revision,issues:layout.issues,font:layout.fontName,pages:layout.pages.map(p=>({id:p.id,widthPoints:p.width,heightPoints:p.height}))});
  });
  app.get(base+'/preview',async(req,res)=>{
    const s=session(req),record=documents.require(s.id);
    if(req.query.revision!==undefined&&Number(req.query.revision)!==record.revision)throw designError('预览版本已更新，请重新加载',409);
    const pageId=z.string().max(80).optional().parse(req.query.pageId);
    const layout=await prepare(req,record),page=layout.pages.find(p=>p.id===pageId)||layout.pages[0];
    const scale=Math.min(1,1400/(Math.max(page.width,page.height)/72*96));
    const result=await renderPreview(layout,{pageId,scale,allowErrors:true});
    res.set({'Content-Type':'image/png','Cache-Control':'no-store','X-Design-Revision':String(record.revision)}).send(result.bytes);
  });
  const documentExport=async(req,res,action)=>{
    const s=session(req),body=(action==='preview'?exportSchema.extend({previewPageId}):exportSchema).parse(req.body),record=documents.require(s.id);documents.check(record,body.revision);validateExportSettings(body);
    const version=body.versionId?record.versions.find(v=>v.id===body.versionId):null;
    if(body.versionId&&!version)throw designError('设计版本不存在',404);
    const document=structuredClone(version?.document||record.document),layout=await prepare(req,{document},{printReady:body.printReady,highQualityPdf:body.format==='pdf'&&!isVectorExport(body)});
    const {profile,report,vectorScene}=await inspect(layout,body,{revision:record.revision,versionId:body.versionId});
    if(action==='preview'&&isVectorExport(body)){
      if(!vectorScene)throw designError('请先处理文件检查中的错误',422,report.issues);
      return res.set('Cache-Control','no-store').json(await vectorPreview(vectorScene));
    }
    if(action==='preview')return sendPrintPreview(res,body,layout,report);
    if(action==='check')return res.json(report);
    assertExportReport(report,body);
    const result=vectorScene?await renderVector(vectorScene,body.format):body.format==='pdf'?await renderPdf(layout,{...body,profile}):await renderPreview(layout,body);
    sendFile(res,body,layout,result,report,{});
  };
  app.post(base+'/export-check',(req,res)=>documentExport(req,res,'check'));
  app.post(base+'/export-preview',(req,res)=>documentExport(req,res,'preview'));
  app.post(base+'/export',(req,res)=>documentExport(req,res,'export'));
  return documents;
}
