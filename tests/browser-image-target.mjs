import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {createWebApp} from '../server/web.js';
import {mockDesignRuntime} from './helpers/design-agent.mjs';

const root=path.resolve(import.meta.dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'canvas-image-target-ui-'));
const out=path.join(root,'test-results/image-target');fs.mkdirSync(out,{recursive:true});
const target={mode:'pixels',width:585,height:1080,fit:'contain',background:'#ffffff'};
const raw=await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" fill="#eee4cf"/><circle cx="200" cy="180" r="90" fill="#425b48"/><path d="M100 175 Q200 330 300 175" fill="#cfa56a"/><text x="200" y="330" text-anchor="middle" font-size="24" fill="#425b48">PRODUCT / FIXTURE</text></svg>')).png().toBuffer();
let actions=[],imageCalls=0,honorNativeSize=false;const imageRequests=[];
const mock=mockDesignRuntime(()=>{assert.ok(actions.length,'unexpected conversation request');return actions.shift();});
async function imageResponse(kind,args){imageCalls++;imageRequests.push({kind,...args});const [width,height]=args.size.split('x').map(Number);const bytes=honorNativeSize?await sharp({create:{width,height,channels:3,background:'#436e62'}}).png().toBuffer():raw;return {data:[{b64_json:bytes.toString('base64')}]};}
mock.runtime.imageAdapter={generate:(_client,args)=>imageResponse('generate',args),edit:(_client,args)=>imageResponse('edit',args)};
const instance=await createWebApp({root,dataDir:temp,demo:false,apiKey:'fixture-only',agentModel:'test',imageModel:'gpt-image-2.5-sunburst',maxImages:1,maxTurns:8,sandboxMode:'off'},{runtime:mock.runtime});
const session=instance.store.create();session.skillId=null;instance.store.save(session);
const server=await new Promise((resolve,reject)=>{const s=instance.app.listen(0,'127.0.0.1');s.once('listening',()=>resolve(s));s.once('error',reject);});
const base=`http://127.0.0.1:${server.address().port}`;let browser,page;
try{
  browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH}:{})});
  page=await browser.newPage({viewport:{width:1600,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+'/?session='+session.id);await page.getByRole('button',{name:'图片创作',exact:true}).click();
  assert.match(await page.locator('#imageTargetStatus').textContent(),/尺寸随对话确定/);
  await page.locator('#editImageTarget').click();assert.equal(await page.locator('#imageTargetMode').inputValue(),'auto');
  await page.locator('#imageGenerationQuality').selectOption('medium');await page.locator('#saveImageTarget').click();await page.getByRole('dialog').waitFor({state:'hidden'});
  assert.equal(session.imageTarget,null,'quality-only changes never invent fixed dimensions');assert.equal(session.imageGeneration.quality,'medium');assert.equal(imageCalls,0);
  await page.locator('#editImageTarget').click();await page.locator('#imageGenerationQuality').selectOption('high');await page.locator('#saveImageTarget').click();await page.getByRole('dialog').waitFor({state:'hidden'});
  async function send(text,steps){
    const count=session.messages.filter(m=>m.role==='assistant').length;actions=steps;
    await page.locator('#prompt').fill(text);await page.locator('#sendButton').click();
    await page.waitForFunction(n=>document.querySelectorAll('.message.assistant').length===n&&!document.getElementById('stopButton'),count+1);
    assert.equal(session.job.status,'completed');assert.equal(actions.length,0);
  }
  async function render(text='开始制作。'){
    const previous=session.versions.length;
    await send(text,[{name:'render_image',arguments:{prompt:text,sourceId:session.selectedId,label:`产品广告 ${previous+1}`}},'已完成，请查看画布中的实际尺寸和适配说明。']);
    await page.waitForFunction(()=>document.getElementById('canvasImage')?.complete&&document.getElementById('canvasImage')?.naturalWidth>0);
    assert.equal(session.versions.length,previous+1);return session.versions.at(-1);
  }
  await send('先确认广告图：宽585，高1080像素。现在不要生成。',[{name:'set_image_target',arguments:{target}},'已确认宽585、高1080像素，比例13:24。']);
  assert.equal(imageCalls,0);assert.equal(session.versions.length,0);assert.match(await page.locator('#imageTargetStatus').textContent(),/585 × 1080 px/);
  await page.reload();await page.locator('#imageTargetStatus').waitFor();assert.equal(await page.getByRole('button',{name:'图片创作',exact:true}).getAttribute('aria-pressed'),'true');
  const first=await render('按刚才确认的尺寸制作产品广告，保持产品完整。');
  assert.equal(await page.locator('#pageUnit').count(),0,'image mode does not show unrelated editable-canvas dimensions');assert.match(await page.getByLabel('图片信息',{exact:true}).textContent(),/585 × 1080 px/);
  assert.deepEqual([first.width,first.height],[585,1080]);assert.match(await page.locator('#imageOutputDetails').textContent(),/等比适配并留边/);
  assert.deepEqual(await page.locator('#canvasImage').evaluate(img=>[img.naturalWidth,img.naturalHeight]),[585,1080]);
  await page.screenshot({path:path.join(out,'desktop.png'),fullPage:true});
  for(const format of ['png','jpeg']){
    await page.locator('#exportButton').click();await page.locator('#downloadFormat').selectOption(format);
    const pending=page.waitForEvent('download');await page.locator('#downloadSubmit').click();const download=await pending,file=path.join(out,`585x1080.${format}`);await download.saveAs(file);
    const meta=await sharp(file).metadata();assert.deepEqual([meta.width,meta.height],[585,1080]);
    await page.getByRole('button',{name:'关闭',exact:true}).click();
  }
  const pendingRaw=page.waitForEvent('download');await page.getByRole('link',{name:/下载适配前原图/}).click();const original=await pendingRaw;const originalFile=path.join(out,'original.png');await original.saveAs(originalFile);
  const originalMeta=await sharp(originalFile).metadata();assert.deepEqual([originalMeta.width,originalMeta.height],[400,400]);assert.equal(session.versions.length,1);
  await render('把配色改成蓝色，其他尺寸不变。');assert.deepEqual(session.versions.at(-1).imageTarget,target);
  await page.locator('#editImageTarget').click();await page.locator('#imageTargetWidth').fill('8192');await page.locator('#imageTargetHeight').fill('8192');await page.locator('#saveImageTarget').click();
  await page.getByRole('alert').filter({hasText:'2500'}).waitFor();assert.deepEqual(session.imageTarget,target);assert.equal(await page.getByRole('dialog').count(),1,'failed save keeps settings open');
  await page.locator('#imageTargetWidth').fill('585');await page.locator('#imageTargetHeight').fill('1080');await page.locator('#imageTargetMode').selectOption('ratio');
  assert.equal(await page.locator('#imageTargetWidth').inputValue(),'13');assert.equal(await page.locator('#imageTargetHeight').inputValue(),'24');
  await page.locator('#saveImageTarget').click();await page.getByRole('dialog').waitFor({state:'hidden'});
  assert.deepEqual([first.width,first.height],[585,1080],'setting a new target never changes existing images');
  const ratio=await render('按13:24制作另一版。');assert.deepEqual([ratio.width,ratio.height],[832,1536]);
  await page.locator('#editImageTarget').click();await page.locator('#imageTargetMode').selectOption('pixels');await page.locator('#imageTargetWidth').fill('585');await page.locator('#imageTargetHeight').fill('1080');await page.locator('#imageTargetFit').selectOption('cover');await page.locator('#saveImageTarget').click();await page.getByRole('dialog').waitFor({state:'hidden'});
  const cropped=await render('允许居中裁切，制作填满画布的一版。');assert.equal(cropped.adaptation.method,'cover');assert.match(await page.locator('#imageOutputDetails').textContent(),/已居中裁切适配/);
  await page.getByRole('button',{name:'选择图片版本 1',exact:true}).click();await page.waitForFunction(()=>document.getElementById('imageTargetStatus')?.textContent.includes('完整保留画面'));assert.deepEqual(session.imageTarget,target);
  await page.locator('#editImageTarget').click();await page.getByRole('button',{name:'取消固定尺寸',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});assert.equal(session.imageTarget,null);assert.match(await page.locator('#imageTargetStatus').textContent(),/尺寸随对话确定/);
  await page.getByRole('button',{name:'选择图片版本 3',exact:true}).click();await page.waitForFunction(()=>document.getElementById('imageTargetStatus')?.textContent.includes('832 × 1536'));
  await page.reload();await page.locator('#imageTargetStatus').waitFor();assert.match(await page.locator('#imageTargetStatus').textContent(),/13:24 比例/);
  const panorama={...target,mode:'ratio',width:21,height:9};
  await send('后续换成21:9的横向比例，先确认。',[{name:'set_image_target',arguments:{target:panorama}},'后续改为21:9。']);
  assert.match(await page.locator('#imageTargetStatus').textContent(),/21:9 比例/);
  const wide=await render('按新比例制作横向产品图。');assert.equal(wide.width*9,wide.height*21);assert.equal(wide.imageTarget.width,21);assert.match(await page.locator('#imageOutputDetails').textContent(),/目标 21:9/);
  assert.match(await page.locator('#imageOutputDetails').textContent(),/服务返回尺寸与请求不同/,'provider mismatch is visible, never presented as native high resolution');
  await page.locator('#editImageTarget').click();await page.locator('#imageTargetWidth').fill('13');await page.locator('#imageTargetHeight').fill('24');
  await page.locator('#imageGenerationQuality').selectOption('max');await page.locator('#imageGenerationResolution').selectOption('4k');
  assert.match(await page.locator('#imageGenerationPreview').textContent(),/2080 × 3840 px/);await page.screenshot({path:path.join(out,'high-resolution-settings.png'),fullPage:true});
  await page.locator('#saveImageTarget').click();await page.getByRole('dialog').waitFor({state:'hidden'});
  await page.reload();await page.locator('#imageTargetStatus').waitFor();assert.match(await page.locator('#imageTargetStatus').textContent(),/4K/);
  honorNativeSize=true;
  const high=await render('以当前4K最高精细度做一版。');assert.deepEqual([high.width,high.height],[2080,3840]);assert.equal(high.adaptation.method,'native');assert.equal(high.adaptation.upscaled,false);
  assert.equal(imageRequests.at(-1).size,'2080x3840');assert.equal(imageRequests.at(-1).quality,'max');assert.match(await page.locator('#imageOutputDetails').textContent(),/模型返回 2080 × 3840 px/);
  await page.screenshot({path:path.join(out,'high-resolution-output.png'),fullPage:true});
  await page.locator('#editImageTarget').click();await page.locator('#imageTargetMode').selectOption('pixels');await page.locator('#imageTargetWidth').fill('585');await page.locator('#imageTargetHeight').fill('1080');await page.locator('#imageGenerationQuality').selectOption('xhigh');await page.locator('#saveImageTarget').click();await page.getByRole('dialog').waitFor({state:'hidden'});
  const delivery=await render('保留高清原图，按585×1080交付。');assert.equal(imageRequests.at(-1).kind,'edit');assert.equal(imageRequests.at(-1).size,'2080x3840');assert.equal(imageRequests.at(-1).quality,'xhigh');assert.deepEqual([delivery.width,delivery.height],[585,1080]);assert.equal(delivery.adaptation.upscaled,false);
  const highDownload=page.waitForEvent('download');await page.getByRole('link',{name:/下载适配前原图/}).click();const highFile=path.join(out,'native-4k.png');await(await highDownload).saveAs(highFile);const highMeta=await sharp(highFile).metadata();assert.deepEqual([highMeta.width,highMeta.height],[2080,3840]);
  await page.getByRole('button',{name:'选择图片版本 3',exact:true}).click();await page.waitForFunction(()=>document.getElementById('imageTargetStatus')?.textContent.includes('832 × 1536'));assert.equal(session.imageGeneration.resolution,'auto');
  await page.getByRole('button',{name:'选择图片版本 7',exact:true}).click();await page.waitForFunction(()=>document.getElementById('imageTargetStatus')?.textContent.includes('4K'));assert.equal(session.imageGeneration.quality,'xhigh');
  await page.setViewportSize({width:390,height:844});await page.locator('#editImageTarget').scrollIntoViewIfNeeded();
  assert.ok(await page.locator('#editImageTarget').isVisible());assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:path.join(out,'mobile.png'),fullPage:true});
  await page.locator('#editImageTarget').click();await page.getByRole('dialog').waitFor();assert.ok(await page.locator('#imageTargetWidth').isVisible());assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  assert.ok(await page.locator('#saveImageTarget').evaluate(el=>{const r=el.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;}),'mobile confirmation remains visible without scrolling');
  await page.screenshot({path:path.join(out,'mobile-settings.png'),fullPage:true});
  assert.equal(imageCalls,7);assert.deepEqual(errors,[]);assert.equal(session.versions.length,7);
  console.log('PASS: dialogue confirmation → generation → inherited edit → exact PNG/JPG downloads; native 4K + max/xhigh requests, original high resolution downloads, mismatch disclosure, history, reload and mobile. No real AI requests.');
}catch(error){
  await page?.screenshot({path:path.join(out,'failure.png'),fullPage:true}).catch(()=>{});console.error(error);process.exitCode=1;
}finally{
  await browser?.close();server.closeAllConnections();await instance.shutdown();await new Promise(resolve=>server.close(resolve));fs.rmSync(temp,{recursive:true,force:true});
}
