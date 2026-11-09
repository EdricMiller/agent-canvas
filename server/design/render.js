import fs from 'node:fs';
import sharp from 'sharp';
import fontkit from '@pdf-lib/fontkit';
import {PDFDocument,PDFName,PDFString,rgb,cmyk,pushGraphicsState,popGraphicsState,rectangle,clip,endPath,concatTransformationMatrix} from 'pdf-lib';
import {documentSchema,toPoints,designError} from './document.js';
import {getDefaultPrintProfile} from './profiles.js';
import {pageGeometry} from './export-settings.js';
import {inspectPrintPdf} from './pdf-inspect.js';
import {printObjects,cropSegments} from './print-layout.js';
import {textSignature} from '../../shared/design-geometry.js';

let fontCache;
export function loadDesignFont(){
  if(fontCache)return fontCache;
  const candidates=process.env.STUDIO_FONT_FILE?[process.env.STUDIO_FONT_FILE]:[
    '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
    '/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf',
    '/usr/share/fonts/truetype/noto/NotoSansSC-Regular.ttf',
  ];
  const file=candidates.find(p=>fs.existsSync(p));
  if(!file)throw designError('未找到设计字体，请通过 STUDIO_FONT_FILE 配置可嵌入的中文 TTF/OTF 字体',503);
  const bytes=fs.readFileSync(file),font=fontkit.create(bytes);
  if(!font.unitsPerEm)throw designError('设计字体需为单个 TTF/OTF 文件，不支持字体集合',503);
  const flags=font['OS/2']?.fsType;
  if(flags?.noEmbedding||flags?.bitmapOnly||flags?.viewOnly)throw designError('当前字体不允许可编辑文档嵌入，请更换字体',503);
  fontCache={bytes,font,name:font.fullName,subset:!flags?.noSubsetting};return fontCache;
}

const measure=(font,text,size)=>font.layout(text).glyphs.reduce((sum,g)=>sum+g.advanceWidth,0)*size/font.unitsPerEm;
const graphemes=new Intl.Segmenter('zh',{granularity:'grapheme'});
const words=new Intl.Segmenter('zh',{granularity:'word'});
function wrapText(text,width,font,size){
  const lines=[];
  for(const paragraph of text.replace(/\r\n?/g,'\n').split('\n')){
    let current='';
    const append=token=>{
      if(current&&measure(font,current+token,size)>width){lines.push(current);current='';}
      current+=token;
    };
    for(const {segment} of words.segment(paragraph)){
      if(measure(font,segment,size)>width){for(const {segment:g} of graphemes.segment(segment))append(g);}
      else append(segment);
    }
    lines.push(current);
  }
  return lines;
}

export function measureDesignText(text,width,fontSize,lineHeight=1.35){
  const {font}=loadDesignFont();
  const lines=wrapText(text.replace(/\t/g,'    '),width,font,fontSize);
  const glyphHeight=(font.ascent-font.descent)/font.unitsPerEm*fontSize;
  return {height:glyphHeight+(lines.length-1)*Math.max(fontSize*lineHeight,glyphHeight),width:Math.max(...lines.map(line=>measure(font,line,fontSize))),lineCount:lines.length};
}

export async function layoutDocument(input,resolveAsset){
  const document=documentSchema.parse(input),{font,name}=loadDesignFont(),assets=new Map(),issues=[];
  for(const field of document.content||[])if(field.status==='needs_confirmation'){
    const boundPages=document.pages.filter(p=>p.objects.some(o=>o.type==='text'&&o.bindingId===field.id));
    const visiblePages=boundPages.filter(p=>p.objects.some(o=>!o.hidden&&o.type==='text'&&o.bindingId===field.id));
    for(const p of boundPages.length?visiblePages:document.pages)issues.push({pageId:p.id,contentId:field.id,code:'unconfirmed_content',message:`“${field.label}”需要核对，确认后才能下载`,severity:'error'});
  }
  for(const p of document.pages)for(const o of p.objects)if(!o.hidden&&o.type==='image'&&!assets.has(o.assetId)){
    try{
      const input=await resolveAsset(o.assetId),bytes=await sharp(input,{limitInputPixels:25000000}).rotate().toColourspace('srgb').png().toBuffer();
      assets.set(o.assetId,{bytes,...await sharp(bytes).metadata()});
    }catch{assets.set(o.assetId,null);}
  }
  const pages=document.pages.map(p=>{
    const unit=value=>toPoints(value,p.unit),width=unit(p.width),height=unit(p.height);
    const issue=(objectId,code,message,severity='error')=>issues.push({pageId:p.id,objectId,code,message,severity});
    const objects=p.objects.filter(o=>!o.hidden).map(o=>{
      const box={...o,x:unit(o.x),y:unit(o.y),width:unit(o.width),height:unit(o.height)};
      if(box.x+box.width>width+.01||box.y+box.height>height+.01)issue(o.id,'outside_page','对象超出页面边界，请调整位置或尺寸');
      if(o.type==='text'){
        const missing=[...new Set([...o.text].filter(c=>!/[\n\r\t]/.test(c)&&!font.hasGlyphForCodePoint(c.codePointAt(0))))];
        if(missing.length)issue(o.id,'missing_glyph',`字体不支持这些字符：${missing.slice(0,12).join('')}`);
        const lineHeight=Math.max(o.fontSize*o.lineHeight,(font.ascent-font.descent)/font.unitsPerEm*o.fontSize);
        const texts=wrapText(o.text.replace(/\t/g,'    '),box.width,font,o.fontSize);
        const lines=texts.map((text,i)=>{
          const w=measure(font,text,o.fontSize);
          if(w>box.width+.01)issue(o.id,'text_overflow','文字宽度超出文本框，请扩大文本框或减小字号');
          return {text,x:box.x+(o.align==='center'?(box.width-w)/2:o.align==='right'?box.width-w:0),baseline:box.y+font.ascent/font.unitsPerEm*o.fontSize+i*lineHeight};
        });
        if(lines.at(-1).baseline-box.y-font.descent/font.unitsPerEm*o.fontSize>box.height+.01)issue(o.id,'text_overflow','文字高度超出文本框，请扩大文本框或减少内容');
        return {...box,lines};
      }
      if(o.type==='image'){
        const asset=assets.get(o.assetId);
        if(!asset){issue(o.id,'missing_asset','图片素材不存在或无法读取');return box;}
        const scale=(o.fit==='cover'?Math.max:Math.min)(box.width/asset.width,box.height/asset.height);
        const imageWidth=asset.width*scale,imageHeight=asset.height*scale;
        const draw={x:box.x+(box.width-imageWidth)/2,y:box.y+(box.height-imageHeight)/2,width:imageWidth,height:imageHeight};
        const ppi=72/scale;
        if(ppi<300)issue(o.id,'low_resolution',`图片有效分辨率约 ${Math.round(ppi)} PPI，低于当前印刷检查预设 300 PPI`,'warning');
        return {...box,draw,ppi};
      }
      return box;
    });
    return {...p,width,height,objects};
  });
  return {document,pages,assets,issues,fontName:name};
}

function selectedPages(layout,pageId,pageIds){
  if(pageIds){
    if(pageId||!pageIds.length||new Set(pageIds).size!==pageIds.length)throw designError('页面范围无效');
    if(pageIds.some(id=>!layout.pages.some(p=>p.id===id)))throw designError('页面不存在',404);
    const selected=new Set(pageIds);return layout.pages.filter(p=>selected.has(p.id));
  }
  if(!pageId)return layout.pages;
  const page=layout.pages.find(p=>p.id===pageId);if(!page)throw designError('页面不存在',404);return [page];
}
function assertRenderable(layout,pages){
  const ids=new Set(pages.map(p=>p.id)),errors=layout.issues.filter(i=>i.severity==='error'&&ids.has(i.pageId));
  if(errors.length)throw designError(errors.map(e=>e.message).join('；'),422,errors);
}

function glyphPaths(text,font,size,x,baseline,color){
  const scale=size/font.unitsPerEm;let offset=0;
  const paths=font.layout(text).glyphs.map(g=>{
    const d=g.path.toSVG(),path=d?`<path d="${d}" transform="translate(${x+offset} ${baseline}) scale(${scale} ${-scale})" fill="${color}"/>`:'';
    offset+=g.advanceWidth*scale;return path;
  });
  return paths.join('');
}

// Return only glyph outlines and placements, never HTML or font substitution.
// The browser moves independent layers while using the same wrapping/baselines
// as PNG and PDF. Coordinates here use the original page unit.
export function editorTextLayers(layout,pageId){
  const [page]=selectedPages(layout,pageId),{font}=loadDesignFont(),factor=toPoints(1,page.unit),glyphs={},objects=[];
  const source=layout.document.pages.find(p=>p.id===page.id);
  for(const o of page.objects)if(o.type==='text'){
    const runs=[],scale=o.fontSize/font.unitsPerEm/factor;
    for(const line of o.lines){
      let x=(line.x-o.x)/factor;
      for(const glyph of font.layout(line.text).glyphs){
        const key=String(glyph.id);if(!(key in glyphs))glyphs[key]=glyph.path.toSVG();
        if(glyphs[key])runs.push({glyph:key,x,y:(line.baseline-o.y)/factor,scale});
        x+=glyph.advanceWidth*scale;
      }
    }
    objects.push({id:o.id,signature:textSignature(source.objects.find(item=>item.id===o.id),page.unit),runs});
  }
  return {pageId:page.id,glyphs,objects,issues:layout.issues.filter(i=>i.pageId===page.id),font:layout.fontName};
}

export async function renderPreview(layout,{pageId,scale=1,dpi,format='png',allowErrors=false,print}={}){
  const [page]=selectedPages(layout,pageId);if(!allowErrors)assertRenderable(layout,[page]);
  if(dpi!==undefined){if(!Number.isInteger(dpi)||dpi<72||dpi>600)throw designError('输出分辨率需在 72–600 PPI 范围内');scale=dpi/96;}
  if(dpi===undefined&&(!Number.isFinite(scale)||scale<=0||scale>4))throw designError('图片缩放必须大于 0 且不超过 4');
  // Pixel documents preserve their stated pixel size at 1x; mm documents use 96 PPI for preview.
  const g=pageGeometry(page,print),width=Math.max(1,Math.round(g.width/72*96*scale)),height=Math.max(1,Math.round(g.height/72*96*scale));
  if(width*height>25000000)throw designError('输出超过 2500 万像素，请减小缩放或尺寸');
  const {font}=loadDesignFont();
  let body=(page.background==='transparent'?'':`<rect x="${g.marks}" y="${g.marks}" width="${page.width+2*g.bleed}" height="${page.height+2*g.bleed}" fill="${page.background}"/>`)+`<g transform="translate(${g.offset} ${g.offset})"><svg x="${-g.bleed}" y="${-g.bleed}" width="${page.width+2*g.bleed}" height="${page.height+2*g.bleed}" viewBox="${-g.bleed} ${-g.bleed} ${page.width+2*g.bleed} ${page.height+2*g.bleed}" overflow="hidden">`;
  for(const o of printObjects(page,print,layout.assets)){
    if(o.type==='rect')body+=`<rect x="${o.x}" y="${o.y}" width="${o.width}" height="${o.height}" fill="${o.fill}"/>`;
    if(o.type==='text')for(const line of o.lines)body+=glyphPaths(line.text,font,o.fontSize,line.x,line.baseline,o.color);
    if(o.type==='image'&&o.draw){
      const a=layout.assets.get(o.assetId),d=o.draw;
      body+=`<svg x="${o.x}" y="${o.y}" width="${o.width}" height="${o.height}" viewBox="${o.x} ${o.y} ${o.width} ${o.height}" overflow="hidden"><image x="${d.x}" y="${d.y}" width="${d.width}" height="${d.height}" href="data:image/png;base64,${a.bytes.toString('base64')}"/></svg>`;
    }
  }
  body+='</svg></g>';
  if(print?.cropMarks)for(const [x1,y1,x2,y2] of cropSegments(page,g))body+=`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#000000" stroke-width=".25"/>`;
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${g.width} ${g.height}">${body}</svg>`;
  const pipeline=sharp(Buffer.from(svg),{limitInputPixels:25000000}).withIccProfile('srgb').withMetadata({density:Math.round(dpi||96*scale)});
  return {bytes:await(format==='jpeg'?pipeline.flatten({background:'#ffffff'}).jpeg({quality:100,chromaSubsampling:'4:4:4'}):pipeline.png()).toBuffer(),width,height,geometry:{...g,trimWidth:page.width,trimHeight:page.height,safe:toPoints(print?.safeMm??3,'mm')}};
}

export async function designCapabilities(){
  let font=null,fontError=null,profile=null,profileError=null;
  try{font=loadDesignFont().name;}catch(e){fontError=e.message;}
  try{const p=await getDefaultPrintProfile();profile={name:p.name,custom:p.custom};}catch(e){profileError=e.message;}
  return {schemaVersion:1,font,fontError,profile,profileError,pdf:Boolean(font),cmyk:Boolean(font&&profile),pdfX:false};
}

export async function renderPdf(layout,{pageId,pageIds,colorSpace='rgb',dpi,print,printReady=false,profile:chosenProfile}={}){
  if(print&&colorSpace!=='cmyk')throw designError('印刷设置适用于 CMYK PDF');
  if(dpi!==undefined&&(!Number.isInteger(dpi)||dpi<72||dpi>600))throw designError('输出分辨率需在 72–600 PPI 范围内');
  if(!['rgb','cmyk'].includes(colorSpace))throw designError('不支持该色彩模式');
  const pages=selectedPages(layout,pageId,pageIds);assertRenderable(layout,pages);
  const pdf=await PDFDocument.create();pdf.registerFontkit(fontkit);pdf.setTitle(layout.document.title);pdf.setCreator('画语 Canvas');pdf.setProducer('画语 Canvas design renderer');
  const fontData=loadDesignFont(),font=await pdf.embedFont(fontData.bytes,{subset:fontData.subset});
  const profile=colorSpace==='cmyk'?(chosenProfile||await getDefaultPrintProfile()):null;
  let iccRef;const colorMap=new Map();
  if(profile){
    iccRef=pdf.context.register(pdf.context.flateStream(profile.icc,{N:4}));
    const intent=pdf.context.register(pdf.context.obj({Type:'OutputIntent',S:'GTS_PDFX',OutputConditionIdentifier:PDFString.of(profile.name),Info:PDFString.of(profile.name),DestOutputProfile:iccRef}));
    pdf.catalog.set(PDFName.of('OutputIntents'),pdf.context.obj([intent]));
  }
  const getColor=async(hex,text=false)=>{
    const preserve=print?text&&print.blackText==='preserve':true,key=`${hex}-${preserve}`;
    if(colorMap.has(key))return colorMap.get(key);
    const components=[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16));let result;
    if(profile){
      // Preserve pure black as single K for small text and monochrome artwork.
      if(preserve&&hex.toLowerCase()==='#000000')result=cmyk(0,0,0,1);
      else{
        const raw=await sharp(Buffer.from(components),{raw:{width:1,height:1,channels:3}}).withIccProfile(profile.target).toColourspace('cmyk').raw().toBuffer();
        result=cmyk(...[...raw].map(v=>v/255));
      }
    }else result=rgb(...components.map(v=>v/255));
    colorMap.set(key,result);return result;
  };
  const images=new Map(),imageSizes=new Map(),targetPpi=dpi||(printReady||print?300:null),objectsByPage=new Map(pages.map(p=>[p.id,printObjects(p,print,layout.assets)]));
  if(targetPpi)for(const p of pages)for(const o of objectsByPage.get(p.id))if(o.type==='image'&&o.draw){
    const asset=layout.assets.get(o.assetId),ratio=Math.min(1,Math.max(o.draw.width/72*targetPpi/asset.width,o.draw.height/72*targetPpi/asset.height));
    imageSizes.set(o.assetId,Math.max(imageSizes.get(o.assetId)||0,ratio));
  }
  const embedImage=async id=>{
    if(images.has(id))return images.get(id);
    const original=layout.assets.get(id),ratio=imageSizes.get(id),asset=ratio&&ratio<.999?{...original,bytes:await sharp(original.bytes).resize({width:Math.max(1,Math.ceil(original.width*ratio)),height:Math.max(1,Math.ceil(original.height*ratio)),fit:'inside',withoutEnlargement:true}).png().toBuffer()}:original;let image;
    if(!profile)image=await pdf.embedPng(asset.bytes);
    else{
      const {data,info}=await sharp(asset.bytes).removeAlpha().withIccProfile(profile.target).toColourspace('cmyk').raw().toBuffer({resolveWithObject:true});
      if(info.channels!==4)throw designError('图片 CMYK 转换失败',500);
      const dict={Type:'XObject',Subtype:'Image',Width:info.width,Height:info.height,BitsPerComponent:8,ColorSpace:pdf.context.obj(['ICCBased',iccRef])};
      if(asset.hasAlpha){
        const alpha=await sharp(asset.bytes).extractChannel('alpha').raw().toBuffer();
        dict.SMask=pdf.context.register(pdf.context.flateStream(alpha,{Type:'XObject',Subtype:'Image',Width:info.width,Height:info.height,BitsPerComponent:8,ColorSpace:'DeviceGray'}));
      }
      image=await pdf.embedPng(asset.bytes);await image.embed();
      // Replace the registered image stream after the public PNG embed step;
      // its PDFImage dimensions/ref remain valid and it cannot re-embed as RGB.
      pdf.context.assign(image.ref,pdf.context.flateStream(data,dict));
    }
    images.set(id,image);return image;
  };
  for(const p of pages){
    const g=pageGeometry(p,print),page=pdf.addPage([g.width,g.height]);
    page.setTrimBox(g.offset,g.offset,p.width,p.height);page.setBleedBox(g.marks,g.marks,p.width+g.bleed*2,p.height+g.bleed*2);
    if(p.background!=='transparent')page.drawRectangle({x:g.marks,y:g.marks,width:p.width+g.bleed*2,height:p.height+g.bleed*2,color:await getColor(p.background)});
    page.pushOperators(pushGraphicsState(),concatTransformationMatrix(1,0,0,1,g.offset,g.offset),rectangle(-g.bleed,-g.bleed,p.width+2*g.bleed,p.height+2*g.bleed),clip(),endPath());
    for(const o of objectsByPage.get(p.id)){
      if(o.type==='rect')page.drawRectangle({x:o.x,y:p.height-o.y-o.height,width:o.width,height:o.height,color:await getColor(o.fill)});
      if(o.type==='text')for(const line of o.lines)if(line.text)page.drawText(line.text,{x:line.x,y:p.height-line.baseline,font,size:o.fontSize,color:await getColor(o.color,true),lineHeight:o.fontSize});
      if(o.type==='image'){
        const image=await embedImage(o.assetId),d=o.draw;
        page.pushOperators(pushGraphicsState(),rectangle(o.x,p.height-o.y-o.height,o.width,o.height),clip(),endPath());
        page.drawImage(image,{x:d.x,y:p.height-d.y-d.height,width:d.width,height:d.height});page.pushOperators(popGraphicsState());
      }
    }
    page.pushOperators(popGraphicsState());
    if(print?.cropMarks){
      for(const [x1,y1,x2,y2] of cropSegments(p,g))page.drawLine({start:{x:x1,y:g.height-y1},end:{x:x2,y:g.height-y2},thickness:.25,color:cmyk(0,0,0,1)});
    }
  }
  const bytes=Buffer.from(await pdf.save()),verification=print?await inspectPrintPdf(bytes,pages,print,profile):null;
  return {bytes,colorSpace,profile:profile?.name??null,verification,pdfX:false};
}
