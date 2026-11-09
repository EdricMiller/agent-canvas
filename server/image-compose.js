import sharp from 'sharp';
import {z} from 'zod';
import {inspectTransparency} from './image-output.js';
import {printImageSource} from './design/print-source.js';

const unit=z.number().min(0).max(1);
export const logoPlacementSchema=z.object({
  x:unit.default(.06),
  y:unit.default(.05),
  width:z.number().gt(0).max(1),
  height:z.number().gt(0).max(1),
  fit:z.enum(['contain','cover']).default('contain'),
  opacity:z.number().min(0).max(1).default(1),
}).strict().superRefine((value,ctx)=>{
  if(value.x+value.width>1)ctx.addIssue({code:'custom',path:['width'],message:'Logo 横向位置和尺寸不能超出底图'});
  if(value.y+value.height>1)ctx.addIssue({code:'custom',path:['height'],message:'Logo 纵向位置和尺寸不能超出底图'});
});

export const composeImageSchema=z.object({
  sourceId:z.string().min(1),
  logoId:z.string().min(1),
  placement:logoPlacementSchema,
  label:z.string().min(1).max(60),
}).strict();

function px(value,total){return Math.max(0,Math.min(total,Math.round(value*total)));}

async function resizeLogo(bytes,width,height,fit,opacity,signal){
  signal?.throwIfAborted();
  const resized=await sharp(bytes,{limitInputPixels:40000000})
    .ensureAlpha()
    .resize({width,height,fit,position:'centre',background:{r:0,g:0,b:0,alpha:0}})
    .raw()
    .toBuffer({resolveWithObject:true});
  signal?.throwIfAborted();
  if(opacity<1){
    for(let i=3;i<resized.data.length;i+=4)resized.data[i]=Math.round(resized.data[i]*opacity);
  }
  return sharp(resized.data,{raw:{width:resized.info.width,height:resized.info.height,channels:4}}).png().toBuffer();
}

export async function composeRaster(baseBytes,logoBytes,placement,{signal}={}){
  const baseMeta=await sharp(baseBytes,{limitInputPixels:40000000}).metadata();
  if(!baseMeta.width||!baseMeta.height)throw new Error('底图没有有效尺寸');
  const parsed=logoPlacementSchema.parse(placement);
  const left=px(parsed.x,baseMeta.width),top=px(parsed.y,baseMeta.height);
  const width=Math.min(px(parsed.width,baseMeta.width),baseMeta.width-left),height=Math.min(px(parsed.height,baseMeta.height),baseMeta.height-top);
  if(width<1||height<1)throw new Error('Logo 尺寸过小，无法合成');
  const overlay=await resizeLogo(logoBytes,width,height,parsed.fit,parsed.opacity,signal);
  signal?.throwIfAborted();
  const bytes=await sharp(baseBytes,{limitInputPixels:40000000})
    .composite([{input:overlay,left,top,blend:'over'}])
    .png()
    .toBuffer();
  signal?.throwIfAborted();
  return {bytes,width:baseMeta.width,height:baseMeta.height,placement:parsed};
}

export async function composeLogoOnImage({session,store,sourceId,logoId,placement,label,skill,signal}){
  if(sourceId===logoId)throw new Error('底图和 Logo 不能是同一个版本');
  const {version:source,bytes:base}=store.image(session,sourceId);
  const {version:logo,bytes:logoBytes}=store.image(session,logoId);
  if(source.demo||logo.demo)throw new Error('演示图片不可用于 Logo 合成，请使用真实图片或透明 Logo');
  const logoTransparency=await inspectTransparency(logoBytes);
  if(!logoTransparency.hasTransparency)throw Object.assign(new Error(logoTransparency.visiblePixels===0?'Logo 是全透明空图，请更换素材。':'Logo 未检测到透明边缘，请上传透明背景的 PNG 或 WebP。白底或棋盘格图片不能直接作为透明 Logo。'),{status:422});
  const working=await composeRaster(base,logoBytes,placement,{signal});
  const nativeBase=source.sourceUrl?await printImageSource(store,session,sourceId):null;
  const nativeLogo=logo.sourceUrl?await printImageSource(store,session,logoId):logoBytes;
  const native=nativeBase?await composeRaster(nativeBase,nativeLogo,placement,{signal}):null;
  const transparency=await inspectTransparency(working.bytes);
  signal?.throwIfAborted();
  const version=store.addImage(session,working.bytes,{
    kind:'generated',demo:false,label,parentId:sourceId,renderSourceId:sourceId,
    renderSourceIds:[sourceId,logoId],referenceIds:source.referenceIds||[],
    skillId:skill?.id||source.skillId||null,skillVersion:skill?.version||source.skillVersion||null,
    width:working.width,height:working.height,imageTarget:source.imageTarget||null,
    imageGeneration:source.imageGeneration,background:transparency.hasTransparency?'transparent':'opaque',transparency,
    adaptation:native?{method:'native',sourceWidth:native.width,sourceHeight:native.height,upscaled:working.width>native.width||working.height>native.height,background:source.adaptation?.background||'#ffffff'}:source.adaptation||null,
    composition:{type:'logo-overlay',baseId:sourceId,logoId,placement:working.placement},
  },{originalBytes:native?.bytes});
  return version;
}
