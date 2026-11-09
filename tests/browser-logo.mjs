import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {createWebApp} from '../server/web.js';
import {assertTransparentImage} from '../server/image-output.js';
import {mockDesignRuntime} from './helpers/design-agent.mjs';
import {logoWithBrand} from './helpers/logo.mjs';

const project=path.resolve(import.meta.dirname,'..'),root=process.env.CANVAS_TEST_BUILD_ROOT||project;
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'canvas-logo-ui-')),out=path.join(project,'test-results/logo');fs.mkdirSync(out,{recursive:true});
const raw=await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><path d="M90 395Q80 270 200 270Q320 270 310 395" fill="#65836a"/><circle cx="200" cy="158" r="110" fill="#f3c496"/><path d="M85 144Q95 12 200 35Q300 10 315 144Q210 70 85 144" fill="#292830"/><g fill="white" stroke="#24242b" stroke-width="9"><circle cx="156" cy="164" r="35"/><circle cx="244" cy="164" r="35"/><path d="M191 164h18"/></g><g fill="#292830"><circle cx="156" cy="164" r="8"/><circle cx="244" cy="164" r="8"/></g><path d="M175 226Q200 248 225 226" stroke="#b55d54" stroke-width="7" fill="none"/></svg>')).png().toBuffer();
const completeLogo=await logoWithBrand(raw);
let actions=[],imageCalls=0,opaque=false,complete=false;
const mock=mockDesignRuntime(()=>{assert.ok(actions.length,'unexpected model request');const next=actions.shift();return typeof next==='function'?next():next;});
const imageResponse=async(_client,args)=>{imageCalls++;assert.equal(args.background,'transparent');if(complete)assert.match(args.prompt,/菜火生/);const bytes=opaque?await sharp(raw).flatten({background:'white'}).png().toBuffer():complete?completeLogo:raw;return {data:[{b64_json:bytes.toString('base64')}]};};
mock.runtime.imageAdapter={generate:imageResponse,edit:imageResponse};
const instance=await createWebApp({root,dataDir:temp,demo:false,apiKey:'fixture-only',agentModel:'test',imageModel:'test',maxImages:1,maxTurns:8,sandboxMode:'off'},{runtime:mock.runtime});
const session=instance.store.create();
const server=await new Promise((resolve,reject)=>{const s=instance.app.listen(0,'127.0.0.1');s.once('listening',()=>resolve(s));s.once('error',reject);});
const base=`http://127.0.0.1:${server.address().port}`;let browser;
try{
  browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH}:{})});
  const page=await browser.newPage({viewport:{width:1600,height:1050}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+'/?session='+session.id);await page.locator('#skillSelector').click();
  await page.getByRole('button',{name:/品牌 Logo/}).click();
  await page.getByRole('dialog').waitFor({state:'hidden'});
  assert.equal(await page.getByRole('button',{name:'图片创作',exact:true}).getAttribute('aria-pressed'),'true');
  await page.locator('#imageInput').setInputFiles({name:'人物参考.png',mimeType:'image/png',buffer:await sharp(raw).flatten({background:'white'}).png().toBuffer()});
  await page.waitForFunction(()=>document.getElementById('referenceContext')?.textContent.includes('1 / 8')&&!document.getElementById('prompt')?.disabled);
  async function send(text,steps){
    const count=session.messages.filter(m=>m.role==='assistant').length;actions=steps;
    await page.locator('#prompt').fill(text);await page.locator('#sendButton').click();
    await page.waitForFunction(n=>document.querySelectorAll('.message.assistant').length===n&&!document.getElementById('stopButton'),count+1);
    assert.equal(session.job.status,'completed');assert.equal(actions.length,0);
  }
  assert.match(await page.locator('.logo-help').textContent(),/店名与图形统一设计/);
  await send('参考我的照片，生成戴黑色圆框眼镜的Q版人物，配上店名“小菜食堂”，透明底；我需要分层稿，店名作为独立文字编辑。',[
    {name:'read_logo_design',arguments:{}},
    {name:'render_image',arguments:{prompt:'照片人物转Q版，保留黑色圆框眼镜，不含文字',sourceId:null,label:'Q版人物'}},
    ()=>({name:'compose_logo',arguments:{imageId:session.versions.at(-1).id,brandName:'小菜食堂',layout:'stacked',pageId:null,label:'人物与店名'}}),
    '透明 Logo 已生成，人物和店名分别保存，可独立修改。',
  ]);
  await page.locator('#designCanvas[data-ready="true"]').waitFor();
  assert.equal(imageCalls,1);assert.equal(session.referenceIds.length,0);assert.deepEqual(session.messages[0].referenceIds,[session.versions[0].id]);
  const record=instance.documents.require(session.id),logoPage=record.document.pages[0],nameId=logoPage.objects.find(o=>o.type==='text').bindingId;
  assert.equal(await page.locator('#designCanvas').getAttribute('data-page-id'),logoPage.id);
  assert.ok(await page.locator('#designCanvas').evaluate(el=>el.classList.contains('transparency-preview')));
  await page.getByRole('tab',{name:'内容',exact:true}).click();await page.locator(`[data-content="${nameId}"]`).fill('小菜饭馆');
  await page.locator('#saveDesign').click();await page.waitForFunction(()=>document.getElementById('saveDesign')?.disabled);
  assert.equal(instance.documents.require(session.id).document.content[0].value,'小菜饭馆');
  await page.locator('#designCanvas[data-ready="true"]').waitFor();await page.screenshot({path:path.join(out,'desktop.png'),fullPage:true});
  await page.locator('#exportButton').click();assert.match(await page.locator('#transparentDownloadHint').textContent(),/PNG 保留透明/);
  const pending=page.waitForEvent('download');await page.locator('#downloadSubmit').click();const downloaded=await pending,file=path.join(out,'人物与店名-透明.png');await downloaded.saveAs(file);
  await assertTransparentImage(fs.readFileSync(file));
  await page.locator('#downloadFormat').selectOption('jpeg');assert.match(await page.locator('#transparentDownloadHint').textContent(),/白色底/);
  const jpegPending=page.waitForEvent('download');await page.locator('#downloadSubmit').click();const jpeg=await jpegPending,jpegFile=path.join(out,'人物与店名-白底.jpg');await jpeg.saveAs(jpegFile);
  const pixel=await sharp(jpegFile).raw().toBuffer();assert.deepEqual([...pixel.subarray(0,3)],[255,255,255]);
  for(const format of ['svg','eps','ai','pdf']){
    await page.locator('#downloadFormat').selectOption(format);
    if(format==='pdf')await page.locator('#vectorPdf').check();
    assert.equal(await page.locator('#downloadDpi').count(),0,'vector files do not use raster resolution');
    assert.equal(await page.locator('#confirmVectorPreview').count(),0,'format changes must reset the previous confirmation');
    await page.locator('#downloadSubmit').click();await page.locator('#vectorPreview').waitFor({state:'visible'});
    assert.equal(await page.locator('#confirmVectorPreview').isChecked(),false);
    if(format==='svg'){
      await page.locator('#vectorPreview').screenshot({path:path.join(out,'vector-preview.png')});
      await page.setViewportSize({width:390,height:844});
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      await page.locator('#vectorPreview').screenshot({path:path.join(out,'vector-mobile.png')});
      await page.setViewportSize({width:1600,height:1050});
    }
    await page.locator('#confirmVectorPreview').check();const next=page.waitForEvent('download');
    await page.locator('#downloadSubmit').click();const file=await next,target=path.join(out,'人物与店名-矢量.'+format);await file.saveAs(target);
    assert.ok(fs.statSync(target).size>1000);
    if(format==='svg')assert.doesNotMatch(fs.readFileSync(target,'utf8'),/<image|base64|<text/);
    if(format==='ai')assert.match(fs.readFileSync(target,'utf8'),/%AI5_FileFormat 3.0/);
    assert.equal(imageCalls,1,'vector export must not generate another image');
  }
  await page.getByRole('button',{name:'关闭',exact:true}).click();
  await send('只把店名改成“小菜厨房”，人物和排版不变。',[
    {name:'read_logo_design',arguments:{}},
    {name:'compose_logo',arguments:{imageId:session.versions.at(-1).id,brandName:'小菜厨房',layout:'stacked',pageId:logoPage.id,label:'仅修改店名'}},
    '店名已修改，人物和排版保留，没有再次生图。',
  ]);
  await page.waitForFunction(id=>document.querySelector(`[data-content="${id}"]`)?.value==='小菜厨房',nameId);
  assert.equal(imageCalls,1);assert.equal(instance.documents.require(session.id).document.pages.length,1);
  const before=instance.documents.require(session.id).revision;opaque=true;
  await send('再生成一版人物。',[{name:'render_image',arguments:{prompt:'另一版人物',sourceId:session.selectedId,label:'另一版'}},'透明检查失败，未保存不透明结果，已有设计保留。']);
  assert.equal(instance.documents.require(session.id).revision,before);assert.equal(session.versions.length,2);
  assert.ok(session.job.events.some(e=>e.type==='tool_error'&&e.text.includes('透明边缘')));
  opaque=false;complete=true;const layered=JSON.stringify(instance.documents.require(session.id));
  await send('店名准确为“菜火生”，让店名字形、配色与人物、边框一起设计成完整Logo。',[
    {name:'read_logo_design',arguments:{}},
    {name:'render_image',arguments:{prompt:'准确店名「菜火生」必须绘制在Logo内，店名字形、配色与Q版人物、边框统一设计，完整透明Logo',sourceId:session.selectedId,label:'菜火生 · 完整 Logo'}},
    '已生成包含店名的完整 Logo，请核对店名与人物特征。',
  ]);
  await page.locator('#canvasImage').waitFor({state:'visible'});
  assert.equal(session.job.designResult,undefined);assert.equal(imageCalls,3);assert.equal(session.versions.length,3);
  assert.equal(JSON.stringify(instance.documents.require(session.id)),layered,'complete image generation must preserve the earlier layered design');
  assert.match(mock.requests[0].instructions,/默认一体化设计/);
  await page.locator('#canvasImage').screenshot({path:path.join(out,'integrated-logo.png')});
  await page.locator('#exportButton').click();const integratedPending=page.waitForEvent('download');
  await page.locator('#downloadSubmit').click();const integratedDownload=await integratedPending,integratedFile=path.join(out,'菜火生-完整Logo.png');await integratedDownload.saveAs(integratedFile);
  assert.deepEqual(fs.readFileSync(integratedFile),completeLogo);await page.getByRole('button',{name:'关闭',exact:true}).click();
  await page.reload();await page.locator('#canvasImage').waitFor({state:'visible'});
  assert.equal(await page.locator('#designCanvas').count(),0,'reload should keep the newly delivered complete Logo visible');
  assert.equal(await page.getByRole('button',{name:'图片创作',exact:true}).getAttribute('aria-pressed'),'true');
  await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:path.join(out,'mobile.png'),fullPage:true});
  assert.deepEqual(errors,[]);console.log('PASS: Explicit layered Logo → editable brand and all downloads → rename without generation → opaque rejection → complete Logo with baked-in brand → one-image delivery and PNG download → reload retains complete image alongside the older layered document → mobile. Mocked models only.');
}catch(error){process.exitCode=1;throw error;}finally{
  await browser?.close();server.closeAllConnections();await instance.shutdown();await new Promise(resolve=>server.close(resolve));fs.rmSync(temp,{recursive:true,force:true});
}
