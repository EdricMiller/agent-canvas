import {z} from 'zod';
import sharp from 'sharp';
import {targetGeometry} from '../shared/image-target.js';

export const imageTargetGeometry=targetGeometry;
export const imageGenerationSchema=z.object({quality:z.enum(['auto','low','medium','high','xhigh','max']),resolution:z.enum(['auto','2k','4k'])}).strict();
export const imageTargetSchema=z.object({
  mode:z.enum(['pixels','ratio']),width:z.number().int().min(1).max(8192),height:z.number().int().min(1).max(8192),
  fit:z.enum(['contain','cover']),background:z.union([z.string().regex(/^#[\da-f]{6}$/i),z.literal('transparent')]),
}).strict().superRefine((target,ctx)=>{
  const {width,height}=imageTargetGeometry(target);
  if(width<16||height<16||width>8192||height>8192||width*height>25000000)ctx.addIssue({code:'custom',message:'目标图片每边需为 16–8192 像素，且总计不超过 2500 万像素；请调整尺寸或比例'});
});

export function imageTargetPrompt(target,generation,{reflow=false}={}){
  const g=imageTargetGeometry(target,generation);
  const layoutInstruction=reflow?'这是响应式重新排版，不是把原图缩小后放进新画布。以当前编辑底图的内容和视觉风格为基准，按目标横幅重新分配区域、字号和间距，让背景铺满画布；完整保留文字、Logo、价格和菜单内容，不要在中央缩小放置原图，也不要保留原图四周的白色留白。':target.fit==='contain'?`若返回比例不同，将等比完整放入目标画布，以 ${target.background==='transparent'?'透明背景':target.background} 留边；请尽量直接满足目标比例。`:'用户已选择居中裁切填满，请为裁切预留安全区域。';
  return `明确的交付目标：宽 ${g.width} × 高 ${g.height} px，宽高比 ${g.aspectWidth}:${g.aspectHeight}。请按此比例构图，完整保留商品、Logo 和文字，关键内容远离边缘。${layoutInstruction}目标尺寸不表示允许拉伸商品。`;
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

export async function adaptGeneratedImage(input,target,generation,{reflow=false}={}){
  // Normalize EXIF orientation before measuring and fitting. No generation
  // retries, hidden model calls or non-uniform image stretching happen here.
  const source=await sharp(input,{limitInputPixels:40000000}).rotate().png().toBuffer(),metadata=await sharp(source).metadata();
  if(!target)return {bytes:source,width:metadata.width,height:metadata.height,adaptation:null,originalBytes:null};
  const parsed=imageTargetSchema.parse(target),g=imageTargetGeometry(parsed,generation),sameRatio=metadata.width*g.height===metadata.height*g.width;
  const extremeRatio=g.width/g.height>3||g.height/g.width>3;
  let method=metadata.width===g.width&&metadata.height===g.height?'native':sameRatio?'resize':parsed.fit;
  let outputSource=source,outputBackground=parsed.background;
  // Ultra-wide/ultra-tall model responses often contain a large plain border.
  // Trim that border before contain fitting so a banner keeps its full content
  // without displaying the provider's white canvas around it.
  if(method==='contain'&&extremeRatio){
    const bounds=await plainBackgroundBounds(source,metadata.width,metadata.height);
    if(bounds){
      const margin=Math.ceil(Math.min(metadata.width,metadata.height)*0.02);
      const framing={
        left:Math.max(0,bounds.left-margin),top:Math.max(0,bounds.top-margin),
        width:Math.min(metadata.width,bounds.right+margin)-Math.max(0,bounds.left-margin),
        height:Math.min(metadata.height,bounds.bottom+margin)-Math.max(0,bounds.top-margin),
      };
      if(framing.width>0&&framing.height>0){
        outputSource=await sharp(source).extract(framing).png().toBuffer();
        outputBackground=await dominantColor(source,framing,bounds.background);
        method='background-crop';
      }
    }
    if(reflow&&method==='contain'){
      outputBackground=await dominantColor(source,{left:0,top:0,width:metadata.width,height:metadata.height},outputBackground);
    }
  }
  const factor=(parsed.fit==='cover'?Math.max:Math.min)(g.width/metadata.width,g.height/metadata.height);
  const fit=method==='background-crop'?'contain':parsed.fit;
  const bytes=method==='native'?source:await sharp(outputSource).resize(g.width,g.height,{fit,position:'centre',background:outputBackground}).png().toBuffer();
  const actual=await sharp(bytes).metadata();
  if(actual.width!==g.width||actual.height!==g.height)throw new Error('图片尺寸适配失败，未保存不符合目标的结果');
  return {bytes,width:g.width,height:g.height,originalBytes:method==='native'?null:source,adaptation:{method,sourceWidth:metadata.width,sourceHeight:metadata.height,upscaled:factor>1,background:outputBackground}};
}
