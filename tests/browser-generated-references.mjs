import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {createWebApp} from '../server/web.js';
import {mockDesignRuntime} from './helpers/design-agent.mjs';

const root=path.resolve(import.meta.dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'canvas-generated-reference-ui-'));
const out=path.join(root,'test-results/generated-references');fs.mkdirSync(out,{recursive:true});
const image=async color=>sharp({create:{width:360,height:480,channels:3,background:color}}).png().toBuffer();
const firstBytes=await image('#a51d25'),latestBytes=await image('#345578');
let session,first,latest,imageCalls=0;
const mock=mockDesignRuntime((body,index)=>{
  if(index===0){
    const content=body.input.filter(m=>m.role==='user').at(-1).content;
    assert.equal(content.filter(c=>c.type==='input_image').length,2,'selected design and historical reference both reach vision');
    assert.match(JSON.stringify(content),/参考图 1 · V1 · 红色海报/);
    return {name:'render_image',arguments:{prompt:'参考红色海报的配色修改当前图片',sourceId:latest.id,label:'参考旧版创作'}};
  }
  assert.equal(index,1);return '已参考指定图片版本完成创作。';
});
mock.runtime.imageAdapter={edit:async(_client,_args,images)=>{
  imageCalls++;
  assert.equal(images.length,2);
  assert.deepEqual(images[0],latestBytes);
  assert.deepEqual(images[1],firstBytes,'the chosen historical version reaches the image provider');
  return {data:[{b64_json:latestBytes.toString('base64')}]};
},generate:async()=>{throw new Error('references must use image edits');}};
const instance=await createWebApp({root,dataDir:temp,demo:false,apiKey:'fixture-only',agentModel:'test',imageModel:'test',maxImages:1,maxTurns:8,sandboxMode:'off'},{dev:true,runtime:mock.runtime});
session=instance.store.create();session.skillId=null;
first=instance.store.addImage(session,firstBytes,{kind:'generated',demo:false,width:360,height:480,label:'红色海报'});
latest=instance.store.addImage(session,latestBytes,{kind:'generated',demo:false,width:360,height:480,label:'蓝色海报'});
const demo=instance.store.addImage(session,firstBytes,{kind:'generated',demo:true,width:360,height:480,label:'演示海报'});
session.selectedId=latest.id;instance.store.save(session);
const server=await new Promise((resolve,reject)=>{const s=instance.app.listen(0,'127.0.0.1');s.once('listening',()=>resolve(s));s.once('error',reject);});
const base=`http://127.0.0.1:${server.address().port}`;let browser;
try{
  browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH}:{})});
  const page=await browser.newPage({viewport:{width:1600,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  const waitReferences=async n=>page.waitForFunction(count=>document.querySelectorAll('[data-reference]').length===count&&!document.getElementById('attachButton')?.disabled,n);
  const select=async version=>{await page.getByRole('button',{name:`选择图片版本 ${version.number}`,exact:true}).click();await page.waitForFunction(id=>document.getElementById('canvasImage')?.getAttribute('src')===`/images/${id}.png`&&!document.getElementById('useImageAsReference')?.disabled,version.id);};
  await page.goto(base+'/?session='+session.id);await page.locator('#canvasImage').waitFor();
  const useReference=page.locator('#useImageAsReference');
  await select(first);await useReference.click();await waitReferences(1);
  assert.equal(await useReference.getAttribute('aria-pressed'),'true');assert.deepEqual(session.referenceIds,[first.id]);
  assert.equal(session.versions.length,3,'attaching a version creates no duplicate image');
  await page.reload();await waitReferences(1);assert.equal(await useReference.getAttribute('aria-pressed'),'true');
  await useReference.click();await waitReferences(0);await useReference.click();await waitReferences(1);
  await page.getByRole('button',{name:'移除参考图 1',exact:true}).click();await waitReferences(0);
  await useReference.click();await waitReferences(1);await select(latest);
  assert.equal(await useReference.getAttribute('aria-pressed'),'false');assert.deepEqual(session.referenceIds,[first.id]);
  await page.screenshot({path:path.join(out,'desktop.png'),fullPage:true});
  await page.locator('#prompt').fill('参考第一张的红色配色，修改当前蓝色海报。');
  await page.route('**/api/sessions/*/turns',route=>route.fulfill({status:503,json:{error:'测试：消息未提交'}}));
  const rejected=page.waitForResponse(response=>response.url().endsWith('/turns')&&response.status()===503);
  await page.locator('#sendButton').click();await rejected;await waitReferences(1);
  assert.deepEqual(session.referenceIds,[first.id],'failed submission preserves the chosen reference');
  await page.unroute('**/api/sessions/*/turns');await page.locator('#sendButton').click();
  await page.waitForFunction(()=>document.querySelectorAll('.message.assistant').length===1&&!document.getElementById('stopButton'));
  await waitReferences(0);assert.equal(session.job.status,'completed');assert.equal(imageCalls,1);
  assert.deepEqual(session.messages[0].referenceIds,[first.id]);assert.equal(await page.locator('.message-attachments img').count(),1);
  assert.equal(await page.locator('.message-attachments img').getAttribute('src'),first.url);
  assert.deepEqual(session.versions.at(-1).referenceIds,[first.id]);
  await page.reload();await waitReferences(0);assert.equal(await page.locator('.message-attachments img').count(),1);

  const result=session.versions.at(-1),uploads=[];
  for(let i=0;i<8;i++)uploads.push(instance.store.addImage(session,firstBytes,{kind:'upload',demo:false,width:360,height:480,label:`素材 ${i+1}`},{reference:false}));
  session.referenceIds=uploads.map(v=>v.id);instance.store.save(session);
  await page.reload();await waitReferences(8);assert.equal(await useReference.isDisabled(),true);
  assert.match(await useReference.getAttribute('title'),/最多 8 张/);
  await page.getByRole('button',{name:'移除参考图 1',exact:true}).click();await waitReferences(7);
  await useReference.click();await waitReferences(8);assert.equal(await useReference.isEnabled(),true,'a full list still permits removing an existing reference');
  assert.equal(session.referenceIds.at(-1),result.id);
  await useReference.click();await waitReferences(7);
  await page.getByRole('button',{name:`选择图片版本 ${demo.number}`,exact:true}).click();
  await page.waitForFunction(()=>document.getElementById('useImageAsReference')?.title==='演示图片不可用作参考图');assert.equal(await useReference.isDisabled(),true);
  await select(first);await page.setViewportSize({width:390,height:844});
  await useReference.scrollIntoViewIfNeeded();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no mobile horizontal overflow');
  assert.ok(await useReference.evaluate(button=>{const r=button.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth;}),'reference action fits on mobile');
  await page.screenshot({path:path.join(out,'mobile.png'),fullPage:true});
  assert.deepEqual(errors,[]);
  console.log('PASS: historical outputs can be attached, removed, restored and sent as references; exact bytes reach vision/image edits, failed sends preserve drafts, limits and demo restrictions hold, desktop/mobile render; no paid API calls.');
}catch(error){console.error(error);process.exitCode=1;
}finally{await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await instance.shutdown();fs.rmSync(temp,{recursive:true,force:true});}
// Next's development error handler keeps the process alive after uncaught test failures.
process.exit(process.exitCode||0);
