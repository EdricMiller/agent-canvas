import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs';
import {createCanvas} from '@napi-rs/canvas';

export async function readAndRenderPdf(bytes,scale=96/72){
  const task=getDocument({data:new Uint8Array(bytes),useSystemFonts:false,isEvalSupported:false});
  try{
    const pdf=await task.promise,page=await pdf.getPage(1),viewport=page.getViewport({scale});
    const canvas=createCanvas(Math.round(viewport.width),Math.round(viewport.height));
    await page.render({canvasContext:canvas.getContext('2d'),viewport}).promise;
    return {text:(await page.getTextContent()).items.map(i=>i.str).join('\n'),png:canvas.toBuffer('image/png'),width:viewport.width,height:viewport.height};
  }finally{await task.destroy();}
}

export async function readPdfPages(bytes){
  const task=getDocument({data:new Uint8Array(bytes),useSystemFonts:false,isEvalSupported:false});
  try{
    const pdf=await task.promise,pages=[];
    for(let n=1;n<=pdf.numPages;n++)pages.push((await(await pdf.getPage(n)).getTextContent()).items.map(i=>i.str).join('\n'));
    return pages;
  }finally{await task.destroy();}
}
