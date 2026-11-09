import sharp from 'sharp';

// Inspect actual pixels, not the file extension or the existence of an alpha
// channel. This verifies transparency, not semantic foreground extraction.
export async function inspectTransparency(bytes){
  const image=sharp(bytes,{limitInputPixels:40000000}),metadata=await image.metadata();
  if(!metadata.hasAlpha)return {hasTransparency:false,transparentPixels:0,visiblePixels:metadata.width*metadata.height,edgeTransparentPixels:0};
  const {data,info}=await image.extractChannel('alpha').raw().toBuffer({resolveWithObject:true});
  let transparentPixels=0,visiblePixels=0,edgeTransparentPixels=0;
  for(let i=0;i<data.length;i++){
    if(data[i]>0)visiblePixels++;
    if(data[i]===0){
      transparentPixels++;
      const x=i%info.width,y=Math.floor(i/info.width);
      if(x===0||y===0||x===info.width-1||y===info.height-1)edgeTransparentPixels++;
    }
  }
  return {hasTransparency:transparentPixels>0&&visiblePixels>0&&edgeTransparentPixels>0,transparentPixels,visiblePixels,edgeTransparentPixels};
}

export async function assertTransparentImage(bytes){
  const result=await inspectTransparency(bytes);
  if(!result.hasTransparency)throw Object.assign(new Error(result.visiblePixels===0?'服务商返回了全透明空图，未保存为 Logo。请检查模型结果。':'返回图片未检测到透明边缘，未保存为透明 Logo。请确认所选生图模型和中转站支持透明背景；白底或棋盘格图片不能作为透明文件交付。'),{code:'TRANSPARENCY_MISSING',status:422});
  return result;
}
