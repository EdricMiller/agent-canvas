import {targetGeometry} from './image-target.js';

export const DEFAULT_IMAGE_GENERATION=Object.freeze({quality:'high',resolution:'auto'});
export const QUALITY_LABELS=Object.freeze({auto:'自动',low:'快速预览',medium:'标准',high:'精细',xhigh:'更精细',max:'最高精细度'});
export function generationSettings(value){return {...DEFAULT_IMAGE_GENERATION,...value};}
export function customImageSizes(model,baseURL){
  if(!/^gpt-image-2(?:[.-]|$)/.test(model||''))return false;
  if(baseURL&&/(?:api\.apiyi\.com|ffka\.com)(?:\/|$)/i.test(baseURL))return false;
  return true;
}
export function extendedImageQuality(model){return /^gpt-image-2\.5-(?:sunburst|flare)(?:-|$)/.test(model||'');}

// Images API: 16px grid, <=3840px edges, 1:3–3:1, 655,360–8,294,400px.
// Keep delivery geometry independent from native model sizes. Never stretch an
// image or silently retry a rejected request at a lower quality/resolution.
export function imageGenerationPlan(target,value,model,fallbackSize='auto',baseURL){
  const settings=generationSettings(value);
  if(['xhigh','max'].includes(settings.quality)&&!extendedImageQuality(model))throw new Error('当前模型不支持此精细度，请选择 high 或切换 GPT Image 2.5 模型');
  if(!customImageSizes(model,baseURL)){
    if(settings.resolution!=='auto')throw new Error('当前模型未接入自定义高清尺寸，请切换 GPT Image 2 系列模型');
    return {size:fallbackSize,quality:settings.quality,width:null,height:null,experimental:false,adapted:false};
  }
  if(!target){
    if(settings.resolution!=='auto')throw new Error('请先指定图片尺寸或宽高比，再选择 2K / 4K 分辨率');
    return {size:fallbackSize,quality:settings.quality,width:null,height:null,experimental:false,adapted:false};
  }
  const g=targetGeometry(target,settings),ratio=g.width/g.height,clampedRatio=Math.max(1/3,Math.min(3,ratio));
  const edge=settings.resolution==='4k'?3840:settings.resolution==='2k'?2048:Math.min(3840,Math.max(g.width,g.height));
  const desiredArea=Math.min(8294400,Math.max(655360,edge*edge/Math.max(clampedRatio,1/clampedRatio)));
  const maxEdge=settings.resolution==='2k'?2048:3840;
  let best=null;
  const consider=(width,height,exact)=>{
    const area=width*height;
    if(width<16||height<16||width>maxEdge||height>maxEdge||area<655360||area>8294400||Math.max(width/height,height/width)>3)return;
    const score=Math.abs(Math.log((width/height)/clampedRatio))*20+Math.abs(Math.log(area/desiredArea));
    if(!best||exact&&!best.exact||exact===best.exact&&score<best.score)best={width,height,score,exact};
  };
  if(ratio>=1/3&&ratio<=3)for(let scale=16;scale*Math.max(g.aspectWidth,g.aspectHeight)<=maxEdge;scale+=16)consider(g.aspectWidth*scale,g.aspectHeight*scale,true);
  if(!best)for(let width=16;width<=maxEdge;width+=16){
    const height=Math.round(width/clampedRatio/16)*16;
    for(const h of [height-16,height,height+16])consider(width,h,false);
  }
  if(!best)throw new Error('无法为该比例匹配模型支持的尺寸，请调整图片尺寸');
  return {size:`${best.width}x${best.height}`,quality:settings.quality,width:best.width,height:best.height,experimental:best.width*best.height>3686400,adapted:best.width!==g.width||best.height!==g.height};
}
