import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {createDocument} from '../../server/design/document.js';

export async function designFixture(){
  const logoId=randomUUID(),photoId=randomUUID();
  const logo=await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="480" height="480"><circle cx="240" cy="240" r="230" fill="#7961cf"/><path d="M240 110v260M110 240h260M148 148l184 184M148 332l184-184" stroke="white" stroke-width="22"/></svg>')).png().toBuffer();
  const photo=await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="500"><rect width="1200" height="500" fill="#dcd7ed"/><circle cx="850" cy="100" r="200" fill="#ac9ed3"/><path d="M0 450Q300 140 650 390T1200 220V500H0Z" fill="#7961cf"/><circle cx="300" cy="220" r="125" fill="#eee9d9"/><path d="M250 300L300 95 350 300Z" fill="#c8a47b"/></svg>')).png().toBuffer();
  const assets=new Map([[logoId,logo],[photoId,photo]]),document=createDocument({title:'画语通用设计验证',width:180,height:240,unit:'mm',background:'#f7f4ed'});
  document.pages[0].objects=[
    {id:'accent',type:'rect',x:14,y:18,width:2,height:22,fill:'#7961cf'},
    {id:'eyebrow',type:'text',x:22,y:18,width:110,height:9,text:'CANVAS / STUDIO NOTES',fontSize:11,color:'#7961cf',align:'left'},
    {id:'logo',type:'image',x:140,y:14,width:26,height:26,assetId:logoId,fit:'contain'},
    {id:'title',type:'text',x:14,y:54,width:152,height:37,text:'让好想法，成为好设计',fontSize:28,color:'#292a31',align:'left'},
    {id:'body',type:'text',x:14,y:91,width:152,height:26,text:'从文字、图片和品牌素材开始。\n自由设置尺寸，持续修改，清晰交付。',fontSize:12,color:'#655e71',align:'left'},
    {id:'photo',type:'image',x:14,y:125,width:152,height:62,assetId:photoId,fit:'cover'},
    {id:'caption',type:'text',x:14,y:195,width:152,height:12,text:'独立文字 / 自定义尺寸 / 图片与 Logo / 矢量 PDF',fontSize:10,color:'#655e71',align:'left'},
    {id:'footer',type:'text',x:14,y:217,width:152,height:10,text:'DESIGN IS AN ONGOING CONVERSATION.       01',fontSize:9,color:'#000000',align:'left'},
  ];
  return {document,assets,logoId,photoId,resolveAsset:id=>{if(!assets.has(id))throw new Error('missing');return assets.get(id);}};
}
