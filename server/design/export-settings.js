import {z} from 'zod';
import {designError,toPoints} from './document.js';
import {edgeSides,printObjects} from './print-layout.js';

export const printSettingsSchema=z.object({
  profileId:z.string().regex(/^(default|icc-[a-f0-9]{64})$/).default('default'),
  bleedMm:z.number().min(0).max(20).default(3),
  cropMarks:z.boolean().default(false),
  bleedMode:z.enum(['background','objects']).default('background'),
  safeMm:z.number().min(0).max(20).default(3),
  blackText:z.enum(['preserve','convert']).default('preserve'),
}).strict();
export const exportSettingsSchema=z.object({
  revision:z.number().int().positive(),versionId:z.string().uuid().optional(),
  pageId:z.string().min(1).max(80).optional(),pageIds:z.array(z.string().min(1).max(80)).min(1).max(20).refine(ids=>new Set(ids).size===ids.length).optional(),
  format:z.enum(['png','jpeg','pdf','svg','eps','ai']),colorSpace:z.enum(['rgb','cmyk']).default('rgb'),scale:z.number().positive().max(4).default(1),
  vectorize:z.boolean().default(false),
  printReady:z.boolean().default(false),
  dpi:z.number().int().min(72).max(600).optional(),print:printSettingsSchema.optional(),acknowledgeWarnings:z.boolean().default(false),
}).strict();

export function validateExportSettings(body){
  const vector=['svg','eps','ai'].includes(body.format)||body.format==='pdf'&&body.vectorize;
  if(body.pageId&&body.pageIds)throw designError('pageId 和 pageIds 不能同时指定');
  if(body.pageIds&&body.format!=='pdf')throw designError('多页下载请选择 PDF');
  if(body.vectorize&&body.format!=='pdf')throw designError('vectorize 仅适用于 PDF，SVG/EPS/AI 默认描摹图片');
  if(vector&&body.colorSpace!=='rgb')throw designError('矢量 Logo 当前仅支持 RGB，CMYK 请使用普通印刷 PDF');
  if(vector&&(body.dpi!==undefined||body.scale!==1))throw designError('矢量导出不使用像素缩放或 PPI 设置');
  if(body.printReady&&(body.format!=='pdf'||vector))throw designError('高清打印模式适用于普通 PDF，不进行图片矢量描摹');
  if(body.format!=='pdf'&&body.colorSpace!=='rgb')throw designError('图片和矢量下载仅支持 RGB，请选择 PDF 导出 CMYK');
  if(body.print&&(body.format!=='pdf'||body.colorSpace!=='cmyk'))throw designError('印刷设置适用于 CMYK PDF');
}
export function exportPages(layout,body){
  if(body.pageId&&body.pageIds)throw designError('页面范围无效');
  const ids=body.pageIds|| (body.pageId?[body.pageId]:null);
  if(ids&&(!ids.length||new Set(ids).size!==ids.length||ids.some(id=>!layout.pages.some(p=>p.id===id))))throw designError('页面不存在或范围无效',404);
  if(body.format!=='pdf'&&!ids&&layout.pages.length>1)throw designError('图片下载请指定页面');
  return ids?layout.pages.filter(p=>ids.includes(p.id)):layout.pages;
}
export function pageGeometry(page,print){
  const bleed=toPoints(print?.bleedMm||0,'mm'),marks=print?.cropMarks?toPoints(8,'mm'):0,offset=bleed+marks;
  return {bleed,marks,offset,width:page.width+offset*2,height:page.height+offset*2};
}

export function exportReport(layout,body,{revision,versionId=null,profile=null}={}){
  validateExportSettings(body);const pages=exportPages(layout,body),ids=new Set(pages.map(p=>p.id));
  const issues=layout.issues.filter(i=>ids.has(i.pageId)&&i.code!=='low_resolution').map(i=>({...i}));
  const issue=(pageId,objectId,code,message)=>issues.push({pageId,objectId,code,message,severity:'warning'});
  const vector=['svg','eps','ai'].includes(body.format)||body.format==='pdf'&&body.vectorize;
  const threshold=vector?null:body.printReady||body.print?(body.dpi||300):body.format==='pdf'?null:(body.dpi||96*body.scale);
  if(vector&&pages.length!==1)throw designError('矢量 Logo 导出请只选择一页');
  for(const page of pages){
    const objects=printObjects(page,body.print,layout.assets);
    if(threshold)for(const o of objects)if(o.type==='image'&&o.ppi<threshold-.5){
      if(body.printReady)issues.push({pageId:page.id,objectId:o.id,code:'low_resolution',severity:'error',message:`图片有效分辨率约 ${Math.round(o.ppi)} PPI，低于所选 ${threshold} PPI；此尺寸需要至少 ${Math.ceil(o.draw.width/72*threshold-1e-6)} × ${Math.ceil(o.draw.height/72*threshold-1e-6)} px。请缩小成品尺寸或使用更高清的原图`});
      else issue(page.id,o.id,'low_resolution',`图片有效分辨率约 ${Math.round(o.ppi)} PPI，低于所选 ${threshold} PPI；不会放大原图来补充细节`);
    }
    if(vector&&objects.some(o=>o.type==='image'))issue(page.id,undefined,'vector_approximation','人物图片将描摹为最多 32 色的矢量路径，柔和透明边缘会转为实边；请核对预览中的轮廓、眼镜和颜色，原始作品保持不变');
    if(body.format==='ai')issue(page.id,undefined,'legacy_ai','AI 使用 Illustrator 7 兼容的 PostScript 路径格式，文字已转轮廓；尚未经过本机 Illustrator 打开验证');
    if(!vector&&body.format!=='pdf'){const ppi=body.dpi||96*body.scale,w=Math.round(page.width/72*ppi),h=Math.round(page.height/72*ppi);if(w<1||h<1||w*h>25000000)issues.push({pageId:page.id,code:'output_size',message:'图片输出需至少 1 像素且不超过 2500 万像素，请降低分辨率或尺寸',severity:'error'});}
    if(body.print){
      const g=pageGeometry(page,body.print);
      if(g.width>14400||g.height>14400)issues.push({pageId:page.id,code:'output_size',message:'含出血和裁切线后的纸张尺寸超过支持范围',severity:'error'});
      if(body.print.bleedMm>0)for(const [index,o] of page.objects.entries()){
        const nearEdge=Object.values(edgeSides(o,page)).some(Boolean),extended=objects[index];
        if(!nearEdge)continue;
        if(extended.bleedApplied&&o.type==='image')issue(page.id,o.id,'bleed_image_crop','贴边图片已按原图比例重新裁切并延展到出血区，请在裁切预览中核对主体位置');
        else if(o.type==='image'&&o.bleed&&body.print.bleedMode==='objects'&&o.fit!=='cover'){
          issues.push({pageId:page.id,objectId:o.id,code:'bleed_requires_cover',message:'图片已启用出血延展，但仍为完整显示；请改为居中裁切填充，或关闭此对象的出血延展',severity:'error'});
        }else if(!extended.bleedApplied&&(o.type==='image'||o.type==='rect'&&o.fill.toLowerCase()!==page.background.toLowerCase()))issue(page.id,o.id,'bleed_background_only','贴边图片或图形未延展到出血区；可在对象属性中启用出血延展，或核对当前背景延展效果');
      }
      for(const o of page.objects)if(o.type==='text'&&Math.min(o.x,o.y,page.width-o.x-o.width,page.height-o.y-o.height)<toPoints(body.print.safeMm??3,'mm'))issue(page.id,o.id,'safe_margin',`文字距离成品边缘不足 ${body.print.safeMm??3} mm，请核对裁切安全距离`);
    }
  }
  if(body.print&&profile&&!profile.custom)issue(undefined,undefined,'proof_profile','当前 ICC 为内置技术验证配置，CMYK 转换可能明显改变颜色；仅用于测试。正式印刷请导入印刷方 ICC；保留原图 RGB 颜色请选择普通 PDF');
  const selected=pages.map(p=>({id:p.id,number:layout.pages.indexOf(p)+1,name:p.name,width:p.width,height:p.height,...(body.print?{outputWidth:pageGeometry(p,body.print).width,outputHeight:pageGeometry(p,body.print).height}:{})}));
  const warnings=issues.filter(i=>i.severity==='warning').length,errors=issues.filter(i=>i.severity==='error').length;
  return {revision,versionId,font:layout.fontName,pages:selected,profile:profile?{id:profile.id,name:profile.name,custom:profile.custom,hash:profile.hash,description:profile.description}:null,settings:{format:body.format,colorSpace:body.colorSpace,dpi:body.dpi??(body.printReady||body.print?300:null),scale:body.scale,vectorize:vector,printReady:!!body.printReady,print:body.print??null},issues,warnings,errors,canExport:errors===0,pdfX:false};
}
export function assertExportReport(report,body){
  if(report.errors)throw designError(report.issues.filter(i=>i.severity==='error').map(i=>i.message).join('；'),422,report.issues);
  if(body.print&&report.warnings&&!body.acknowledgeWarnings)throw designError('请先核对并确认印刷检查提示，再下载',422,report.issues);
  if(report.settings.vectorize&&!body.acknowledgeWarnings)throw designError('请先核对矢量描摹预览并确认后下载',422,report.issues);
}
