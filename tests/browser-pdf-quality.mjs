import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {chromium} from '@playwright/test';
import {PDFDocument,PDFName,PDFRawStream} from 'pdf-lib';
import {createWebApp} from '../server/web.js';

const root=path.resolve(import.meta.dirname,'..'),dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'canvas-pdf-quality-'));
const instance=await createWebApp({root,dataDir,demo:true,agentModel:'test',imageModel:'test',sandboxMode:'off'});
const session=instance.store.create();
const source=await sharp({create:{width:900,height:1500,channels:3,background:'#8753ad'}}).png().toBuffer();
const working=await sharp(source).resize(180,300).png().toBuffer();
instance.store.addImage(session,working,{kind:'generated',demo:false,width:180,height:300,label:'高清原图测试',adaptation:{method:'resize',sourceWidth:900,sourceHeight:1500,upscaled:false}},{originalBytes:source});
const server=await new Promise((resolve,reject)=>{const s=instance.app.listen(0,'127.0.0.1');s.once('listening',()=>resolve(s));s.once('error',reject);});
let browser;
try{
  browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH}:{})});
  const page=await browser.newPage({viewport:{width:1440,height:900}});
  await page.goto(`http://127.0.0.1:${server.address().port}/?session=${session.id}`);
  await page.locator('#canvasImage').waitFor();
  await page.locator('#exportButton').click();
  await page.getByRole('button',{name:'普通 PDF',exact:true}).click();
  assert.match(await page.locator('#pdfColorHint').innerText(),/高清原图/);
  assert.equal(await page.locator('#downloadDpi').inputValue(),'original');
  const pending=page.waitForEvent('download');await page.locator('#downloadSubmit').click();
  const pdf=await PDFDocument.load(fs.readFileSync(await(await pending).path()));
  assert.ok(Math.abs(pdf.getPage(0).getWidth()-47.63*72/25.4)<.001);
  const image=pdf.context.enumerateIndirectObjects().map(([,object])=>object).find(object=>object instanceof PDFRawStream&&object.dict.get(PDFName.of('Subtype'))?.toString()==='/Image'&&object.dict.get(PDFName.of('ColorSpace'))?.toString()==='/DeviceRGB');
  assert.equal(image.dict.get(PDFName.of('Width')).asNumber(),900);
  assert.equal(image.dict.get(PDFName.of('Height')).asNumber(),1500);
  console.log('PASS: ordinary PDF download embeds the available native image without changing the page size.');
}catch(error){
  console.error(error);process.exitCode=1;
}finally{
  await browser?.close();server.closeAllConnections();await instance.shutdown();await new Promise(resolve=>server.close(resolve));fs.rmSync(dataDir,{recursive:true,force:true});
}
