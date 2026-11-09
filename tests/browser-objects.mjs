import {chromium,expect} from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createWebApp} from '../server/web.js';
import {designFixture} from './fixtures/design.mjs';
import {changePages} from '../shared/design-pages.js';
import {documentSchema} from '../server/design/document.js';
import {readPdfPages} from './helpers/pdf.mjs';

const root=path.resolve(import.meta.dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'canvas-objects-')),out=path.join(root,'test-results/objects');fs.mkdirSync(out,{recursive:true});
const instance=await createWebApp({root,dataDir:temp,demo:true,agentModel:'test',imageModel:'test',sandboxMode:'off'}),session=instance.store.create(),f=await designFixture(),ids=new Map();
for(const [id,bytes] of f.assets){const a=instance.store.addImage(session,bytes,{kind:'upload',label:id===f.logoId?'品牌 Logo':'产品图',demo:false});ids.set(id,a.id);}
while(session.referenceIds.length<8)instance.store.addImage(session,f.assets.get(f.logoId),{kind:'upload',label:`参考 ${session.referenceIds.length+1}`,demo:false});
for(const o of f.document.pages[0].objects)if(o.type==='image')o.assetId=ids.get(o.assetId);
f.document.content=[{id:'title-field',label:'标题',value:'让好想法，成为好设计',status:'confirmed'}];f.document.pages[0].objects.find(o=>o.id==='title').bindingId='title-field';
f.document.pages[0].objects.push({id:'overlay',type:'rect',x:50,y:130,width:20,height:20,fill:'#b3d8a9'});
const document=documentSchema.parse(changePages(f.document,{type:'duplicate',pageId:f.document.pages[0].id}).document),first=document.pages[0],second=document.pages[1],initialPhoto=structuredClone(first.objects.find(o=>o.id==='photo'));
instance.documents.createFromDocument(session.id,document);
const initialReferences=[...session.referenceIds],selectedImage=session.selectedId;
const server=await new Promise((resolve,reject)=>{const s=instance.app.listen(0,'127.0.0.1');s.once('listening',()=>resolve(s));s.once('error',reject);}),base=`http://127.0.0.1:${server.address().port}`;
let browser,page;
try{
  browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH}:{})});
  page=await browser.newPage({viewport:{width:1700,height:1150}});const errors=[],serverErrors=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('response',r=>{if(r.status()>=500)serverErrors.push(`${r.status()} ${new URL(r.url()).pathname}`);});
  const row=id=>page.locator(`[data-object="${id}"]`),image=id=>page.locator(`#designCanvas g[data-canvas-object="${id}"] image`);
  const saved=()=>instance.documents.require(session.id),object=id=>saved().document.pages[0].objects.find(o=>o.id===id);
  const clean=()=>expect(page.locator('#autoSaveStatus')).toHaveText('已保存');
  const point=async(x,y)=>page.locator('#designCanvas').evaluate((el,{x,y})=>{const r=el.getBoundingClientRect(),v=el.viewBox.baseVal;return {x:r.x+x*r.width/v.width,y:r.y+y*r.height/v.height};},{x,y});
  await page.goto(base+'/?session='+session.id);await page.locator('#designCanvas[data-ready="true"]').waitFor();
  await page.getByRole('tab',{name:'对象',exact:true}).click();assert.equal(await page.locator('[data-object]').first().getAttribute('data-object'),'overlay');
  await page.locator('#snapshotDesign').click();await expect(page.locator('.design-version')).toHaveCount(1);
  const originalVersion=saved().versions[0].id;
  // Existing assets and new uploads both replace the image without moving its frame.
  await row('photo').click();await page.locator('#replaceImageAsset').selectOption(ids.get(f.logoId));await expect(image('photo')).toHaveAttribute('href',`/images/${ids.get(f.logoId)}.png`);
  await page.locator('#undoDesign').click();await expect(image('photo')).toHaveAttribute('href',`/images/${ids.get(f.photoId)}.png`);await page.locator('#redoDesign').click();
  const uploading=page.waitForResponse(r=>r.url().endsWith('/upload')&&r.request().method()==='POST');
  await page.locator('#replaceImageFile').setInputFiles({name:'新品牌.png',mimeType:'image/png',buffer:f.assets.get(f.photoId)});assert.equal((await uploading).status(),201);
  await expect(page.locator('#replaceImageAsset')).not.toHaveValue(ids.get(f.logoId));const replacementId=await page.locator('#replaceImageAsset').inputValue();
  assert.deepEqual(instance.store.get(session.id).referenceIds,initialReferences,'replacement does not add ninth reference');assert.equal(instance.store.get(session.id).selectedId,selectedImage);
  await clean();assert.deepEqual(object('photo'),{...initialPhoto,assetId:replacementId});assert.equal(saved().versions.length,1,'autosave creates no design version');
  assert.deepEqual(saved().document.pages[1],second);await page.locator('#undoDesign').click();await expect(image('photo')).toHaveAttribute('href',`/images/${ids.get(f.logoId)}.png`);await page.locator('#redoDesign').click();
  // A failed upload keeps the current image; assets and foreign hidden references still use the same API validation.
  const config=await(await page.request.get(base+'/api/config')).json(),headers={'X-Studio-Token':config.token};
  const bad=await page.request.post(base+`/api/sessions/${session.id}/upload`,{headers,data:{name:'损坏.png',purpose:'asset',data:'data:image/png;base64,YmFk'}});assert.equal(bad.status(),400);assert.equal(object('photo').assetId,replacementId);
  const other=instance.store.create(),foreign=instance.store.addImage(other,f.assets.get(f.logoId),{kind:'upload',demo:false});
  const invalid=structuredClone(saved().document);invalid.pages[0].objects.push({id:'foreign',type:'image',assetId:foreign.id,x:0,y:0,width:10,height:10,hidden:true});
  assert.equal((await page.request.put(base+`/api/sessions/${session.id}/design`,{headers,data:{revision:saved().revision,document:invalid}})).status(),400);
  // Copies own their content; undo removes both object and binding, redo restores exact IDs.
  await row('title').click();await page.locator('#duplicateObject').click();const copyId=await page.locator('[data-object][aria-pressed="true"]').getAttribute('data-object');assert.notEqual(copyId,'title');
  await page.locator('[data-property="text"]').fill('独立标题');await page.locator('[data-property="text"]').blur();await clean();
  const copy=object(copyId);assert.equal(object('title').text,'让好想法，成为好设计');assert.notEqual(copy.bindingId,'title-field');
  await page.locator('#undoDesign').click();await expect(page.locator('[data-property="text"]')).toHaveValue('让好想法，成为好设计');
  await page.locator('#undoDesign').click();await expect(row(copyId)).toHaveCount(0);await page.locator('#redoDesign').click();await expect(row(copyId)).toHaveCount(1);await page.locator('#redoDesign').click();await expect(page.locator('[data-property="text"]')).toHaveValue('独立标题');
  // Reordering changes both UI lists and actual SVG paint order; boundary buttons are disabled.
  await page.locator('[data-layer-order="back"]').click();assert.equal(await page.locator('[data-object]').last().getAttribute('data-object'),copyId);await expect(page.locator('[data-layer-order="backward"]')).toBeDisabled();
  await page.locator('[data-layer-order="front"]').click();assert.equal(await page.locator('[data-object]').first().getAttribute('data-object'),copyId);
  assert.equal(await page.locator('#designCanvas .editable').last().getAttribute('data-canvas-object'),copyId);await expect(page.locator('[data-layer-order="forward"]')).toBeDisabled();
  // Locked objects remain selectable in layers, pass pointer hits to objects below, and resist keyboard edits/deletion.
  await page.locator('[data-layer-lock="overlay"]').click();await expect(page.getByLabel('宽度 (mm)',{exact:true})).toBeDisabled();assert.equal(await page.locator('[data-handle]').count(),0);
  await page.locator('#designCanvas').focus();await page.keyboard.press('ArrowRight');await page.keyboard.press('Delete');await clean();assert.equal(object('overlay').x,50);
  const underneath=await point(60,140);await page.mouse.click(underneath.x,underneath.y);await expect(row('photo')).toHaveAttribute('aria-pressed','true');
  await page.locator('[data-layer-lock="title"]').click();await page.getByRole('tab',{name:'内容',exact:true}).click();await expect(page.locator('[data-content="title-field"]')).toBeDisabled();
  await page.getByRole('tab',{name:'对象',exact:true}).click();await row('title').click();await page.locator('#toggleObjectLock').click();await expect(page.locator('[data-property="text"]')).toBeEnabled();
  // Hidden objects have no canvas/handles or download text, but remain available in the layer panel.
  await page.locator(`[data-layer-visibility="${copyId}"]`).click();await expect(page.locator(`#designCanvas [data-canvas-object="${copyId}"]`)).toHaveCount(0);await expect(page.locator('.object-state')).toContainText('已隐藏');
  await page.locator('#undoDesign').click();await expect(page.locator(`#designCanvas .editable[data-canvas-object="${copyId}"]`)).toHaveCount(1);await page.locator('#redoDesign').click();await clean();
  await page.locator('#snapshotDesign').click();await expect(page.locator('.design-version')).toHaveCount(2);const finalVersion=saved().versions.at(-1).id,finalDocument=structuredClone(saved().document);
  await page.locator('#exportButton').click();await page.getByRole('button',{name:'普通 PDF',exact:true}).click();const downloading=page.waitForEvent('download');await page.locator('#downloadSubmit').click();const file=path.join(out,'visible-layers.pdf');await(await downloading).saveAs(file);const pages=await readPdfPages(fs.readFileSync(file));assert.doesNotMatch(pages[0],/独立标题/);assert.match(pages[0],/让好想法/);await page.getByRole('button',{name:'关闭',exact:true}).click();
  await page.reload();await page.locator('#designCanvas[data-ready="true"]').waitFor();await page.getByRole('tab',{name:'对象',exact:true}).click();
  await expect(page.locator(`[data-layer-visibility="${copyId}"]`)).toHaveAttribute('aria-pressed','true');await expect(page.locator('[data-layer-lock="overlay"]')).toHaveAttribute('aria-pressed','true');await row('photo').click();await expect(page.locator('#replaceImageAsset')).toHaveValue(replacementId);
  // Snapshots restore original image, order and flags, then restore the full edited state.
  await page.locator(`.design-version[title="恢复设计版本 1"]`).click();await expect(row(copyId)).toHaveCount(0);assert.equal(object('photo').assetId,initialPhoto.assetId);assert.equal(object('overlay').locked,undefined);assert.equal(saved().versions.find(v=>v.id===originalVersion).document.pages[0].objects.find(o=>o.id==='photo').assetId,initialPhoto.assetId);
  await page.locator(`.design-version[title="恢复设计版本 2"]`).click();await expect(row(copyId)).toHaveCount(1);assert.deepEqual(saved().document,finalDocument);assert.ok(saved().versions.some(v=>v.id===finalVersion));
  // A not-yet-synced visibility/lock change also survives browser draft recovery.
  const endpoint=`**/api/sessions/${session.id}/design`;
  await page.route(endpoint,route=>route.request().method()==='PUT'?route.abort('internetdisconnected'):route.continue());
  await page.locator('[data-layer-visibility="photo"]').click();await page.locator('[data-layer-lock="photo"]').click();await expect(page.locator('.canvas-bottom')).toContainText('当前草稿已在本机保留');
  await page.reload();await page.locator('#recoverLocalDraft').waitFor();await page.unroute(endpoint);await page.locator('#recoverLocalDraft').click();await page.locator('#editObjectProperties').click();
  await expect(page.locator('[data-layer-lock="photo"]')).toHaveAttribute('aria-pressed','true');await expect(page.locator('[data-layer-visibility="photo"]')).toHaveAttribute('aria-pressed','true');await expect(page.locator('#designCanvas [data-canvas-object="photo"]')).toHaveCount(0);await clean();
  await page.locator(`.design-version[title="恢复设计版本 2"]`).click();await expect(page.locator('#designCanvas .editable[data-canvas-object="photo"]')).toHaveCount(1);
  await row('photo').click();await page.locator('#designCanvas[data-ready="true"]').waitFor();await page.screenshot({path:path.join(out,'layers-desktop.png'),fullPage:true});
  // Mobile controls remain reachable and sized for touch. Duplicate shortcut only handles canvas focus.
  await page.setViewportSize({width:390,height:844});await page.locator('#editObjectProperties').click();await page.locator('#uploadReplacement').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(out,'layers-mobile.png'),fullPage:true});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  const toggleBox=await page.locator('[data-layer-lock="overlay"]').boundingBox();assert.ok(toggleBox.width>=40&&toggleBox.height>=40);
  await row('overlay').click();await page.locator('#toggleObjectLock').click();await expect(page.getByLabel('宽度 (mm)',{exact:true})).toBeEnabled();await page.getByRole('button',{name:'返回画布',exact:true}).click();
  await page.keyboard.press('Control+d');assert.equal(await page.locator('[data-object]').count(),first.objects.length+2);
  await page.locator('#undoDesign').click();assert.equal(await page.locator('[data-object]').count(),first.objects.length+1);
  assert.deepEqual(errors,[]);assert.deepEqual(serverErrors,[]);
  console.log('PASS: image replacement/upload with eight existing references, preserved frames/assets, independent bound copies, undo/redo, stacking, lock/pass-through, hidden downloads, autosave/reload/draft recovery, full versions, asset isolation, mobile controls.');
}catch(error){await page?.screenshot({path:path.join(out,'failure.png'),fullPage:true}).catch(()=>{});console.error(error);process.exitCode=1;}
finally{await browser?.close();await instance.shutdown();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));fs.rmSync(temp,{recursive:true,force:true});}
