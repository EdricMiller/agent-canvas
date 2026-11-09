import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {documentSchema} from '../server/design/document.js';
import {applyDesignChanges,validateDesignAssets} from '../server/design/operations.js';
import {DocumentStore} from '../server/design/store.js';
import {layoutDocument,renderPdf} from '../server/design/render.js';
import {boundDesign} from './helpers/design-agent.mjs';

const patch=changes=>({upsertObjects:[],removeObjectIds:[],newContent:[],contentUpdates:changes,title:null,background:null});

test('page size changes preserve other pages and convert units without moving locked objects physically',()=>{
  const input=boundDesign({width:1200,height:1600,unit:'px'});
  input.pages[0].objects[0].locked=true;
  input.pages.push({...structuredClone(input.pages[0]),id:'other-page',objects:[]});
  const before=structuredClone(input),size={width:585,height:1080,unit:'px'};
  const resized=applyDesignChanges(input,{...patch([]),pageSize:size},input.pages[0].id);
  assert.equal(resized.pages[0].width,585);assert.equal(resized.pages[0].height,1080);
  assert.deepEqual(resized.pages[0].objects,input.pages[0].objects);assert.deepEqual(resized.pages[1],input.pages[1]);
  const converted=applyDesignChanges(input,{...patch([]),pageSize:{width:210,height:297,unit:'mm'}},input.pages[0].id);
  const old=input.pages[0].objects[0],object=converted.pages[0].objects[0];
  for(const key of ['x','y','width','height'])assert.ok(Math.abs(object[key]-old[key]*25.4/96)<1e-8);
  assert.equal(object.fontSize,old.fontSize);assert.equal(object.locked,true);
  assert.deepEqual(converted.pages[1],input.pages[1]);assert.deepEqual(input,before);
  assert.throws(()=>applyDesignChanges(input,{...patch([]),pageSize:size,upsertObjects:[{...old,x:0}]},input.pages[0].id),/锁定/);
  for(const pageSize of [{...size,width:0},{...size,height:-1},{...size,unit:'cm'},{width:20000,height:20000,unit:'mm'}]){
    assert.throws(()=>applyDesignChanges(input,{...patch([]),pageSize},input.pages[0].id));
  }
});

test('content binding validates identity and keeps local text changes separate from other objects',()=>{
  const input=boundDesign(),before=structuredClone(input);
  const updated=applyDesignChanges(input,patch([{id:'price',value:'78',status:'confirmed'}]));
  assert.equal(updated.content[1].value,'78');assert.equal(updated.pages[0].objects[1].text,'78');
  assert.deepEqual(updated.pages[0].objects[0],input.pages[0].objects[0]);assert.deepEqual(input,before);
  const invalid=structuredClone(input);invalid.pages[0].objects[1].text='错误值';assert.equal(documentSchema.safeParse(invalid).success,false);
  invalid.pages[0].objects[1].bindingId='missing';assert.equal(documentSchema.safeParse(invalid).success,false);
  assert.throws(()=>applyDesignChanges(input,patch([{id:'unknown',value:'1',status:'confirmed'}])),/不存在/);
  assert.throws(()=>applyDesignChanges(input,patch([{id:'price',value:'1',status:'confirmed'},{id:'price',value:'2',status:'confirmed'}])),/重复/);
  assert.throws(()=>validateDesignAssets(boundDesign({sourceId:randomUUID()}),{versions:[]}),/来源/);
});

test('AI snapshots atomically preserve the previous manual draft and reject stale writes',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'canvas-design-commit-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const store=new DocumentStore(dir),id=randomUUID(),input=boundDesign();
  const first=store.commit(id,input,null,'AI 初稿');assert.equal(first.revision,1);assert.equal(first.versions.length,1);
  const manual=applyDesignChanges(input,patch([{id:'price',value:'88',status:'confirmed'}]));store.update(id,manual,1);
  const updated=applyDesignChanges(manual,patch([{id:'price',value:'98',status:'confirmed'}]));
  const result=store.commit(id,updated,2,'AI 修改价格');assert.equal(result.revision,3);assert.equal(result.versions.length,3);
  assert.equal(result.versions[1].document.content[1].value,'88');assert.equal(result.versions[2].document.content[1].value,'98');
  assert.throws(()=>store.commit(id,input,2,'过期写入'),/其他窗口/);assert.equal(store.require(id).revision,3);
  const restored=store.restore(id,3,result.versions[1].id);assert.equal(restored.document.content[1].value,'88');
});

test('uncertain content is visible in preview but blocks export until explicitly confirmed',async()=>{
  const document=boundDesign();document.content[1].status='needs_confirmation';
  const pending=await layoutDocument(document,()=>{});assert.ok(pending.issues.some(i=>i.code==='unconfirmed_content'));
  await assert.rejects(renderPdf(pending),/需要核对/);
  const confirmed=applyDesignChanges(document,patch([{id:'price',value:'68',status:'confirmed'}]));
  const layout=await layoutDocument(confirmed,()=>{});assert.equal(layout.issues.length,0);assert.ok((await renderPdf(layout)).bytes.length>0);
});
