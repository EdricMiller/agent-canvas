import express from 'express';
import sharp from 'sharp';
import {PDFDocument} from 'pdf-lib';

export const MAX_CONVERT_BYTES=120*1024*1024;
const MAX_PIXELS=100_000_000;
const MAX_PAGE_MM=5000;

function inputError(message,status=400){return Object.assign(new Error(message),{status});}

export async function imageToPdf(input,widthMm){
  if(!input||typeof input.length!=='number'||!input.length)throw inputError('请选择 PNG、JPG 或 WebP 图片');
  input=Buffer.from(input);
  if(input.length>MAX_CONVERT_BYTES)throw inputError('图片不能超过 120 MB',413);
  let metadata;
  try{metadata=await sharp(input,{limitInputPixels:MAX_PIXELS}).metadata();}
  catch{throw inputError('无法读取图片，或图片像素超过 1 亿');}
  if(!['png','jpeg','webp'].includes(metadata.format)||!metadata.width||!metadata.height)throw inputError('仅支持 PNG、JPG 和 WebP 图片');
  if((metadata.pages||1)>1)throw inputError('暂不支持多帧图片，请先导出单张图片');
  const oriented=[5,6,7,8].includes(metadata.orientation),width=oriented?metadata.height:metadata.width,height=oriented?metadata.width:metadata.height;
  const physicalWidth=widthMm===undefined?Math.min(5000,width*25.4/96):Number(widthMm);
  const physicalHeight=physicalWidth*height/width;
  if(!Number.isFinite(physicalWidth)||physicalWidth<=0||physicalWidth>MAX_PAGE_MM||physicalHeight>MAX_PAGE_MM)throw inputError('成品宽度和高度须在 0–5000 毫米内');
  const pdf=await PDFDocument.create();
  pdf.setTitle('图片转 PDF');pdf.setCreator('画语 Canvas');pdf.setProducer('画语 Canvas image converter');
  const preserveInput=!metadata.orientation||metadata.orientation===1;
  // Normalize JPEG/WebP through Sharp before embedding. This avoids decoder
  // differences between browser uploads and keeps the PDF image stream stable.
  const image=await pdf.embedPng(metadata.format==='png'&&preserveInput?input:await sharp(input,{limitInputPixels:MAX_PIXELS}).rotate().png().toBuffer());
  const mmToPoints=72/25.4,pageWidth=physicalWidth*mmToPoints,pageHeight=physicalHeight*mmToPoints;
  pdf.addPage([pageWidth,pageHeight]).drawImage(image,{x:0,y:0,width:pageWidth,height:pageHeight});
  return {bytes:Buffer.from(await pdf.save({useObjectStreams:false})),width,height,widthMm:physicalWidth,heightMm:physicalHeight};
}

export function registerImagePdfRoute(app){
  app.post('/api/tools/image-to-pdf',express.raw({type:'application/octet-stream',limit:MAX_CONVERT_BYTES}),async(req,res)=>{
    const rawWidth=req.query.widthMm;
    if(typeof rawWidth!=='string'||!/^\d+(?:\.\d+)?$/.test(rawWidth))throw inputError('请输入成品宽度（毫米）');
    const result=await imageToPdf(req.body,Number(rawWidth));
    res.set({'Content-Type':'application/pdf','Content-Disposition':'attachment; filename="converted-image.pdf"','X-Image-Width':String(result.width),'X-Image-Height':String(result.height),'X-Page-Width-Mm':String(result.widthMm),'X-Page-Height-Mm':String(result.heightMm)}).send(result.bytes);
  });
}
