import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {createDocument} from '../../server/design/document.js';
import {layoutDocument,renderPreview} from '../../server/design/render.js';

// A deterministic provider-response fixture with baked-in brand lettering.
// It checks the complete-image delivery path, not AI art direction or OCR.
export async function logoWithBrand(portrait,brandName='菜火生'){
  const document=createDocument({title:'完整 Logo 测试图',width:480,height:480,unit:'px',background:'transparent'});
  document.pages[0].objects=[
    {id:'portrait',type:'image',assetId:randomUUID(),x:70,y:10,width:340,height:340,fit:'contain'},
    {id:'banner',type:'rect',x:45,y:330,width:390,height:110,fill:'#b91b21'},
    {id:'brand',type:'text',text:brandName,x:65,y:348,width:350,height:70,fontSize:32,lineHeight:1.2,align:'center',color:'#ffffff'},
  ];
  const rendered=await renderPreview(await layoutDocument(document,()=>portrait),{pageId:document.pages[0].id});
  return sharp(rendered.bytes).rotate().png().toBuffer();
}
