// Preserve the displayed crop/padding while using the source at its native
// resolution. Upscaled working images must not count as extra print detail.
export function nativePrintGeometry(width,height,sourceWidth,sourceHeight,fit='contain'){
  const nativeScale=(fit==='cover'?Math.min:Math.max)(sourceWidth/width,sourceHeight/height);
  const scale=Math.min(nativeScale,Math.sqrt(25000000/(width*height)));
  return {width:Math.max(1,Math.floor(width*scale+1e-6)),height:Math.max(1,Math.floor(height*scale+1e-6))};
}
