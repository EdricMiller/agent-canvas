import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createWebApp} from '../server/web.js';
import {readPdfPages,readAndRenderPdf} from './helpers/pdf.mjs';

const root=path.resolve(import.meta.dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'canvas-pages-ui-')),out=path.join(root,'test-results/pages');fs.mkdirSync(out,{recursive:true});
const instance=await createWebApp({root,dataDir:temp,demo:true,agentModel:'test',imageModel:'test',sandboxMode:'off'}),session=instance.store.create();
const server=await new Promise((resolve,reject)=>{const s=instance.app.listen(0,'127.0.0.1');s.once('listening',()=>resolve(s));s.once('error',reject);});
const base=`http://127.0.0.1:${server.address().port}`;let browser;
try{
  browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH}:{})});
  const page=await browser.newPage({viewport:{width:1600,height:1100}}),errors=[],responses=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('response',r=>{if(r.status()>=500)responses.push(`${r.status()} ${r.url()}`);});
  await page.goto(base+'/?session='+session.id);await page.waitForFunction(()=>!document.getElementById('paginateDesign')?.disabled);
  await page.locator('#pageUnit').selectOption('mm');await page.getByLabel('宽度',{exact:true}).fill('140');await page.getByLabel('高度',{exact:true}).fill('180');
  await page.locator('#paginateDesign').click();await page.getByLabel('分页标题').fill('品牌价目表');
  await page.locator('#paginationRows').fill(Array.from({length:70},(_,i)=>`产品 ${String(i+1).padStart(3,'0')} | ${i+1} 元 | `).join('\n'));
  await page.locator('#paginationSubmit').click();await page.locator('#paginationSubmit').waitFor({state:'detached'});
  await page.waitForFunction(()=>document.getElementById('designPreview')?.naturalWidth>0&&!document.getElementById('snapshotDesign').disabled);
  const original=structuredClone(instance.documents.require(session.id).document),ids=original.pages.map(p=>p.id);assert.ok(ids.length>=3);
  assert.equal(await page.locator('[data-page]').count(),ids.length);assert.equal(await page.locator('.design-version').count(),1);
  const third=original.pages[2],target=third.objects[1];
  await page.locator(`[data-page="${third.id}"]`).click();await page.getByRole('tab',{name:'对象'}).click();await page.locator(`[data-object="${target.id}"]`).click();
  await page.locator('[data-property="text"]').fill('第三页专属产品');
  // Switching pages preserves the local draft and routes the property panel.
  await page.locator(`[data-page="${ids[0]}"]`).click();assert.equal(await page.locator(`[data-object="${target.id}"]`).count(),0);
  await page.locator(`[data-page="${third.id}"]`).click();await page.locator(`[data-object="${target.id}"]`).click();assert.equal(await page.locator('[data-property="text"]').inputValue(),'第三页专属产品');
  const save=async()=>{await page.locator('#saveDesign').click();await page.waitForFunction(()=>document.getElementById('saveDesign').disabled);};
  await save();let record=instance.documents.require(session.id);assert.deepEqual(record.document.pages[0],original.pages[0]);assert.deepEqual(record.document.pages[1],original.pages[1]);
  await page.locator('#snapshotDesign').click();await page.getByRole('button',{name:/手动保存/}).waitFor();
  const manual=structuredClone(instance.documents.require(session.id).document);
  await page.getByRole('button',{name:'复制当前页面',exact:true}).click();assert.equal(await page.locator('[data-page]').count(),ids.length+1);
  assert.equal(await page.locator('#designPreview').count(),0,'unsaved new page does not request a missing server preview');
  await page.locator('#designCanvas[data-ready="true"]').waitFor();assert.equal(await page.locator('#designCanvas').getAttribute('data-page-id'),(await page.locator('[data-page][aria-current="page"]').getAttribute('data-page')),'unsaved pages render directly without creating a server draft');
  await page.locator('.object-list button').nth(1).click();await page.locator('[data-property="text"]').fill('副本专属产品');await save();
  record=instance.documents.require(session.id);const copy=record.document.pages[3];assert.equal(copy.objects[1].text,'副本专属产品');assert.equal(record.document.pages[2].objects[1].text,'第三页专属产品');
  await page.getByRole('button',{name:'当前页前移',exact:true}).click();await save();assert.equal(instance.documents.require(session.id).document.pages[2].id,copy.id);
  await page.getByRole('button',{name:'新增页面',exact:true}).click();await page.getByRole('tab',{name:'画布'}).click();await page.getByLabel('页面名称',{exact:true}).fill('附页');
  await page.getByRole('button',{name:'删除当前页面',exact:true}).click();assert.equal(await page.locator('[data-page]').count(),ids.length+1);
  // A populated page is deleted only after the explicit UI confirmation.
  await page.locator(`[data-page="${copy.id}"]`).click();page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'删除当前页面',exact:true}).click();await save();
  assert.equal(instance.documents.require(session.id).document.pages.length,ids.length);
  await page.getByRole('button',{name:/手动保存/}).click();await page.waitForFunction(()=>!document.getElementById('snapshotDesign').disabled);
  assert.deepEqual(instance.documents.require(session.id).document,manual,'whole snapshot restores all pages and fields');
  await page.reload();await page.locator('[data-page]').first().waitFor();assert.equal(await page.locator('[data-page][aria-current="page"]').getAttribute('data-page'),ids[0]);
  await page.locator(`[data-page="${third.id}"]`).click();
  const download=async(name,range,custom)=>{
    await page.locator('#exportButton').click();await page.locator('#downloadFormat').selectOption('pdf');await page.locator('#downloadRange').selectOption(range);
    if(custom)await page.locator('#downloadPageRange').fill(custom);
    const downloading=page.waitForEvent('download');await page.locator('#downloadSubmit').click();const file=path.join(out,name+'.pdf');await(await downloading).saveAs(file);await page.getByRole('button',{name:'关闭',exact:true}).click();return fs.readFileSync(file);
  };
  const allBytes=await download('all','all'),all=await readPdfPages(allBytes);assert.equal(all.length,ids.length);assert.match(all[0],/产品 001/);assert.match(all.at(-1),/产品 070/);
  const current=await readPdfPages(await download('current','current'));assert.deepEqual(current,[all[2]]);assert.match(current[0],/第三页专属产品/);
  const custom=await readPdfPages(await download('range','custom','3,1'));assert.deepEqual(custom,[all[0],all[2]]);
  const rendered=await readAndRenderPdf(allBytes);fs.writeFileSync(path.join(out,'pdf-first-page.png'),rendered.png);
  await page.waitForFunction(()=>document.getElementById('designPreview')?.naturalWidth>0);await page.screenshot({path:path.join(out,'pages-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(out,'pages-mobile.png'),fullPage:true});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'page strip and operations do not cause mobile overflow');
  assert.deepEqual(errors,[]);assert.deepEqual(responses,[]);
  console.log(`PASS: ${ids.length}-page automatic layout, scoped editing, draft preservation across pages, independent duplicate, reorder/add/delete, whole-book snapshot/reload, all/current/custom PDF extraction, desktop/mobile rendering.`);
}catch(error){
  await browser?.contexts()[0]?.pages()[0]?.screenshot({path:path.join(out,'failure.png'),fullPage:true}).catch(()=>{});console.error(error);process.exitCode=1;
}finally{
  await browser?.close();await instance.shutdown();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));fs.rmSync(temp,{recursive:true,force:true});
}
