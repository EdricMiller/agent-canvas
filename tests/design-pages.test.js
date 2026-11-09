import test from 'node:test';
import assert from 'node:assert/strict';
import {changePages} from '../shared/design-pages.js';
import {parsePageRange} from '../shared/page-range.js';
import {paginateDesign} from '../server/design/pagination.js';
import {documentSchema} from '../server/design/document.js';
import {layoutDocument} from '../server/design/render.js';
import {applyDesignChanges} from '../server/design/operations.js';
import {boundDesign} from './helpers/design-agent.mjs';

const canvas={title:'通用价目表',width:140,height:180,unit:'mm',background:'#ffffff'};
const options={heading:'产品清单',rows:Array.from({length:100},(_,i)=>({name:`产品 ${String(i+1).padStart(3,'0')}`,value:`${i+1} 元`,description:'规格及说明',status:'confirmed'})),columns:1,fontSize:12};

test('page operations preserve original IDs, clone bindings independently and remove exclusive content only',()=>{
  const original=boundDesign(),before=structuredClone(original);
  const {document:copy,selectedId}=changePages(original,{type:'duplicate',pageId:original.pages[0].id});
  assert.deepEqual(original,before);documentSchema.parse(copy);
  assert.equal(copy.pages.length,2);assert.notEqual(copy.pages[1].objects[1].bindingId,'price');
  const newPrice=copy.pages[1].objects[1].bindingId;
  const edited=applyDesignChanges(copy,{pageId:selectedId,upsertObjects:[],removeObjectIds:[],newContent:[],contentUpdates:[{id:newPrice,value:'99',status:'confirmed'}],title:null,background:'#eeeeee'});
  assert.deepEqual(edited.pages[0],original.pages[0]);assert.equal(edited.pages[1].objects[1].text,'99');
  const moved=changePages(edited,{type:'move',pageId:selectedId,toIndex:0}).document;
  assert.equal(moved.pages[0].id,selectedId);
  moved.content.push({id:'unplaced',label:'原始内容',value:'保留',status:'confirmed'});
  const removed=changePages(moved,{type:'delete',pageId:selectedId}).document;
  assert.deepEqual(removed.pages,[original.pages[0]]);assert.equal(removed.content.length,3);assert.ok(!removed.content.some(f=>f.id===newPrice));
  assert.throws(()=>changePages(removed,{type:'delete',pageId:removed.pages[0].id}),/至少/);
  const added=changePages(removed,{type:'add',pageId:removed.pages[0].id}).document;
  assert.equal(added.pages[1].width,180);assert.equal(added.pages[1].objects.length,0);
  assert.throws(()=>applyDesignChanges(copy,{upsertObjects:[],removeObjectIds:[],newContent:[],contentUpdates:[],title:null,background:null}),/目标页面/);
});

test('pagination measures all rows consistently in mm and px, preserving content and page-specific edits',async()=>{
  for(const columns of [1,2,3])for(const settings of [canvas,{...canvas,unit:'px',width:canvas.width*96/25.4,height:canvas.height*96/25.4}]){
    const result=paginateDesign(settings,{...options,columns});
    assert.ok(result.pageIds.length>=3);assert.ok(result.document.pages.every(p=>p.objects[0].text===options.heading));assert.equal(result.document.content.length,301);
    const laidOut=await layoutDocument(result.document,()=>{throw new Error('unexpected asset');});
    assert.deepEqual(laidOut.issues,[]);
    const names=result.document.pages.flatMap(p=>p.objects.filter(o=>o.type==='text'&&/^产品 \d/.test(o.text)).map(o=>o.text));
    assert.deepEqual(names,options.rows.map(r=>r.name));
    const first=structuredClone(result.document.pages[0]),third=result.document.pages[2];
    const changed=applyDesignChanges(result.document,{pageId:third.id,upsertObjects:[],removeObjectIds:[],newContent:[],contentUpdates:[],title:null,background:'#fff0ff'});
    assert.deepEqual(changed.pages[0],first);assert.equal(changed.pages[2].background,'#fff0ff');
  }
});

test('append pagination preserves existing pages, provenance and uncertain values; rejects oversized content atomically',()=>{
  const existing=boundDesign(),before=structuredClone(existing),sourceId='11e15634-37b3-4016-84bc-ec707b60a713';
  const result=paginateDesign(canvas,{...options,rows:[{name:'待确认条目',value:'待确认',description:'原文',status:'needs_confirmation',sourceId}],logoId:sourceId},existing);
  assert.deepEqual(existing,before);assert.deepEqual(result.document.pages[0],existing.pages[0]);
  assert.equal(result.document.pages[1].objects.at(-1).text,'原文');
  assert.ok(result.document.content.filter(f=>f.sourceId===sourceId).every(f=>f.status==='needs_confirmation'));
  assert.equal(result.document.pages[1].objects[1].assetId,sourceId);
  assert.throws(()=>paginateDesign({...canvas,width:20,height:30},options),/放不下|无法完整/);
  assert.throws(()=>paginateDesign(canvas,{...options,rows:[{name:'超长\n'.repeat(100),value:'',description:'',status:'confirmed'}]}),/无法完整/);
  let max=boundDesign();for(let i=1;i<20;i++)max=changePages(max,{type:'add',pageId:max.pages.at(-1).id}).document;
  assert.throws(()=>changePages(max,{type:'duplicate',pageId:max.pages[0].id}),/20/);
  assert.throws(()=>paginateDesign(canvas,options,max),/20 页/);assert.equal(max.pages.length,20);
});

test('custom ranges validate bounds and return deduplicated document order',()=>{
  assert.deepEqual(parsePageRange('3, 1-2，2',5),[0,1,2]);assert.deepEqual(parsePageRange('5',5),[4]);
  for(const bad of ['', '0','6','3-1','1,,2','1.5','all','1-2-3'])assert.throws(()=>parsePageRange(bad,5));
});
