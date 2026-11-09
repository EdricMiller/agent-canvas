import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {chromium} from '@playwright/test';
import {createWebApp} from '../server/web.js';
import {composeRaster} from '../server/image-compose.js';

process.exitCode=1;
const project=path.resolve(import.meta.dirname,'..'),root=process.env.CANVAS_TEST_BUILD_ROOT||project;
const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'canvas-compose-browser-')),out=path.join(project,'test-results/compose');fs.mkdirSync(out,{recursive:true});
const instance=await createWebApp({root,dataDir,demo:true,agentModel:'test',imageModel:'test',sandboxMode:'off'});
const session=instance.store.create();session.skillId=null;
const working=await sharp({create:{width:400,height:600,channels:3,background:'#f4e6cd'}}).png().toBuffer(),native=await sharp(working).resize(800,1200).png().toBuffer();
const source=instance.store.addImage(session,working,{kind:'generated',demo:false,width:400,height:600,label:'测试底图',adaptation:{method:'resize',sourceWidth:800,sourceHeight:1200,upscaled:false}},{originalBytes:native});
const logo=await sharp(Buffer.from('<svg width="120" height="120"><rect width="120" height="120" rx="20" fill="#b32327"/><circle cx="60" cy="60" r="20" fill="white"/></svg>')).png().toBuffer();
const oldDesign=instance.documents.create(session.id,{title:'保留的设计稿',width:400,height:600,unit:'px',background:'#ffffff'});
const server=await new Promise((resolve,reject)=>{const s=instance.app.listen(0,'127.0.0.1');s.once('listening',()=>resolve(s));s.once('error',reject);});
let browser;
try{
  browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH}:{})});
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/?session=${session.id}`);await page.locator('#designCanvas').waitFor();
  await page.locator('#composeImageButton').click();await page.locator('#composeLogoInput').setInputFiles({name:'透明 Logo.png',mimeType:'image/png',buffer:logo});
  await page.waitForFunction(()=>document.querySelector('#composeLogo').selectedOptions[0]?.textContent==='透明 Logo.png'&&!document.querySelector('#composeSubmit').disabled);
  const mark=session.versions.at(-1);assert.equal(session.selectedId,source.id);assert.deepEqual(session.referenceIds,[]);
  let natural=await page.locator('#composeOverlay').boundingBox();assert.ok(Math.abs(natural.width-natural.height)<1,'square Logo must have a square drag frame on a portrait poster');
  await page.locator('#compose-width').fill('35');await page.locator('#compose-height').fill('25');await page.locator('#compose-x').fill('10');await page.locator('#compose-y').fill('10');
  assert.equal(Number(await page.locator('#compose-width').inputValue()),37.5,'changing height also scales width');
  const box=await page.locator('#composeOverlay').boundingBox();assert.ok(box);
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2+45,box.y+box.height/2+35,{steps:5});await page.mouse.up();
  assert.ok(Number(await page.locator('#compose-x').inputValue())>10);assert.ok(Number(await page.locator('#compose-y').inputValue())>10);
  for(const [right,bottom] of [[false,false],[true,false],[false,true],[true,true]]){
    const frame=await page.locator('#composePreview').boundingBox(),overlay=await page.locator('#composeOverlay').boundingBox();
    await page.mouse.move(overlay.x+overlay.width/2,overlay.y+overlay.height/2);await page.mouse.down();
    await page.mouse.move(frame.x+(right?frame.width+20:-20),frame.y+(bottom?frame.height+20:-20),{steps:5});await page.mouse.up();
    const edge=await page.locator('#composeOverlay').boundingBox();
    assert.ok(Math.abs((right?edge.x+edge.width:edge.x)-(right?frame.x+frame.width:frame.x))<1,'Logo reaches the horizontal image edge');
    assert.ok(Math.abs((bottom?edge.y+edge.height:edge.y)-(bottom?frame.y+frame.height:frame.y))<1,'Logo reaches the vertical image edge');
    assert.ok(Math.abs(edge.width-edge.height)<1,'dragging preserves the natural aspect ratio');
  }
  for(let i=0;i<35;i++)await page.locator('#composeOpacity').press('ArrowLeft');
  await page.screenshot({path:path.join(out,'dialog-desktop.png'),fullPage:true});
  await page.locator('#composeSubmit').click();await page.getByRole('dialog').waitFor({state:'hidden'});await page.locator('#imageCompositionDetails').waitFor();
  const result=session.versions.at(-1);assert.equal(session.versions.length,3);assert.equal(result.composition.baseId,source.id);assert.equal(result.composition.logoId,mark.id);assert.equal(result.composition.placement.opacity,.65);
  assert.equal(session.job,null);assert.equal(session.messages.length,0);assert.deepEqual(instance.documents.require(session.id),oldDesign);
  const expected=await composeRaster(working,logo,result.composition.placement);
  assert.deepEqual(await sharp(instance.store.image(session,result.id).bytes).raw().toBuffer(),await sharp(expected.bytes).raw().toBuffer());
  const pixels=await sharp(expected.bytes).ensureAlpha().raw().toBuffer();
  const bottomPixel=(599*400+325)*4;assert.notDeepEqual([...pixels.subarray(bottomPixel,bottomPixel+3)],[244,230,205],'saved visible Logo reaches the bottom, matching the drag preview');
  await page.locator('#exportButton').click();const pending=page.waitForEvent('download');await page.locator('#downloadSubmit').click();
  const filename=path.join(out,'combined.png');await(await pending).saveAs(filename);assert.deepEqual(fs.readFileSync(filename),instance.store.image(session,result.id).bytes);
  await page.getByRole('button',{name:'关闭',exact:true}).click();
  await page.locator('#composeImageButton').click();assert.equal(await page.locator('#composeSource').inputValue(),source.id);
  await page.locator('#compose-x').fill('60');await page.locator('#composeSubmit').click();await page.getByRole('dialog').waitFor({state:'hidden'});await page.locator('#imageCompositionDetails').waitFor();
  const moved=session.versions.at(-1);assert.equal(session.versions.length,4);assert.equal(moved.composition.baseId,source.id);assert.equal(moved.composition.placement.x,.6);
  const movedExpected=await composeRaster(working,logo,moved.composition.placement);assert.deepEqual(instance.store.image(session,moved.id).bytes,movedExpected.bytes,'moving must not leave the previous Logo on the base');
  await page.reload();await page.locator('#imageCompositionDetails').waitFor();assert.equal(await page.locator('#canvasImage').getAttribute('src'),moved.url);assert.equal(await page.locator('#designCanvas').count(),0);
  await page.setViewportSize({width:390,height:844});await page.locator('#composeImageButton').click();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth&&document.querySelector('dialog').scrollWidth<=document.querySelector('dialog').clientWidth));
  await page.screenshot({path:path.join(out,'dialog-mobile.png'),fullPage:true});
  await page.locator('#composeLogoInput').setInputFiles({name:'白底图.png',mimeType:'image/png',buffer:working});
  await page.waitForFunction(()=>document.querySelector('#composeLogo').selectedOptions[0]?.textContent==='白底图.png'&&!document.querySelector('#composeSubmit').disabled);
  const count=session.versions.length;await page.locator('#composeSubmit').click();await page.locator('dialog [role="alert"]').waitFor();assert.match(await page.locator('dialog [role="alert"]').innerText(),/透明/);assert.equal(session.versions.length,count);assert.equal(session.selectedId,moved.id);
  assert.deepEqual(errors,[]);console.log('PASS: proportional Logo frame and resizing → drag to all four corners → bottom-edge pixels → exact PNG download → adjust from original base → reload → mobile → opaque rejection. No model calls.');process.exitCode=0;
}catch(error){await browser?.contexts()[0]?.pages()[0]?.screenshot({path:path.join(out,'failure.png'),fullPage:true}).catch(()=>{});throw error;}
finally{await browser?.close();await instance.shutdown();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));fs.rmSync(dataDir,{recursive:true,force:true});}
