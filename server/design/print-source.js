import sharp from 'sharp';
import {nativePrintGeometry} from '../../shared/print-image.js';

export async function printImageSource(store,session,id,{preferWorkingPixels=false}={}){
  const working=store.image(session,id),{version}=working;
  if(!version.sourceUrl)return working.bytes;
  const source=store.image(session,id,{original:true}).bytes;
  const [display,original]=await Promise.all([sharp(working.bytes).metadata(),sharp(source,{limitInputPixels:40000000}).metadata()]);
  const fit=version.adaptation?.method==='cover'?'cover':'contain';
  const size=nativePrintGeometry(display.width,display.height,original.width,original.height,fit);
  if(preferWorkingPixels&&size.width*size.height<=display.width*display.height)return working.bytes;
  if(size.width===original.width&&size.height===original.height)return source;
  return sharp(source,{limitInputPixels:40000000}).resize(size.width,size.height,{fit,position:'centre',background:version.adaptation?.background||'#ffffff'}).png().toBuffer();
}
