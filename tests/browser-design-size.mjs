import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createWebApp} from '../server/web.js';
import {mockDesignRuntime,boundDesign} from './helpers/design-agent.mjs';

const root=path.resolve(import.meta.dirname,'..'),dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'canvas-dialogue-size-'));
const output=body=>JSON.parse(body.input.filter(item=>item.type==='function_call_output').at(-1).output);
const target={width:585,height:1080,unit:'px'},landscape={width:1080,height:585,unit:'px'};
const mock=mockDesignRuntime((body,index)=>{
  if(index===0)return {name:'read_design_document',arguments:{}};
  if(index===1){
    assert.equal(output(body).canvas.width,1200);assert.equal(output(body).canvas.height,1600);
    return {name:'create_design_document',arguments:{document:boundDesign(target),label:'585×1080 广告'}};
  }
  if(index===2){assert.equal(output(body).saved,true);return '已按宽585、高1080 px 完成设计。';}
  if(index===3)return {name:'read_design_document',arguments:{}};
  if(index===4){
    assert.equal(output(body).canvas.width,585);assert.equal(output(body).canvas.height,1080);
    return {name:'apply_design_changes',arguments:{pageSize:landscape,upsertObjects:boundDesign(landscape).pages[0].objects,removeObjectIds:[],newContent:[],contentUpdates:[],title:null,background:null,label:'1080×585 横版广告'}};
  }
  assert.equal(index,5);assert.equal(output(body).saved,true);return '已调整为宽1080、高585 px。';
});
const instance=await createWebApp({root,dataDir,demo:false,apiKey:'fixture-only',agentModel:'test',imageModel:'test',maxTurns:6,sandboxMode:'off'},{runtime:mock.runtime});
const session=instance.store.create(),server=await new Promise((resolve,reject)=>{const s=instance.app.listen(0,'127.0.0.1');s.once('listening',()=>resolve(s));s.once('error',reject);});
let browser;
try{
  browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH}:{})});
  const page=await browser.newPage({viewport:{width:1600,height:1000}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/?session=${session.id}`);
  await page.waitForFunction(()=>!document.getElementById('attachButton')?.disabled);
  assert.equal(await page.getByLabel('宽度',{exact:true}).inputValue(),'1200');
  assert.equal(await page.getByLabel('高度',{exact:true}).inputValue(),'1600');
  async function send(text,size){
    await page.locator('#prompt').fill(text);await page.locator('#sendButton').click();
    await page.waitForFunction(({width,height})=>document.getElementById('designCanvas')?.getAttribute('viewBox')===`0 0 ${width} ${height}`&&document.getElementById('designCanvas')?.dataset.ready==='true'&&!document.getElementById('snapshotDesign')?.disabled,size);
    await page.getByRole('tab',{name:'画布',exact:true}).click();
    assert.equal(await page.getByLabel('宽度',{exact:true}).inputValue(),String(size.width));
    assert.equal(await page.getByLabel('高度',{exact:true}).inputValue(),String(size.height));
    assert.equal(await page.locator('#pageUnit').inputValue(),'px');
  }
  await send('好，你设计一版我看下，记得尺寸是宽585、高1080',target);
  const out=path.join(root,'test-results/next');fs.mkdirSync(out,{recursive:true});
  await page.screenshot({path:path.join(out,'dialogue-size-585x1080.png'),fullPage:true});
  await send('把当前这张改成宽1080、高585 px，并调整排版',landscape);
  await page.reload();await page.waitForFunction(()=>document.getElementById('designCanvas')?.getAttribute('viewBox')==='0 0 1080 585'&&document.getElementById('designCanvas')?.dataset.ready==='true');
  assert.equal(await page.getByLabel('宽度',{exact:true}).inputValue(),'1080');
  assert.equal(await page.getByLabel('高度',{exact:true}).inputValue(),'585');
  assert.equal(instance.documents.require(session.id).document.pages[0].width,1080);
  assert.equal(session.job.imageCalls,0);assert.equal(mock.requests.length,6);assert.deepEqual(errors,[]);
  console.log('PASS: dialogue creates 585×1080 from the default canvas, resizes and reflows an existing design, syncs canvas/settings, and survives reload; zero paid image calls.');
}finally{
  await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await instance.shutdown();fs.rmSync(dataDir,{recursive:true,force:true});
}
