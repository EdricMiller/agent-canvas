import {recolorImage} from './image-colors.js';
import {printImageSource} from './design/print-source.js';

export async function editImageColors({session,store,sourceId,regions,protect=[],label,skill,signal}){
  const {version:source,bytes}=store.image(session,sourceId);
  if(source.demo)throw new Error('演示图片不可用于局部换色');
  const result=await recolorImage(bytes,regions,{signal,protect});
  // Use the same native canvas as PDF export, including existing crop/padding.
  // Edit it separately so the working image's untouched pixels stay identical.
  const native=source.sourceUrl?await recolorImage(await printImageSource(store,session,sourceId),regions,{signal,protect}):null;
  signal?.throwIfAborted();
  return store.addImage(session,result.bytes,{
    kind:'generated',demo:false,label,parentId:sourceId,renderSourceId:sourceId,renderSourceIds:[sourceId],
    referenceIds:source.referenceIds||[],productSourceId:source.productSourceId||null,...(source.product?{product:structuredClone(source.product)}:{}),
    skillId:skill?.id||source.skillId||null,skillVersion:skill?.version||source.skillVersion||null,
    width:result.width,height:result.height,imageTarget:source.imageTarget||null,imageGeneration:source.imageGeneration,
    background:source.background,transparency:source.transparency,
    adaptation:native?{method:'resize',sourceWidth:native.width,sourceHeight:native.height,upscaled:native.width<result.width||native.height<result.height,background:source.adaptation?.background||'#ffffff'}:null,
    localEdit:{type:'recolor',regions,protect,changedPixels:result.changedPixels,preservedPixels:result.preservedPixels,nativeWidth:native?.width||result.width,nativeHeight:native?.height||result.height},
  },{originalBytes:native?.bytes});
}
