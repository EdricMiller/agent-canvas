import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createWebApp} from '../server/web.js';
import {designFixture} from './fixtures/design.mjs';
import {changePages} from '../shared/design-pages.js';
import {readAndRenderPdf,readPdfPages} from './helpers/pdf.mjs';

const root=path.resolve(import.meta.dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'canvas-editor-ui-')),out=path.join(root,'test-results/editor');fs.mkdirSync(out,{recursive:true});
const instance=await createWebApp({root,dataDir:temp,demo:true,agentModel:'test',imageModel:'test',sandboxMode:'off'}),session=instance.store.create(),other=instance.store.create(),fixture=await designFixture();
const ids=new Map();for(const [id,bytes] of fixture.assets){const v=instance.store.addImage(session,bytes,{kind:'upload',demo:false});ids.set(id,v.id);}
for(const o of fixture.document.pages[0].objects)if(o.type==='image')o.assetId=ids.get(o.assetId);
fixture.document.content=[{id:'title-content',label:'标题',value:'让好想法，成为好设计',status:'confirmed'}];fixture.document.pages[0].objects.find(o=>o.id==='title').bindingId='title-content';
const document=changePages(fixture.document,{type:'duplicate',pageId:fixture.document.pages[0].id}).document;
instance.documents.createFromDocument(session.id,document);instance.documents.create(other.id,{title:'独立项目',width:400,height:600});
const before=structuredClone(instance.documents.require(session.id)),pageId=document.pages[0].id,secondId=document.pages[1].id;
const server=await new Promise((resolve,reject)=>{const s=instance.app.listen(0,'127.0.0.1');s.once('listening',()=>resolve(s));s.once('error',reject);});
const base=`http://127.0.0.1:${server.address().port}`;let browser;
try{
  browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH}:{})});
  const page=await browser.newPage({viewport:{width:1700,height:1150}}),errors=[],serverErrors=[];let textRequests=0;page.on('request',r=>{if(r.url().endsWith('/editor-text'))textRequests++;});page.on('pageerror',e=>errors.push(e.message));page.on('response',r=>{if(r.status()>=500)serverErrors.push(r.status()+' '+new URL(r.url()).pathname);});
  await page.goto(base+'/?session='+session.id);await page.locator('#designCanvas[data-ready="true"]').waitFor();assert.equal(await page.locator('#undoDesign').isDisabled(),true);assert.match(await page.locator('#undoDesign').innerText(),/撤销/);assert.match(await page.locator('#redoDesign').innerText(),/重做/);
  await page.locator('#canvasSnap').uncheck();
  const input=async label=>String(Number(Number(await page.getByLabel(label,{exact:true}).inputValue()).toFixed(3)));
  const object=id=>page.locator(`#designCanvas .editable[data-canvas-object="${id}"]`);
  const point=async(x,y)=>page.locator('#designCanvas').evaluate((el,{x,y})=>{const r=el.getBoundingClientRect(),box=el.viewBox.baseVal;return {x:r.x+x*r.width/box.width,y:r.y+y*r.height/box.height,sx:r.width/box.width,sy:r.height/box.height};},{x,y});
  const drag=async(id,dx,dy)=>{const b=await object(id).boundingBox();assert.ok(b);await page.mouse.move(b.x+b.width/2,b.y+b.height/2);await page.mouse.down();const s=await point(0,0);await page.mouse.move(b.x+b.width/2+dx*s.sx,b.y+b.height/2+dy*s.sy,{steps:8});await page.mouse.up();};
  await object('accent').click();await drag('accent',1,1);assert.equal(await input('X (mm)'),'15');assert.equal(await input('宽度 (mm)'),'2','large corner targets leave the center of a thin object draggable');await page.locator('#undoDesign').click();
  const initialTextRequests=textRequests;await drag('photo',8,5);assert.equal(await input('X (mm)'),'22');assert.equal(await input('Y (mm)'),'130');assert.equal(textRequests,initialTextRequests,'position changes reuse existing glyph layouts');
  assert.deepEqual(instance.documents.require(session.id),before,'pointer edits remain a local draft');
  await page.locator('#undoDesign').click();assert.equal(await input('X (mm)'),'14');assert.equal(await page.locator('#undoDesign').isDisabled(),true,'one drag is one undo step');
  await page.locator('#redoDesign').click();assert.equal(await input('X (mm)'),'22');
  await page.locator('#designCanvas').focus();await page.keyboard.press('ArrowRight');assert.equal(await input('X (mm)'),'22.25');await page.keyboard.press('Shift+ArrowDown');assert.equal(await input('Y (mm)'),'132.5');
  await page.keyboard.press('Control+z');assert.equal(await input('Y (mm)'),'130');await page.keyboard.press('Control+Shift+z');assert.equal(await input('Y (mm)'),'132.5');
  await page.getByLabel('对齐到画布',{exact:true}).selectOption('center');assert.equal(await input('X (mm)'),'14');await page.locator('#undoDesign').click();assert.equal(await input('X (mm)'),'22.25');
  // Resize an independent Logo while preserving its aspect ratio with Shift.
  await object('logo').click();const handle=page.locator('[data-handle="se"]'),hb=await handle.boundingBox(),s=await point(0,0);
  await page.keyboard.down('Shift');await page.mouse.move(hb.x+hb.width/2,hb.y+hb.height/2);await page.mouse.down();await page.mouse.move(hb.x+hb.width/2+5*s.sx,hb.y+hb.height/2+5*s.sy,{steps:6});await page.mouse.up();await page.keyboard.up('Shift');
  const resized=Number(await page.getByLabel('宽度 (mm)',{exact:true}).inputValue());assert.ok(Math.abs(resized-31)<.01);assert.ok(Math.abs(Number(await page.getByLabel('高度 (mm)',{exact:true}).inputValue())-resized)<.0001);
  await page.locator('#undoDesign').click();assert.equal(await page.getByLabel('宽度 (mm)',{exact:true}).inputValue(),'26');
  await object('title').click();const text=page.locator('[data-property="text"]');await text.fill('新的标题');await text.press('End');await text.pressSequentially('ABC');await text.blur();await page.locator('#designCanvas[data-ready="true"]').waitFor();
  await page.getByRole('tab',{name:'内容',exact:true}).click();assert.equal(await page.locator('[data-content="title-content"]').inputValue(),'新的标题ABC');
  await page.locator('#undoDesign').click();assert.equal(await page.locator('[data-content="title-content"]').inputValue(),'让好想法，成为好设计','continuous input is one step and restores its binding');
  await page.locator('#redoDesign').click();assert.equal(await page.locator('[data-content="title-content"]').inputValue(),'新的标题ABC');
  await page.locator('#saveDesign').click();await page.waitForFunction(()=>document.getElementById('saveDesign').disabled);assert.equal(instance.documents.require(session.id).document.content[0].value,'新的标题ABC');
  await page.locator('#undoDesign').click();assert.equal(await page.locator('[data-content="title-content"]').inputValue(),'让好想法，成为好设计');assert.equal(await page.locator('#saveDesign').isDisabled(),false,'undo remains available across save');
  await page.locator('#redoDesign').click();assert.equal(await page.locator('#saveDesign').isDisabled(),true,'redo to saved content is clean');
  // Cancelled gestures leave the draft and history unchanged.
  await page.getByRole('tab',{name:'对象',exact:true}).click();await object('photo').click();const priorX=await page.getByLabel('X (mm)',{exact:true}).inputValue(),b=await object('photo').boundingBox();
  await page.mouse.move(b.x+b.width/2,b.y+b.height/2);await page.mouse.down();await page.mouse.move(b.x+b.width/2+20,b.y+b.height/2+10,{steps:4});await page.keyboard.press('Escape');await page.mouse.up();await page.locator('[data-object="photo"]').click();assert.equal(await page.getByLabel('X (mm)',{exact:true}).inputValue(),priorX);
  // Whole-page deletion restores exact content IDs and page selection.
  await page.locator(`[data-page="${secondId}"]`).click();page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'删除当前页面',exact:true}).click();assert.equal(await page.locator('[data-page]').count(),1);
  await page.locator('#undoDesign').click();assert.equal(await page.locator('[data-page]').count(),2);assert.equal(await page.locator('[data-page][aria-current="page"]').getAttribute('data-page'),secondId);
  await page.locator('#redoDesign').click();assert.equal(await page.locator('[data-page]').count(),1);await page.locator('#undoDesign').click();
  await page.getByRole('button',{name:'复制当前页面',exact:true}).click();await page.locator('#designCanvas[data-ready="true"]').waitFor();assert.equal(await page.locator('[data-page]').count(),3);await page.locator('#undoDesign').click();assert.equal(await page.locator('[data-page]').count(),2);
  await page.locator(`[data-page="${pageId}"]`).click();await object('title').click();await page.locator('#designCanvas[data-ready="true"]').waitFor();await page.screenshot({path:path.join(out,'editor-desktop.png'),fullPage:true});
  await page.locator('#exportButton').click();await page.getByRole('button',{name:'普通 PDF',exact:true}).click();const downloading=page.waitForEvent('download');await page.locator('#downloadSubmit').click();const pdfFile=path.join(out,'editor.pdf');await(await downloading).saveAs(pdfFile);assert.match((await readPdfPages(fs.readFileSync(pdfFile)))[0],/新的标题ABC/);const rendered=await readAndRenderPdf(fs.readFileSync(pdfFile));fs.writeFileSync(path.join(out,'editor-pdf.png'),rendered.png);await page.getByRole('button',{name:'关闭',exact:true}).click();
  // Mobile direct editing uses the same page coordinates and stays in view.
  await page.setViewportSize({width:390,height:844});await page.locator('#designCanvas').scrollIntoViewIfNeeded();await page.locator('#canvasSnap').uncheck();
  const mobilePhoto=await object('photo').boundingBox(),touchX=mobilePhoto.x+mobilePhoto.width/2,touchY=mobilePhoto.y+mobilePhoto.height/2,mobileScale=(await point(0,0)).sx,scrollBeforeTouch=await page.evaluate(()=>scrollY);
  const cdp=await page.context().newCDPSession(page);await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:touchX,y:touchY}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:touchX+8,y:touchY+4}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  assert.ok(Math.abs(Number(await input('X (mm)'))-(22.25+8/mobileScale))<.01,'real touch drag updates page coordinates');
  assert.ok(Math.abs(await page.evaluate(()=>scrollY)-scrollBeforeTouch)<1,'selecting and dragging never jumps to the properties below');
  const cancelled=await object('photo').boundingBox(),cancelX=cancelled.x+cancelled.width/2,cancelY=cancelled.y+cancelled.height/2;
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:cancelX,y:cancelY}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:cancelX-8,y:cancelY}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]});
  assert.ok(Math.abs(Number(await input('X (mm)'))-(22.25+8/mobileScale))<.01,'touch cancellation preserves the committed gesture');
  const mobileHandle=await page.locator('[data-handle="se"]').boundingBox(),widthBeforeResize=Number(await input('宽度 (mm)'));assert.ok(mobileHandle.width>=31.9&&mobileHandle.height>=31.9,'corner hit area stays finger-sized at a small canvas scale');
  const resizeX=mobileHandle.x+mobileHandle.width/2,resizeY=mobileHandle.y+mobileHandle.height/2;
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:resizeX,y:resizeY}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:resizeX-4,y:resizeY-3}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await cdp.detach();
  assert.ok(Math.abs(Number(await input('宽度 (mm)'))-(widthBeforeResize-4/mobileScale))<.01,'touching outside the visible corner still resizes');await page.keyboard.press('Control+z');assert.equal(Number(await input('宽度 (mm)')),widthBeforeResize);
  await page.locator('#editObjectProperties').click();await page.waitForFunction(()=>{const el=document.querySelector('#objectProperties'),r=el?.querySelector('h3')?.getBoundingClientRect();return document.activeElement===el&&r.top>=-1&&r.bottom<=innerHeight+1;});
  assert.equal(await page.evaluate(()=>document.activeElement?.tagName),'DIV','opening properties does not focus a text input or summon the mobile keyboard');
  await page.getByRole('button',{name:'返回画布',exact:true}).click();await page.waitForFunction(()=>{const el=document.querySelector('#designCanvas'),r=el.getBoundingClientRect(),tools=document.querySelector('#editObjectProperties').getBoundingClientRect();return document.activeElement===el&&r.top>=-1&&r.bottom<=innerHeight+1&&tools.top>=-1;});
  await page.screenshot({path:path.join(out,'editor-mobile.png'),fullPage:true});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.locator('#undoDesign').click();assert.equal(await input('X (mm)'),'22.25');
  await page.setViewportSize({width:1700,height:1150});await page.reload();await page.locator('#designCanvas[data-ready="true"]').waitFor();assert.equal(await page.locator('#undoDesign').isDisabled(),true,'reload resets local history');
  await object('title').click();await page.locator('[data-property="text"]').fill('本地冲突草稿');await page.locator('[data-property="text"]').blur();
  const saved=instance.documents.require(session.id),external=structuredClone(saved.document);external.title='外部更新';instance.documents.update(session.id,external,saved.revision);
  await page.locator('#saveDesign').click();await page.locator('.conflict').waitFor();assert.equal(await page.locator('[data-property="text"]').inputValue(),'本地冲突草稿');await page.locator('#undoDesign').click();assert.equal(await page.locator('[data-property="text"]').inputValue(),'新的标题ABC');
  await page.getByRole('button',{name:'重新载入',exact:true}).click();await page.locator('.conflict').waitFor({state:'detached'});assert.equal(await page.locator('#undoDesign').isDisabled(),true);
  await page.goto(base+'/?session='+other.id);await page.locator('#designCanvas[data-ready="true"]').waitFor();assert.equal(await page.locator('#undoDesign').isDisabled(),true);assert.equal(instance.documents.require(other.id).revision,1);
  assert.deepEqual(errors,[]);assert.deepEqual(serverErrors,[]);
  console.log('PASS: direct selection/drag/resize/nudge/alignment, one-gesture undo/redo, grouped text binding edits, save/dirty history, cancel, multi-page delete/duplicate recovery, PDF text, mobile, revision conflict, session isolation.');
}catch(error){await browser?.contexts()[0]?.pages()[0]?.screenshot({path:path.join(out,'failure.png'),fullPage:true}).catch(()=>{});console.error(error);process.exitCode=1;}
finally{await browser?.close();await instance.shutdown();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));fs.rmSync(temp,{recursive:true,force:true});}
