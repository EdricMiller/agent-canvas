import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createWebApp} from '../server/web.js';
import {designFixture} from './fixtures/design.mjs';
import {mockDesignRuntime,boundDesign} from './helpers/design-agent.mjs';
import {readAndRenderPdf} from './helpers/pdf.mjs';

const root=path.resolve(import.meta.dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'canvas-next-ui-'));
const out=path.join(root,'test-results/next');fs.mkdirSync(out,{recursive:true});
let session;
const mock=mockDesignRuntime(async(_body,index)=>{
  if(index===0||index===3)return {name:'read_design_document',arguments:{}};
  if(index===1){
    const document=boundDesign({sourceId:session.versions[0].id,logoId:session.versions[1].id});document.content[1].status='needs_confirmation';
    return {name:'create_design_document',arguments:{document,label:'AI 初稿'}};
  }
  if(index===2)return '已生成独立文字和 Logo，请核对价格。';
  if(index===4)return {name:'update_design_content',arguments:{changes:[{id:'price',value:'78',status:'confirmed'}],label:'AI 改价'}};
  if(index===5)return '价格改为 78，其他对象保持不变。';
  await new Promise(resolve=>setTimeout(resolve,800));
  return {name:'update_design_content',arguments:{changes:[{id:'price',value:'999',status:'confirmed'}],label:'取消的修改'}};
});
const instance=await createWebApp({root,dataDir:temp,demo:false,apiKey:'fixture-only',agentModel:'test',imageModel:'test',maxTurns:8,sandboxMode:'off'},{runtime:mock.runtime});
session=instance.store.create();
const fixture=await designFixture();
const legacy=instance.store.create();
const oldImage=instance.store.addImage(legacy,fixture.assets.get(fixture.photoId),{kind:'generated',demo:false,width:1200,height:500,label:'旧图片作品'});
const server=await new Promise((resolve,reject)=>{const s=instance.app.listen(0,'127.0.0.1');s.once('listening',()=>resolve(s));s.once('error',reject);});
const base=`http://127.0.0.1:${server.address().port}`;let browser;
try{
  const html=await fetch(base),csp=html.headers.get('content-security-policy'),text=await html.text();
  assert.match(csp,/script-src 'self' 'nonce-/);assert.ok(!csp.includes('unsafe-eval'),'production CSP disallows eval');
  assert.ok([...text.matchAll(/<script\b[^>]*>/g)].every(([tag])=>tag.includes('nonce=')),'Next hydration scripts receive CSP nonces');
  assert.match(text,/_next\/static/);assert.match(text,/可编辑设计/);
  const config=await(await fetch(base+'/api/config')).json();
  const cross=await fetch(base+'/api/sessions',{method:'POST',headers:{'Content-Type':'application/json','X-Studio-Token':config.token,Origin:'https://foreign.invalid'},body:'{}'});
  assert.equal(cross.status,403,'same-origin protection survives the migration');
  assert.equal((await fetch(base+'/design.html?session='+session.id,{redirect:'manual'})).status,307);
  assert.equal((await fetch(base+'/legacy/')).status,200);
  browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH}:{})});
  const page=await browser.newPage({viewport:{width:1600,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  const responseErrors=[];page.on('response',r=>{if(r.status()>=500)responseErrors.push(`${r.status()} ${new URL(r.url()).pathname}`);});
  await page.goto(base+'/?session='+session.id);await page.waitForFunction(()=>!document.getElementById('uploadButton')?.disabled);
  await page.screenshot({path:path.join(out,'workspace-empty.png'),fullPage:true});
  await page.locator('#imageInput').setInputFiles([
    {name:'内容明细.png',mimeType:'image/png',buffer:fixture.assets.get(fixture.photoId)},
    {name:'品牌Logo.png',mimeType:'image/png',buffer:fixture.assets.get(fixture.logoId)},
  ]);
  await page.waitForFunction(()=>document.querySelectorAll('[data-reference]').length===2&&!document.getElementById('attachButton').disabled);
  assert.equal(await page.locator('.version-card').count(),0);
  await page.locator('#pageUnit').selectOption('mm');await page.getByLabel('宽度',{exact:true}).fill('180');await page.getByLabel('高度',{exact:true}).fill('240');
  await page.locator('#designTitle').fill('自定义品牌设计');
  await page.locator('#prompt').fill('第一张是内容，第二张是 Logo，按当前尺寸制作可编辑设计稿。');await page.locator('#sendButton').click();
  await page.locator('.design-result-link').waitFor();
  await page.waitForFunction(()=>document.getElementById('designPreview')?.naturalWidth>0&&!document.getElementById('snapshotDesign').disabled);
  assert.equal(await page.locator('[data-reference]').count(),0);assert.equal(await page.locator('.message-attachments img').count(),2);
  assert.equal(await page.locator('#prompt').inputValue(),'');assert.equal(instance.documents.require(session.id).document.pages[0].objects.length,3);
  assert.equal(session.versions.length,2,'references are assets, not output versions');
  await page.getByRole('tab',{name:'内容'}).click();await page.locator('[data-content="price"]').waitFor();
  await page.locator('#exportButton').click();await page.locator('#downloadFormat').selectOption('pdf');await page.locator('#downloadSubmit').click();
  await page.getByRole('alert').filter({hasText:'需要核对'}).waitFor();await page.getByRole('button',{name:'关闭',exact:true}).click();
  await page.locator('[data-content="price"]').fill('88');await page.locator('[data-confirm="price"]').check();
  await page.getByRole('tab',{name:'对象'}).click();await page.locator('[data-object="price-object"]').click();await page.locator('[data-property="text"]').fill('89');
  await page.getByRole('tab',{name:'内容'}).click();assert.equal(await page.locator('[data-content="price"]').inputValue(),'89');
  await page.locator('#saveDesign').click();await page.waitForFunction(()=>document.getElementById('saveDesign').disabled);
  assert.equal(instance.documents.require(session.id).document.content[1].value,'89');
  await page.locator('#snapshotDesign').click();await page.getByRole('button',{name:/手动保存/}).waitFor();
  const preserved=structuredClone(instance.documents.require(session.id).document.pages[0].objects[2]);
  await page.locator('#prompt').fill('只把价格改为 78，保留其他排版。');await page.locator('#sendButton').click();
  await page.waitForFunction(()=>document.querySelector('[data-content="price"]')?.value==='78'&&!document.getElementById('snapshotDesign').disabled);
  assert.deepEqual(instance.documents.require(session.id).document.pages[0].objects[2],preserved);
  await page.screenshot({path:path.join(out,'workspace-design.png'),fullPage:true});
  for(const colorSpace of ['rgb','cmyk']){
    await page.locator('#exportButton').click();await page.locator('#downloadFormat').selectOption('pdf');await page.locator('#downloadColor').selectOption(colorSpace);
    if(colorSpace==='cmyk'){await page.locator('#printProfile').selectOption('default');await page.locator('#checkExport').click();await page.locator('#confirmPrintWarnings').check();}
    const downloading=page.waitForEvent('download');await page.locator('#downloadSubmit').click();const download=await downloading;
    const file=path.join(out,`workspace-${colorSpace}.pdf`);await download.saveAs(file);
    const result=await readAndRenderPdf(fs.readFileSync(file));assert.match(result.text,/78/);
    if(result.png)fs.writeFileSync(path.join(out,`workspace-${colorSpace}.png`),result.png);
    await page.getByRole('button',{name:'关闭',exact:true}).click();
  }
  await page.getByRole('button',{name:/手动保存/}).click();await page.waitForFunction(()=>document.querySelector('[data-content="price"]')?.value==='89');
  await page.reload();await page.getByRole('tab',{name:'内容'}).click();await page.locator('[data-content="price"]').waitFor();
  assert.equal(await page.locator('[data-content="price"]').inputValue(),'89');assert.equal(await page.locator('[data-reference]').count(),0);
  const before=instance.documents.require(session.id);
  await page.locator('#prompt').fill('取消本次修改');await page.locator('#sendButton').click();await page.locator('#stopButton').waitFor();await page.locator('#stopButton').click();
  await page.locator('#stopButton').waitFor({state:'detached'});assert.deepEqual(instance.documents.require(session.id),before);
  // An external revision must not silently overwrite the user's local draft.
  await page.locator('[data-content="price"]').fill('91');
  const changed=structuredClone(before.document);changed.title='其他窗口更新';instance.documents.update(session.id,changed,before.revision);
  await page.locator('#saveDesign').click();await page.locator('.conflict').waitFor();assert.equal(await page.locator('[data-content="price"]').inputValue(),'91');
  page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'重新载入',exact:true}).click();await page.locator('.conflict').waitFor({state:'detached'});
  assert.equal(await page.locator('[data-content="price"]').inputValue(),'89');
  // The migrated registry uses the same local model settings and never returns keys.
  await page.getByRole('button',{name:'模型设置',exact:true}).click();await page.locator('#debugSaveRoutes').waitFor();
  assert.match(await page.locator('#debugContent').innerText(),/调用配置/);assert.ok(!(await page.locator('#debugContent').innerHTML()).includes('fixture-only'));
  await page.getByRole('button',{name:'关闭',exact:true}).click();
  const oldPage=await browser.newPage({viewport:{width:1440,height:950}});
  await oldPage.goto(base+'/?session='+legacy.id);await oldPage.locator('#canvasImage').waitFor();
  await oldPage.locator('#exportButton').click();const oldDownloading=oldPage.waitForEvent('download');await oldPage.locator('#downloadSubmit').click();
  const oldFile=path.join(out,'legacy.png');await(await oldDownloading).saveAs(oldFile);assert.deepEqual(fs.readFileSync(oldFile),fixture.assets.get(fixture.photoId));
  await oldPage.getByRole('button',{name:'关闭',exact:true}).click();await oldPage.getByRole('button',{name:'以此图创建设计稿',exact:true}).click();
  await oldPage.waitForFunction(()=>document.getElementById('designPreview')?.naturalWidth>0);
  assert.equal(instance.documents.require(legacy.id).document.pages[0].objects[0].assetId,oldImage.id);
  await oldPage.getByRole('tab',{name:'对象'}).click();await oldPage.locator('#addText').click();assert.equal(await oldPage.locator('[data-object]').count(),2);
  await oldPage.locator('#saveDesign').click();await oldPage.waitForFunction(()=>document.getElementById('saveDesign').disabled);
  await oldPage.reload();await oldPage.getByRole('tab',{name:'对象'}).click();await oldPage.locator('[data-object]').first().waitFor();assert.equal(await oldPage.locator('[data-object]').count(),2);
  assert.equal(legacy.versions.length,1,'importing and editing preserves original image history');
  // Consecutive clipboard events queue rather than dropping the second batch.
  await oldPage.locator('#composer').evaluate((element,base64)=>{
    const png=Uint8Array.from(atob(base64),c=>c.charCodeAt(0));
    for(const name of ['paste-1.png','paste-2.png']){const data=new DataTransfer();data.items.add(new File([png],name,{type:'image/png'}));element.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));}
  },fixture.assets.get(fixture.logoId).toString('base64')); 
  await oldPage.waitForFunction(()=>document.querySelectorAll('[data-reference]').length===2&&!document.getElementById('attachButton').disabled);
  assert.deepEqual(legacy.referenceIds.map(id=>legacy.versions.find(v=>v.id===id).label),['paste-1.png','paste-2.png']);
  await oldPage.close();
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(out,'workspace-mobile.png'),fullPage:true});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'mobile has no horizontal overflow');
  assert.ok(await page.evaluate(()=>document.getElementById('composer').getBoundingClientRect().top>=document.getElementById('messages').getBoundingClientRect().bottom),'composer does not cover messages');
  assert.deepEqual(errors,[]);assert.deepEqual(responseErrors,[]);
  console.log('PASS: Next production routing/CSP/origin, multi-reference creation, unified preview/content/object edits, confirmation, RGB/CMYK PDF, snapshot restore, reload, cancellation, conflict preservation, settings, old image import/download, consecutive paste queue, mobile.');
}catch(error){
  const page=browser?.contexts()[0]?.pages()[0];
  await page?.screenshot({path:path.join(out,'failure.png'),fullPage:true}).catch(()=>{});
  console.error(error);process.exitCode=1;
}finally{
  await browser?.close();await instance.shutdown();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));fs.rmSync(temp,{recursive:true,force:true});
}
