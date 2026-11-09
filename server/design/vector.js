import {Worker} from 'node:worker_threads';
import {createHash} from 'node:crypto';
import sharp from 'sharp';
import svgpath from 'svgpath';
import {PDFDocument,rgb,pushGraphicsState,popGraphicsState,rectangle,clip,endPath} from 'pdf-lib';
import {designError} from './document.js';
import {loadDesignFont} from './render.js';
import {exportPages} from './export-settings.js';

export const vectorFormats=new Set(['svg','eps','ai']);
export const isVectorExport=body=>vectorFormats.has(body.format)||body.format==='pdf'&&body.vectorize;
const MAX_PATHS=12000,MAX_SEGMENTS=250000,MAX_IMAGES=12,MAX_SIDE=768;
const cache=new Map();
const number=n=>Number(n.toFixed(4)).toString();
const escapeXml=value=>String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));

// Normalize to a small, shared path vocabulary for SVG, PDF and PostScript.
// All imported curves come from our tracer or our font, never uploaded SVG.
export function normalizePath(d,transform){
  const path=svgpath(d);if(transform)path.transform(transform);
  path.abs().unshort().unarc().iterate((s,_i,x,y)=>{
    if(s[0]==='H')return [['L',s[1],y]];
    if(s[0]==='V')return [['L',x,s[1]]];
    if(s[0]==='Q')return [['C',x+(s[1]-x)*2/3,y+(s[2]-y)*2/3,s[3]+(s[1]-s[3])*2/3,s[4]+(s[2]-s[4])*2/3,s[3],s[4]]];
  }).round(4);
  if(path.err||path.segments.some(s=>!['M','L','C','Z'].includes(s[0])||s.slice(1).some(n=>!Number.isFinite(n))))throw designError('矢量路径无法解析',422);
  return path;
}

async function traceImage(bytes){
  const key=createHash('sha256').update(bytes).digest('hex');
  if(cache.has(key)){const value=cache.get(key);cache.delete(key);cache.set(key,value);return value;}
  const {data,info}=await sharp(bytes,{limitInputPixels:25000000}).resize({width:MAX_SIDE,height:MAX_SIDE,fit:'inside',withoutEnlargement:true}).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  // Legacy AI/EPS cannot represent soft alpha. Use the same silhouette in every
  // vector format, without discarding opaque white details inside the subject.
  for(let i=3;i<data.length;i+=4)data[i]=data[i]>=128?255:0;
  const svg=await new Promise((resolve,reject)=>{
    const worker=new Worker(new URL('./vector-worker.js',import.meta.url),{workerData:{pixels:data,width:info.width,height:info.height},execArgv:[]});
    let settled=false;
    const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);void worker.terminate();error?reject(error):resolve(value);};
    const timer=setTimeout(()=>finish(designError('图片描摹超过 20 秒，请使用更简洁的 Logo 图片',422)),20000);
    worker.once('message',result=>finish(result.error?designError('图片描摹失败，请使用更简洁的 Logo 图片',422):null,result.svg));
    worker.once('error',()=>finish(designError('图片描摹服务失败',422)));
    worker.once('exit',()=>{if(!settled)finish(designError('图片描摹未完成',422));});
  });
  if(typeof svg!=='string'||svg.length>8000000)throw designError('矢量图形过于复杂，请简化图片后导出',422);
  const paths=[];
  for(const match of svg.matchAll(/<path\b([^>]*?)\/?\s*>/g)){
    const attr=Object.fromEntries([...match[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(m=>[m[1],m[2]]));
    if(!attr.d||!/^#[a-f0-9]{6}$/i.test(attr.fill||'')||Object.keys(attr).some(k=>!['d','fill','transform'].includes(k)))throw designError('描摹输出包含不支持的图形',422);
    const d=normalizePath(attr.d,attr.transform).toString();paths.push({d,fill:attr.fill});
    if(paths.length>MAX_PATHS)throw designError('矢量路径过多，请使用更简洁的 Logo 图片',422);
  }
  if(!paths.length&&data.some((alpha,i)=>i%4===3&&alpha>0))throw designError('描摹后未保留可见图形，请使用轮廓更清晰的 Logo 图片',422);
  // Fully transparent source images legitimately have no visible paths.
  const result={width:info.width,height:info.height,paths};
  cache.set(key,result);while(cache.size>8)cache.delete(cache.keys().next().value);
  return result;
}

function rectPath(x,y,width,height){return `M${number(x)} ${number(y)}L${number(x+width)} ${number(y)}L${number(x+width)} ${number(y+height)}L${number(x)} ${number(y+height)}Z`;}

export async function buildVectorScene(layout,body){
  const pages=exportPages(layout,body);
  if(pages.length!==1)throw designError('矢量 Logo 导出请只选择一页',422);
  const page=pages[0],errors=layout.issues.filter(i=>i.pageId===page.id&&i.severity==='error');
  if(errors.length)throw designError(errors.map(i=>i.message).join('；'),422,errors);
  const imageIds=new Set(page.objects.filter(o=>o.type==='image').map(o=>o.assetId));
  if(imageIds.size>MAX_IMAGES)throw designError('矢量 Logo 每页最多描摹 12 张图片',422);
  const scene={pageId:page.id,title:layout.document.title,width:page.width,height:page.height,groups:[],imageCount:imageIds.size,pathCount:0,segmentCount:0};
  const add=group=>{
    for(const path of group.paths){scene.pathCount++;scene.segmentCount+=normalizePath(path.d).segments.length;}
    if(scene.pathCount>MAX_PATHS||scene.segmentCount>MAX_SEGMENTS)throw designError('矢量路径过于复杂，请简化图片后导出',422);
    scene.groups.push(group);
  };
  if(page.background!=='transparent')add({id:'background',paths:[{d:rectPath(0,0,page.width,page.height),fill:page.background}]});
  const {font}=loadDesignFont();
  // Resolve serially: a single export never starts multiple WASM workers.
  const deadline=Date.now()+45000;
  for(const o of page.objects){
    if(Date.now()>deadline)throw designError('本页描摹耗时过长，请减少图片后导出',422);
    const group={id:o.id,paths:[]};
    if(o.type==='rect')group.paths.push({d:rectPath(o.x,o.y,o.width,o.height),fill:o.fill});
    if(o.type==='text')for(const line of o.lines){
      let x=line.x;const scale=o.fontSize/font.unitsPerEm;
      for(const glyph of font.layout(line.text).glyphs){
        const d=glyph.path.toSVG();if(d)group.paths.push({d:normalizePath(d,`translate(${x} ${line.baseline}) scale(${scale} ${-scale})`).toString(),fill:o.color});
        x+=glyph.advanceWidth*scale;
      }
    }
    if(o.type==='image'&&o.draw){
      const traced=await traceImage(layout.assets.get(o.assetId).bytes),d=o.draw;
      group.clip={x:o.x,y:o.y,width:o.width,height:o.height};
      group.paths=traced.paths.map(p=>({fill:p.fill,d:normalizePath(p.d,`translate(${d.x} ${d.y}) scale(${d.width/traced.width} ${d.height/traced.height})`).toString()}));
    }
    add(group);
  }
  return scene;
}

export function sceneSvg(scene){
  const defs=scene.groups.flatMap((g,i)=>g.clip?[`<clipPath id="clip-${i}"><path d="${rectPath(g.clip.x,g.clip.y,g.clip.width,g.clip.height)}"/></clipPath>`]:[]).join('');
  const groups=scene.groups.map((g,i)=>`<g data-object="${escapeXml(g.id)}"${g.clip?` clip-path="url(#clip-${i})"`:''}>${g.paths.map(p=>`<path fill="${p.fill}" d="${p.d}"/>`).join('')}</g>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${number(scene.width*96/72)}" height="${number(scene.height*96/72)}" viewBox="0 0 ${number(scene.width)} ${number(scene.height)}"><title>${escapeXml(scene.title)}</title><desc>Canvas vector export. Raster artwork traced to curves; text outlined.</desc><defs>${defs}</defs>${groups}</svg>`;
}

function psPath(d,height,ai=false){
  const segments=normalizePath(d,`translate(0 ${height}) scale(1 -1)`).segments;
  return segments.map(s=>s[0]==='Z'?(ai?'h':'closepath'):`${s.slice(1).map(number).join(' ')} ${ai?{M:'m',L:'l',C:'c'}[s[0]]:{M:'moveto',L:'lineto',C:'curveto'}[s[0]]}`).join('\n');
}

// AI 7 is the documented Illustrator PostScript path format, not a renamed
// PDF/PNG. The prolog also makes the file independently interpretable as EPS.
// Outlined text avoids missing fonts and unsupported legacy Unicode encodings.
export function scenePostScript(scene,ai=false){
  const header=['%!PS-Adobe-3.0 EPSF-3.0',`%%Creator: Canvas${ai?' (Illustrator 7 compatible)':''}`,'%%Title: Canvas vector logo',`%%BoundingBox: 0 0 ${Math.ceil(scene.width)} ${Math.ceil(scene.height)}`,`%%HiResBoundingBox: 0 0 ${number(scene.width)} ${number(scene.height)}`,'%%Pages: 1','%%LanguageLevel: 2','%%DocumentData: Clean7Bit',...(ai?['%AI3_ColorUsage: Color','%AI3_Cropmarks: 0 0 '+number(scene.width)+' '+number(scene.height),'%AI5_FileFormat 3.0']:[]),'%%EndComments'];
  const prolog=ai?['/CanvasAI 40 dict def CanvasAI begin','/m {moveto} bind def /l {lineto} bind def /c {curveto} bind def /h {closepath} bind def','/Xa {setrgbcolor} bind def /q {gsave} bind def /Q {grestore} bind def','/W {clip} bind def /n {newpath} bind def /u {} bind def /U {} bind def','/compound false def /F {compound not {fill} if} bind def /f {closepath F} bind def','/*u {/compound true def newpath} bind def /*U {fill /compound false def} bind def']:[];
  const body=[];
  const begin=ai?'q':'gsave',end=ai?'Q':'grestore';
  body.push(begin,psPath(rectPath(0,0,scene.width,scene.height),scene.height,ai),ai?'W n':'clip newpath');
  for(const group of scene.groups){
    body.push(begin);
    if(group.clip){const c=group.clip;body.push(psPath(rectPath(c.x,c.y,c.width,c.height),scene.height,ai),ai?'W n':'clip newpath');}
    for(const p of group.paths){
      const color=[1,3,5].map(i=>number(parseInt(p.fill.slice(i,i+2),16)/255)).join(' ');
      body.push(`${color} ${ai?'Xa':'setrgbcolor'}`);
      if(ai){
        body.push('*u');
        // AI compound elements each end with a paint operator; our prolog
        // defers painting until *U, preserving holes and winding direction.
        const subpaths=psPath(p.d,scene.height,true).split(/\n(?=[-\d.]+ [-\d.]+ m\n)/);
        for(const part of subpaths)body.push(part.endsWith('\nh')?part.slice(0,-2):part,part.endsWith('\nh')?'f':'F');
        body.push('*U');
      }else body.push('newpath',psPath(p.d,scene.height),'fill');
    }
    body.push(end);
  }
  body.push(end);
  return [...header,'%%BeginProlog',...prolog,'%%EndProlog','%%Page: 1 1',...body,'%%PageTrailer',...(ai?['end']:[]),'%%Trailer','%%EOF',''].join('\n');
}

export async function renderVector(scene,format){
  let bytes;
  if(format==='svg')bytes=Buffer.from(sceneSvg(scene));
  else if(format==='eps'||format==='ai')bytes=Buffer.from(scenePostScript(scene,format==='ai'),'ascii');
  else if(format==='pdf'){
    const pdf=await PDFDocument.create(),page=pdf.addPage([scene.width,scene.height]);
    pdf.setTitle(scene.title);pdf.setCreator('Canvas');pdf.setProducer('Canvas vector renderer');
    page.pushOperators(pushGraphicsState(),rectangle(0,0,scene.width,scene.height),clip(),endPath());
    for(const group of scene.groups){
      page.pushOperators(pushGraphicsState());
      if(group.clip){const c=group.clip;page.pushOperators(rectangle(c.x,scene.height-c.y-c.height,c.width,c.height),clip(),endPath());}
      for(const p of group.paths)page.drawSvgPath(p.d,{x:0,y:scene.height,color:rgb(...[1,3,5].map(i=>parseInt(p.fill.slice(i,i+2),16)/255)),borderWidth:0});
      page.pushOperators(popGraphicsState());
    }
    page.pushOperators(popGraphicsState());bytes=Buffer.from(await pdf.save());
  }else throw designError('不支持的矢量格式');
  return {bytes,vector:{imageCount:scene.imageCount,pathCount:scene.pathCount,segmentCount:scene.segmentCount,outlinedText:true,approximate:scene.imageCount>0}};
}

export async function vectorPreview(scene){
  const bytes=await sharp(Buffer.from(sceneSvg(scene))).resize({width:1200,height:1200,fit:'inside',withoutEnlargement:true}).png().toBuffer();
  return {pageId:scene.pageId,dataUrl:`data:image/png;base64,${bytes.toString('base64')}`};
}
