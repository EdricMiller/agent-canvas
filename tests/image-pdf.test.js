import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {PDFDocument,PDFName,PDFRawStream,decodePDFRawStream} from 'pdf-lib';
import {createApp} from '../server/app.js';

async function fixture(t){
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'canvas-image-pdf-'));
  const instance=createApp({root:path.resolve(import.meta.dirname,'..'),dataDir,demo:true,agentModel:'test',imageModel:'test',sandboxMode:'off'});
  const server=await new Promise((resolve,reject)=>{const s=instance.app.listen(0,'127.0.0.1');s.once('listening',()=>resolve(s));s.once('error',reject);});
  t.after(()=>{instance.shutdown();server.closeAllConnections();server.close();fs.rmSync(dataDir,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}`,config=await(await fetch(base+'/api/config')).json();
  const post=(bytes,widthMm='240',token=config.token)=>fetch(`${base}/api/tools/image-to-pdf?widthMm=${widthMm}`,{method:'POST',headers:{'Content-Type':'application/octet-stream','X-Studio-Token':token},body:bytes});
  return {post};
}

function embeddedImage(pdf){
  return pdf.context.enumerateIndirectObjects().map(([,object])=>object).find(object=>object instanceof PDFRawStream&&object.dict.get(PDFName.of('Subtype'))?.toString()==='/Image');
}

test('standalone PNG conversion preserves pixels and exact aspect ratio at requested print width',async t=>{
  const {post}=await fixture(t),width=120,height=28,pixels=Buffer.alloc(width*height*3);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++)pixels.set([(x*19)%256,(y*37)%256,((x+y)*13)%256],(y*width+x)*3);
  const png=await sharp(pixels,{raw:{width,height,channels:3}}).png().toBuffer(),response=await post(png);
  assert.equal(response.status,200,await response.clone().text());
  assert.equal(response.headers.get('content-type'),'application/pdf');
  assert.equal(Number(response.headers.get('x-page-height-mm')),56);
  const pdf=await PDFDocument.load(await response.arrayBuffer()),page=pdf.getPage(0),image=embeddedImage(pdf);
  assert.equal(pdf.getPages().length,1);
  assert.ok(Math.abs(page.getWidth()*25.4/72-240)<1e-6);
  assert.ok(Math.abs(page.getHeight()*25.4/72-56)<1e-6);
  assert.equal(image.dict.get(PDFName.of('Width')).asNumber(),width);
  assert.equal(image.dict.get(PDFName.of('Height')).asNumber(),height);
  assert.deepEqual(Buffer.from(decodePDFRawStream(image).decode()),pixels);
});

test('standalone JPG and WebP convert to full-resolution PDF image streams',async t=>{
  const {post}=await fixture(t),source=await sharp({create:{width:41,height:19,channels:3,background:'#ac2042'}}).png().toBuffer();
  const jpg=await sharp(source).jpeg({quality:92}).toBuffer(),jpegResponse=await post(jpg,'410');
  assert.equal(jpegResponse.status,200,await jpegResponse.clone().text());
  const jpegImage=embeddedImage(await PDFDocument.load(await jpegResponse.arrayBuffer()));
  assert.equal(jpegImage.dict.get(PDFName.of('Width')).asNumber(),41);
  assert.equal(jpegImage.dict.get(PDFName.of('Height')).asNumber(),19);
  const webp=await sharp(source).webp({lossless:true}).toBuffer(),webpResponse=await post(webp,'410');
  assert.equal(webpResponse.status,200,await webpResponse.clone().text());
  const webpImage=embeddedImage(await PDFDocument.load(await webpResponse.arrayBuffer()));
  assert.equal(webpImage.dict.get(PDFName.of('Width')).asNumber(),41);
  assert.equal(webpImage.dict.get(PDFName.of('Height')).asNumber(),19);
});

test('standalone conversion rejects invalid inputs and requires the page token',async t=>{
  const {post}=await fixture(t),png=await sharp({create:{width:20,height:10,channels:3,background:'#fff'}}).png().toBuffer();
  assert.equal((await post(png,'100','invalid')).status,403);
  assert.equal((await post(png,'0')).status,400);
  assert.equal((await post(png,'5001')).status,400);
  assert.equal((await post(Buffer.from('not an image'))).status,400);
});
