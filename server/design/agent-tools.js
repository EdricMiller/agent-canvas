import {tool} from '@openai/agents';
import {z} from 'zod';
import {documentSchema,documentInputSchema,designError} from './document.js';
import {layoutDocument} from './render.js';
import {paginateDesign,paginationOptionsSchema} from './pagination.js';
import {applyDesignChanges,designChangesSchema,validateDesignAssets,contentChangeSchema,pageSizeSchema} from './operations.js';

export function createDesignAgentTools({session,store,documents,job,signal,emit}){
  const current=()=>{
    signal.throwIfAborted();const record=documents.get(session.id);
    if((record?.revision??null)!==job.designRevision)throw designError('设计稿已被其他窗口修改，本轮不能覆盖，请刷新后重新发起',409);
    return record;
  };
  const guarded=fn=>async input=>{
    try{return await fn(input);}catch(error){
      if(signal.aborted)throw error;
      const issues=error instanceof z.ZodError?error.issues.map(i=>({path:i.path.join('.'),message:i.message})):error.details;
      const message=error instanceof z.ZodError?'设计数据格式不正确，请根据 issues 修正':error.message;
      emit('design_validation',{text:message});return {saved:false,error:message,...(issues?{issues}:{}),conflict:error.status===409};
    }
  };
  const commit=async(input,label)=>{
    if(job.designResult)throw designError('本轮设计已保存，请交付当前结果，等待用户下一条修改请求');
    current();const document=documentSchema.parse(input);
    validateDesignAssets(document,session);
    const layout=await layoutDocument(document,id=>store.image(session,id).bytes);
    const errors=layout.issues.filter(i=>i.severity==='error'&&i.code!=='unconfirmed_content');
    if(errors.length)throw designError('排版校验未通过，尚未保存。请修正问题后再提交',422,errors);
    signal.throwIfAborted();
    const record=documents.commit(session.id,document,job.designRevision,label);
    job.designRevision=record.revision;
    const activePage=document.pages.find(page=>page.id===job.designPageId)||document.pages[0];
    job.designPageId=activePage.id;
    job.designCanvas={title:document.title,width:activePage.width,height:activePage.height,unit:activePage.unit,background:activePage.background};
    job.designResult={documentId:record.id,revision:record.revision,versionId:record.versions.at(-1).id,pageId:activePage.id,pageCount:document.pages.length,objectCount:document.pages.reduce((sum,p)=>sum+p.objects.length,0),pendingContentCount:(document.content||[]).filter(f=>f.status==='needs_confirmation').length};
    emit('design_saved',{text:`可编辑设计稿已保存，含 ${job.designResult.pageCount} 页、${job.designResult.objectCount} 个独立对象${job.designResult.pendingContentCount?`，${job.designResult.pendingContentCount} 项内容待核对`:''}`,revision:record.revision});
    return {saved:true,...job.designResult,canvas:job.designCanvas,issues:layout.issues,next:'直接交付本轮设计，说明尺寸与待核对内容。不要再次保存或生成位图。'};
  };
  return [
    tool({name:'create_paginated_design',description:'将清单、价目表等重复条目按实际文字高度自动分栏分页；标题和原始 Logo 在各页重复。pageSize 可指定用户本轮要求的宽高与单位，省略则沿用当前 canvas。已有稿件时只追加页面，保留原页面。最多整册 20 页，条目无法完整放下时不保存。需要复杂自由排版时用其他设计工具。',parameters:paginationOptionsSchema.extend({pageSize:pageSizeSchema.nullish(),label:z.string().trim().min(1).max(100)}),execute:guarded(async({label,pageSize,...options})=>{
      const result=paginateDesign({...job.designCanvas,...pageSize},options,current()?.document);
      return {...await commit(result.document,label),addedPageIds:result.pageIds,rowCount:result.rowCount};
    })}),
    tool({name:'read_design_document',description:'读取当前可编辑设计稿、内容字段、稳定对象 ID、画布尺寸和可用图片。生成或修改前先读取。',parameters:z.object({}).strict(),execute:guarded(async()=>({design:documents.view(current()),canvas:job.designCanvas,activePageId:job.designPageId||current()?.document.pages[0]?.id||null,assets:session.versions.filter(v=>!v.demo).map(({id,label,width,height})=>({id,name:label,width,height})),referenceIds:job.referenceIds}))}),
    tool({name:'create_design_document',description:'首次创建 1 至 20 页可编辑设计稿。文字、Logo、色块分别保存；所有文字需绑定 content 字段。用户本轮明确指定宽高时，直接使用该尺寸填写 pages 的 width、height、unit；未指定时沿用当前 canvas。已有稿件请使用修改工具。服务端校验通过才保存。',parameters:z.object({document:documentInputSchema,label:z.string().trim().min(1).max(100)}).strict(),execute:guarded(async({document,label})=>{
      if(current())throw designError('已有设计稿，请通过 apply_design_changes 修改指定对象，不要覆盖整份稿件');
      if(document.pages.some(p=>p.objects.some(o=>o.type==='text'&&!o.bindingId)))throw designError('新设计的文字必须通过 bindingId 绑定 content 内容字段');
      return commit(document,label);
    })}),
    tool({name:'update_design_content',description:'修改已有内容字段，如菜名、价格、营业时间。只提交指定字段的新值和核对状态；系统同步所有绑定文字，其他对象与布局保持不变。',parameters:z.object({changes:z.array(contentChangeSchema).min(1).max(1000),label:z.string().trim().min(1).max(100)}).strict(),execute:guarded(async({changes,label})=>{
      const record=current();if(!record)throw designError('尚无设计稿，请先创建');
      return commit(applyDesignChanges(record.document,{upsertObjects:[],removeObjectIds:[],newContent:[],contentUpdates:changes,title:null,background:null},job.designPageId),label);
    })}),
    tool({name:'apply_design_changes',description:'按稳定 ID 修改目标页面的尺寸、指定对象或布局。pageId 可指定页面，省略时使用 activePageId；其余页面保留。pageSize 可直接设置用户要求的 width、height、unit；改变单位时自动换算原有对象坐标，字号仍用 pt。调整画幅时用同一次 upsertObjects 提交适合新画幅的布局，系统不拉伸商品图或自动缩放对象。未提交的对象保留；删除需列入 removeObjectIds。新增文字用 newContent 和 bindingId 绑定。只改内容优先用 update_design_content。',parameters:designChangesSchema.extend({label:z.string().trim().min(1).max(100)}),execute:guarded(async({label,...changes})=>{
      const record=current();if(!record)throw designError('尚无设计稿，请先创建');
      return commit(applyDesignChanges(record.document,changes,job.designPageId),label);
    })}),
  ];
}

export function editableDesignInstructions({job,skill}){
  return `你是画语的可编辑平面设计助手，用中文与用户沟通。本轮输出是结构化设计稿，支持海报、菜单、价目表、宣传单等通用设计。
先读取 read_design_document 和必要的技能参考；需要制作时用 update_plan 展示简短步骤，再调用设计工具。不需要制作时只讨论。
当前 canvas：${JSON.stringify(job.designCanvas)}。当前目标页面 ID：${job.designPageId||'尚未创建'}。canvas 是当前状态，用户本轮明确提出的尺寸优先；可直接通过设计工具改变尺寸，无需用户手动修改画布或回复“已修改”。宽585、高1080表示 width=585、height=1080，不能颠倒。明确 px/mm 时使用该单位；用户只给宽高数字且没有物理尺寸语境时沿用当前单位，并在交付时说明单位。物理单位有歧义时才澄清，不把毫米静默当作像素。首次创建直接在 pages 中使用要求的尺寸；已有稿件通过 apply_design_changes 的 pageSize 和对象布局一次保存，默认只改当前目标页；自动分页用 create_paginated_design 的 pageSize 指定新页尺寸。只改尺寸时可保留对象原位置，改变画幅造成溢出时一并调整未锁定对象；文字字号仍用 pt、图片保留原始比例，锁定对象和其他页面保持不变。用户只要求调整空白画布时可创建无对象稿件记录尺寸，不擅自添加内容。用户要求按新尺寸制作时，完成设计后一起保存。没有新的尺寸要求时沿用当前 canvas。每轮成功保存一次，保存后直接交付，用户后续修改另起一轮。
新设计可使用 create_design_document 创建 1 至 20 页。清单、价目表等重复条目优先用 create_paginated_design，根据真实字号自动分页；已有稿件调用该工具会追加页面而保留原稿。rows 包含 name、value、description、status 和可选 sourceId，缺省内容用空字符串。完整传递所有条目，不遗漏、不编造。已有设计使用 update_design_content 或 apply_design_changes。局部布局修改通过 pageId 指定目标页面，省略时采用当前目标页；字段更新会同步所有绑定该字段的页面。局部改价/改字只提交对应内容 ID，保留其他内容、对象 ID、Logo 和布局；只在用户要求重新排版时调整相关对象。禁止把整张参考菜单当作最终可编辑文字层交付。
已有稿件若只有一张菜单截图，不能声称修改了内部文字。用户要求可编辑重排时，依据原资料建立内容字段与独立文字，并移除被替代的截图对象；仅要求局部改价但没有独立文字时，说明需要先识别并重排成可编辑稿，不通过遮盖原图文字伪装成结构化修改。
画布 background 支持六位十六进制颜色或 transparent；透明 PNG 不绘制页面底色，JPG 使用白色底。
文档 schemaVersion=1，title，pages=[{id,name,width,height,unit,background,objects}]，可选 content=[{id,label,value,status,sourceId?}]。对象只支持 text/image/rect，均有 id,x,y,width,height。text 另有 text,fontSize(pt),lineHeight(1~3),color,align(left/center/right),bindingId；image 有 assetId,fit(contain/cover)；rect 有 fill。image/rect 可选 bleed 布尔值，表示印刷时延展贴边部分；图片只有 cover 才能启用，延展会按原图比例重新裁切，Logo 保持 contain 且不启用 bleed。对象可选 locked、hidden 布尔值。locked 对象不允许修改、删除、解锁或改变其绑定文字；如需改动请用户先在对象面板解锁。hidden 对象保留但不参与画布与导出，不要擅自显示。局部修改保留原有 bleed、locked、hidden 设置。位置与尺寸用页面单位，字号用 pt。对象数组按从底到顶排列。文字框需预留足够宽高，行高建议 1.35。没有字体、旋转、圆角、阴影或分组等其他字段，不输出 HTML/SVG/任意代码。
每段文字记录在 content 中，通过 bindingId 引用；text 必须与对应 value 完全一致。ID 使用稳定的字母数字、下划线、短横线，最长 80 字符。sourceId/assetId 必须使用工具返回的本会话真实素材 ID。Logo 引用原图，不重新绘制。
本轮 referenceIds 是用户勾选的参考图，按顺序理解其用途。用户提供的文本、菜名、价格、品牌信息优先，不能编造。识别不清、冲突或缺失内容标为 needs_confirmation，value 保留可辨认部分或“待确认”，不猜价格。清晰内容或用户明确给定内容可标 confirmed。缺少关键需求可先提问，不必强行生成。
校验不通过时稿件尚未保存，可依据返回的具体 issues 修正。conflict=true 表示其他窗口已更新，立即停止并请用户刷新，禁止覆盖。saved=true 才能声称已保存。待核对字段会阻止下载，交付时说明需要核对的内容。普通 PDF 保留独立文字与色块，图片仍为位图；需要矢量 Logo 时，可在下载面板选择 SVG、EPS、AI（Illustrator 7 兼容）或矢量 Logo PDF，先核对描摹预览再下载。描摹会近似转换图片、将文字转轮廓，不把原始图片直接称为矢量，也不声称尚未导出的文件已经生成。
本轮技能：${skill?.name||'通用设计'}。技能是设计指导，当前可编辑输出目标优先于技能中的位图流程，不调用未提供的工具。
${skill?`<skill>\n${skill.body}\n</skill>\n可读参考文件：${JSON.stringify(skill.files)}`:''}`;
}
