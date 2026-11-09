import sharp from 'sharp';
import {imageTargetSchema} from './image-target.js';
import {productForSource} from './product.js';

export function preservingResizeRequest(text){
  const compact=String(text||'').replace(/\s+/g,'');
  // A resize request can be embedded in a longer instruction. Keep the
  // explicit resize verb and dimension labels as the guard so ordinary
  // requests such as "重新设计一张 3650x1090 海报" still reach the agent.
  const match=compact.match(/(?:尺寸|画布|画幅)?(?:改为|改成|调整为|调整到|设为)(?:宽|长)?(\d{2,5})[xX×](?:高|宽)?(\d{2,5})(?:像素|px)?/i);
  if(!match)return null;
  const width=Number(match[1]),height=Number(match[2]);
  imageTargetSchema.parse({mode:'pixels',width,height,fit:'contain',background:'#ffffff'});
  return {width,height};
}

async function plainBackgroundBounds(bytes,width,height){
  const {data,info}=await sharp(bytes).resize({width:Math.min(width,1000),withoutEnlargement:true}).raw().toBuffer({resolveWithObject:true});
  const pixel=(x,y)=>[...data.subarray((y*info.width+x)*info.channels,(y*info.width+x)*info.channels+info.channels)];
  const corners=[pixel(0,0),pixel(info.width-1,0),pixel(0,info.height-1),pixel(info.width-1,info.height-1)];
  if(info.channels>3&&corners.some(color=>color[3]<250))return null;
  const background=[0,1,2].map(channel=>Math.round(corners.reduce((sum,color)=>sum+color[channel],0)/4));
  if(corners.some(color=>background.some((value,channel)=>Math.abs(color[channel]-value)>18)))return null;
  let left=info.width,top=info.height,right=-1,bottom=-1;
  for(let y=0;y<info.height;y++)for(let x=0;x<info.width;x++){
    const index=(y*info.width+x)*info.channels;
    if([0,1,2].some(channel=>Math.abs(data[index+channel]-background[channel])>45)){
      left=Math.min(left,x);top=Math.min(top,y);right=Math.max(right,x);bottom=Math.max(bottom,y);
    }
  }
  if(right<left)return null;
  return {left:Math.floor(left*width/info.width),top:Math.floor(top*height/info.height),right:Math.ceil((right+1)*width/info.width),bottom:Math.ceil((bottom+1)*height/info.height),background:`#${background.map(value=>value.toString(16).padStart(2,'0')).join('')}`};
}

async function dominantColor(bytes,crop,fallback){
  const {data,info}=await sharp(bytes).extract(crop).resize({width:64,height:64,fit:'inside'}).removeAlpha().raw().toBuffer({resolveWithObject:true});
  const counts=new Map();
  for(let i=0;i<data.length;i+=info.channels){
    const color=[0,1,2].map(channel=>Math.round(data[i+channel]/16)*16);
    const key=color.join(',');counts.set(key,(counts.get(key)||0)+1);
  }
  const [key]=[...counts.entries()].sort((a,b)=>b[1]-a[1])[0]||[];
  if(!key)return fallback;
  return `#${key.split(',').map(value=>Number(value).toString(16).padStart(2,'0')).join('')}`;
}

export async function resizePreservingContent(bytes,width,height){
  const source=await sharp(bytes).rotate().png().toBuffer();
  const metadata=await sharp(source).metadata(),sourceWidth=metadata.width,sourceHeight=metadata.height;
  if(sourceWidth===width&&sourceHeight===height)return {bytes:source,method:'native',sourceWidth,sourceHeight,crop:null,background:'#ffffff'};
  const bounds=await plainBackgroundBounds(source,sourceWidth,sourceHeight);
  if(bounds){
    const margin=Math.ceil(Math.min(sourceWidth,sourceHeight)*0.02);
    const contentLeft=Math.max(0,bounds.left-margin),contentTop=Math.max(0,bounds.top-margin);
    const contentRight=Math.min(sourceWidth,bounds.right+margin),contentBottom=Math.min(sourceHeight,bounds.bottom+margin);
    const contentWidth=contentRight-contentLeft,contentHeight=contentBottom-contentTop;
    if(contentWidth>0&&contentHeight>0){
      const framing={left:contentLeft,top:contentTop,width:contentWidth,height:contentHeight};
      const fill=await dominantColor(source,framing,bounds.background);
      const output=await sharp(source).extract(framing).resize(width,height,{fit:'contain',background:fill,kernel:'lanczos3'}).png().toBuffer();
      return {bytes:output,method:'background-crop',sourceWidth,sourceHeight,crop:framing,background:fill};
    }
  }
  const background=metadata.hasAlpha?'transparent':bounds?.background||'#ffffff';
  const output=await sharp(source).resize(width,height,{fit:'contain',background,kernel:'lanczos3'}).png().toBuffer();
  return {bytes:output,method:'contain',sourceWidth,sourceHeight,crop:null,background};
}

export async function runPreservingResize({session,store,skill,emit,signal,prompt,job,request,sourceId}){
  signal.throwIfAborted();
  const {version:source,bytes}=store.image(session,sourceId);
  if(source.demo)throw new Error('演示图片不能作为改尺寸底图');
  const result=await resizePreservingContent(bytes,request.width,request.height);
  signal.throwIfAborted();
  const target={mode:'pixels',width:request.width,height:request.height,fit:result.method==='cover'?'cover':'contain',background:result.background};
  const product=skill?.workflow==='product-promotion'?productForSource(session,sourceId):null;
  const version=store.addImage(session,result.bytes,{kind:'generated',demo:false,label:`原图等比改尺寸 ${request.width} × ${request.height}`,prompt,parentId:sourceId,renderSourceId:sourceId,renderSourceIds:[sourceId],referenceIds:[sourceId],product,productSourceId:product?.sourceId||null,width:request.width,height:request.height,imageTarget:target,imageGeneration:session.imageGeneration,adaptation:{method:result.method,sourceWidth:result.sourceWidth,sourceHeight:result.sourceHeight,upscaled:request.width>result.sourceWidth||request.height>result.sourceHeight,background:result.background},crop:result.crop,localResize:true,skillId:skill?.id||null,skillVersion:skill?.version||null},{originalBytes:bytes});
  session.imageTarget=target;store.save(session);
  job.productSourceId=product?.sourceId||null;
  const detail=result.method==='background-crop'?'仅裁去纯色背景留白，文字完整保留':result.method==='contain'?'等比缩放并补背景留边，内容完整保留':'尺寸已符合目标';
  emit('image',{text:`已保存 V${version.number} · ${request.width} × ${request.height} px · ${detail} · 未调用 AI`,versionId:version.id});
  return `已将图片调整为 **${request.width} × ${request.height} px**。${detail}；未调用生图模型，原图已保留。`;
}
