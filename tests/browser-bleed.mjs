import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {PDFDocument} from 'pdf-lib';
import {createWebApp} from '../server/web.js';
import {designFixture} from './fixtures/design.mjs';
import {changePages} from '../shared/design-pages.js';
import {readAndRenderPdf} from './helpers/pdf.mjs';

const project=path.resolve(import.meta.dirname,'..'),root=process.env.CANVAS_TEST_BUILD_ROOT||project,temp=fs.mkdtempSync(path.join(os.tmpdir(),'canvas-bleed-ui-')),out=path.join(project,'test-results/bleed');fs.mkdirSync(out,{recursive:true});
const instance=await createWebApp({root,dataDir:temp,demo:true,agentModel:'test',imageModel:'test',sandboxMode:'off'}),session=instance.store.create(),fixture=await designFixture();
const ids=new Map();for(const [id,bytes] of fixture.assets){const v=instance.store.addImage(session,bytes,{kind:'upload',demo:false});ids.set(id,v.id);}
for(const o of fixture.document.pages[0].objects)if(o.type==='image')o.assetId=ids.get(o.assetId);
const document=changePages(fixture.document,{type:'duplicate',pageId:fixture.document.pages[0].id}).document;
document.pages[0].objects.find(o=>o.id==='accent').x=0;document.pages[0].objects.find(o=>o.id==='accent').bleed=true;
const photo=document.pages[1].objects.find(o=>o.type==='image'&&o.assetId===ids.get(fixture.photoId));photo.x=0;
instance.documents.createFromDocument(session.id,document);
const server=await new Promise((resolve,reject)=>{const s=instance.app.listen(0,'127.0.0.1');s.once('listening',()=>resolve(s));s.once('error',reject);});
const base=`http://127.0.0.1:${server.address().port}`;let browser;
try{
  browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH}:{})});
  const page=await browser.newPage({viewport:{width:1600,height:1100}}),errors=[],serverErrors=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('response',r=>{if(r.status()>=500)serverErrors.push(r.status()+' '+new URL(r.url()).pathname);});
  await page.goto(base+'/?session='+session.id);await page.waitForFunction(()=>document.getElementById('designPreview')?.naturalWidth>0&&!document.getElementById('exportButton').disabled);
  await page.locator('#exportButton').click();await page.getByRole('button',{name:'普通 PDF',exact:true}).click();await page.locator('#downloadColor').selectOption('cmyk');await page.locator('#printProfile').selectOption('default');await page.locator('#checkExport').click();
  await page.locator('[data-locate="bleed_background_only"]').waitFor();await page.locator('[data-locate="bleed_background_only"]').click();
  await page.waitForFunction(id=>document.querySelector(`[data-object="${id}"]`)?.getAttribute('aria-pressed')==='true',photo.id);
  assert.equal(await page.locator('[role=tab][aria-selected=true]').innerText(),'对象');
  await page.locator('#objectBleed').check();await page.locator('#saveDesign').click();
  await page.waitForFunction(()=>document.getElementById('saveDesign').disabled);
  assert.equal(instance.documents.require(session.id).document.pages[1].objects.find(o=>o.id===photo.id).bleed,true);
  await page.locator('#exportButton').click();await page.getByRole('button',{name:'普通 PDF',exact:true}).click();await page.locator('#downloadColor').selectOption('cmyk');await page.locator('#printProfile').selectOption('default');await page.locator('#printBleed').fill('4');await page.locator('#printSafe').fill('5');await page.locator('#printCropMarks').check();await page.locator('#checkExport').click();
  await page.locator('#printProof').waitFor();assert.equal(await page.locator('[data-locate="bleed_background_only"]').count(),0);assert.equal(await page.locator('[data-locate="bleed_image_crop"]').count(),1);
  assert.equal(await page.locator('#printProof [data-guide]').count(),3);
  await page.locator('#proofPage').selectOption(document.pages[1].id);await page.getByRole('img',{name:'第 2 页裁切预览',exact:true}).waitFor();
  await page.locator('#proofGuides').uncheck();assert.equal(await page.locator('#printProof [data-guide]').count(),0);await page.locator('#proofGuides').check();
  await page.locator('#printProof').screenshot({path:path.join(out,'proof-page-2.png')});
  const reportDownload=page.waitForEvent('download');await page.locator('#savePreflight').click();const reportFile=path.join(out,'preflight.json');await(await reportDownload).saveAs(reportFile);
  const report=JSON.parse(fs.readFileSync(reportFile));assert.equal(report.revision,2);assert.equal(report.settings.print.bleedMode,'objects');assert.equal(report.settings.print.bleedMm,4);assert.equal(report.settings.print.safeMm,5);assert.equal(report.pages.length,2);assert.equal(report.pdfX,false);
  await page.locator('#confirmPrintWarnings').check();const pdfDownload=page.waitForEvent('download');await page.locator('#downloadSubmit').click();const pdfFile=path.join(out,'bleed-cmyk.pdf');await(await pdfDownload).saveAs(pdfFile);
  const pdf=await PDFDocument.load(fs.readFileSync(pdfFile));assert.equal(pdf.getPageCount(),2);assert.ok(Math.abs(pdf.getPage(0).getWidth()-204*72/25.4)<.001);
  const rendered=await readAndRenderPdf(fs.readFileSync(pdfFile));fs.writeFileSync(path.join(out,'bleed-cmyk.png'),rendered.png);
  await page.locator('#printBleedMode').selectOption('background');assert.equal(await page.locator('#printProof').count(),0);await page.locator('#checkExport').click();await page.locator('#printProof').waitFor();assert.equal(await page.locator('[data-locate="bleed_background_only"]').count(),2);
  await page.locator('#printBleedMode').selectOption('objects');await page.locator('#checkExport').click();await page.locator('#printProof').waitFor();await page.locator('#printProof').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(out,'proof-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});await page.locator('#printProof').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(out,'proof-mobile.png'),fullPage:true});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.getByRole('button',{name:'关闭',exact:true}).click();await page.reload();await page.setViewportSize({width:1600,height:1100});await page.locator(`[data-page="${document.pages[1].id}"]`).click();await page.getByRole('tab',{name:'对象',exact:true}).click();await page.locator(`[data-object="${photo.id}"]`).click();
  assert.equal(await page.locator('#objectBleed').isChecked(),true);
  await page.locator('.object-properties select:has(option[value="contain"])').selectOption('contain');assert.equal(await page.locator('#objectBleed').isChecked(),false);assert.equal(await page.locator('#objectBleed').isDisabled(),true);
  assert.equal(instance.documents.require(session.id).versions.length,0,'checks/exports do not add versions');
  assert.deepEqual(errors,[]);assert.deepEqual(serverErrors,[]);
  console.log('PASS: preflight issue locates page 2/object, opt-in bleed persists, proportional preview, page selection, trim/bleed/safety guides, JSON report, real 2-page CMYK file, background-only compatibility, stale preview reset, desktop/mobile, contain/Logo protection.');
}catch(error){await browser?.contexts()[0]?.pages()[0]?.screenshot({path:path.join(out,'failure.png'),fullPage:true}).catch(()=>{});console.error(error);process.exitCode=1;}
finally{await browser?.close();await instance.shutdown();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));fs.rmSync(temp,{recursive:true,force:true});}
