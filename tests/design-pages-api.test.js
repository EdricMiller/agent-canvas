import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createApp} from '../server/app.js';
import {readPdfPages} from './helpers/pdf.mjs';
import {mockDesignRuntime} from './helpers/design-agent.mjs';

const canvas={title:'多页通用设计',width:140,height:180,unit:'mm',background:'#ffffff'};
const options={heading:'价目表',columns:1,fontSize:12,rows:Array.from({length:70},(_,i)=>({name:`条目 ${String(i+1).padStart(3,'0')}`,value:`${i+1} 元`,description:'',status:'confirmed'}))};
async function fixture(t,plan){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'canvas-pages-api-')),mock=plan?mockDesignRuntime(plan):null;
  const instance=createApp({root:path.resolve(import.meta.dirname,'..'),dataDir:dir,demo:!mock,apiKey:'fixture-only',agentModel:'test',imageModel:'test',maxTurns:8,sandboxMode:'off'},mock?{runtime:mock.runtime}:{});
  const server=await new Promise((resolve,reject)=>{const s=instance.app.listen(0,'127.0.0.1');s.once('listening',()=>resolve(s));s.once('error',reject);});
  t.after(()=>{instance.shutdown();server.closeAllConnections();server.close();fs.rmSync(dir,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}`,config=await(await fetch(base+'/api/config')).json(),session=instance.store.create(),url=`/api/sessions/${session.id}/design`;
  const request=(url,method='GET',body)=>fetch(base+url,{method,headers:{'Content-Type':'application/json','X-Studio-Token':config.token},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {...instance,session,url,request,mock};
}

test('manual pagination saves atomically, restores whole books and exports ordered PDF ranges',async t=>{
  const f=await fixture(t),body={revision:null,canvas,options};
  const created=await f.request(f.url+'/paginate','POST',body);assert.equal(created.status,201);
  let data=await created.json(),record=data.design,pages=record.document.pages;assert.ok(pages.length>=3);
  const original=structuredClone(record.document),versionId=record.versions[0].id;
  assert.equal(data.addedPageIds.length,pages.length);assert.equal(f.session.versions.length,0);
  assert.equal((await f.request(f.url+'/paginate','POST',body)).status,409);
  assert.equal((await f.request(f.url+'/paginate','POST',{...body,revision:record.revision,options:{...options,logoId:randomUUID()}})).status,400);
  assert.deepEqual(f.documents.require(f.session.id).document,original);
  const all=await f.request(f.url+'/export','POST',{revision:record.revision,format:'pdf'});assert.equal(all.status,200);
  const allText=await readPdfPages(await all.arrayBuffer());assert.equal(allText.length,pages.length);
  assert.match(allText[0],/条目 001/);assert.match(allText.at(-1),/条目 070/);
  const range=await f.request(f.url+'/export','POST',{revision:record.revision,format:'pdf',pageIds:[pages[2].id,pages[0].id]});
  assert.equal(range.status,200);assert.deepEqual(await readPdfPages(await range.arrayBuffer()),[allText[0],allText[2]],'export uses document order');
  const single=await f.request(f.url+'/export','POST',{revision:record.revision,format:'pdf',pageId:pages[2].id,colorSpace:'cmyk'});
  assert.equal(single.status,200);assert.deepEqual(await readPdfPages(await single.arrayBuffer()),[allText[2]]);
  for(const selection of [{pageIds:['foreign']},{pageIds:[pages[0].id,pages[0].id]},{pageId:pages[0].id,pageIds:[pages[1].id]},{pageIds:[]}])assert.ok((await f.request(f.url+'/export','POST',{revision:record.revision,format:'pdf',...selection})).status>=400);
  assert.equal((await f.request(f.url+'/export','POST',{revision:record.revision,format:'png',pageIds:[pages[0].id]})).status,400);
  // Pending content on the third page blocks all pages, but not a checked first page.
  const thirdBinding=pages[2].objects.find(o=>o.type==='text'&&o.bindingId!==pages[0].objects[0].bindingId).bindingId;
  record.document.content.find(c=>c.id===thirdBinding).status='needs_confirmation';
  data=await(await f.request(f.url,'PUT',{revision:record.revision,document:record.document})).json();record=data.design;
  assert.equal((await f.request(f.url+'/export','POST',{revision:record.revision,format:'pdf'})).status,422);
  assert.equal((await f.request(f.url+'/export','POST',{revision:record.revision,format:'pdf',pageId:pages[0].id})).status,200);
  record.document.pages.reverse();data=await(await f.request(f.url,'PUT',{revision:record.revision,document:record.document})).json();
  data=await(await f.request(f.url+'/restore','POST',{revision:data.design.revision,versionId})).json();
  assert.deepEqual(data.design.document,original);
  const append=await f.request(f.url+'/paginate','POST',{...body,revision:data.design.revision,options:{...options,rows:options.rows.slice(0,1)}});assert.equal(append.status,201);
  data=await append.json();assert.deepEqual(data.design.document.pages.slice(0,-1),original.pages);assert.equal(data.design.document.pages.length,original.pages.length+1);
  const before=f.documents.require(f.session.id);
  const invalid=await f.request(f.url+'/paginate','POST',{...body,revision:before.revision,canvas:{...canvas,width:20,height:30}});assert.equal(invalid.status,400);
  assert.deepEqual(f.documents.require(f.session.id),before);
});

test('AI pagination and third-page edits use exact page context while preserving other pages',async t=>{
  let target,expected,stage=0;
  const output=body=>JSON.parse(body.input.filter(i=>i.type==='function_call_output').at(-1).output);
  const f=await fixture(t,(body,index)=>{
    if(index===0)return {name:'create_paginated_design',arguments:{...options,label:'AI 多页价目表'}};
    if(index===1){assert.equal(output(body).saved,true);assert.ok(output(body).pageCount>=3);return '整册已保存。';}
    if(index===2)return {name:'read_design_document',arguments:{}};
    if(index===3){assert.equal(output(body).activePageId,target);return {name:'apply_design_changes',arguments:{pageId:null,upsertObjects:[],removeObjectIds:[],newContent:[],contentUpdates:[],title:null,background:'#eeeeee',label:'仅改第三页背景'}};}
    assert.equal(output(body).saved,true);return '第三页已修改。';
  });
  const turn=(revision,pageId)=>f.request(`/api/sessions/${f.session.id}/turns`,'POST',{text:'制作或修改多页清单',requestId:randomUUID(),design:{revision,canvas,referenceIds:[],...(pageId?{pageId}:{})}});
  assert.equal((await turn(null)).status,202);
  const wait=async()=>{for(let n=0;n<300&&f.session.job.status==='running';n++)await new Promise(r=>setTimeout(r,10));assert.equal(f.session.job.status,'completed',f.session.job.error);};
  await wait();const first=f.documents.require(f.session.id);expected=structuredClone(first.document);target=expected.pages[2].id;
  assert.equal((await turn(first.revision,'missing')).status,404);assert.equal(f.mock.requests.length,2);
  assert.equal((await turn(first.revision,target)).status,202);await wait();
  const after=f.documents.require(f.session.id);assert.deepEqual(after.document.pages[0],expected.pages[0]);assert.deepEqual(after.document.pages[1],expected.pages[1]);assert.equal(after.document.pages[2].background,'#eeeeee');
  assert.equal(after.document.pages.length,expected.pages.length);assert.equal(f.session.job.designPageId,target);assert.equal(f.session.job.imageCalls,0);assert.equal(f.session.versions.length,0);
});
