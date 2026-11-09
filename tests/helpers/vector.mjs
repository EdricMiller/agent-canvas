import sharp from 'sharp';
import {createDocument} from '../../server/design/document.js';
import {layoutDocument} from '../../server/design/render.js';

export const vectorAssetId='29620075-5cf3-4faa-9c7a-aed51acb2a5b';
export async function vectorFixture({text=true,fit='contain'}={}){
  const bytes=await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="160"><circle cx="45" cy="50" r="27" fill="none" stroke="#202020" stroke-width="10"/><circle cx="130" cy="65" r="43" fill="#f6c590"/><g fill="white" stroke="#202020" stroke-width="5"><circle cx="111" cy="65" r="16"/><circle cx="151" cy="65" r="16"/><path d="M127 65h8"/></g><path d="M95 145Q130 100 165 145" fill="#428564"/></svg>')).png().toBuffer();
  const document=createDocument({title:'小菜 Logo <&>',width:300,height:280,unit:'px',background:'transparent'});
  document.pages[0].objects=[{id:'portrait',type:'image',assetId:vectorAssetId,x:20,y:20,width:260,height:208,fit}];
  if(text)document.pages[0].objects.push({id:'brand',type:'text',text:'小菜食堂',x:20,y:235,width:260,height:35,fontSize:14,lineHeight:1.2,align:'center',color:'#202020'});
  const layout=await layoutDocument(document,()=>bytes);
  return {bytes,document,layout,pageId:document.pages[0].id};
}
