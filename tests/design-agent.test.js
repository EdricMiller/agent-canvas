import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {Store} from '../server/store.js';
import {Skills} from '../server/skills.js';
import {DocumentStore} from '../server/design/store.js';
import {runAgent} from '../server/agent.js';
import {layoutDocument,renderPdf} from '../server/design/render.js';
import {readAndRenderPdf} from './helpers/pdf.mjs';
import {mockDesignRuntime,boundDesign} from './helpers/design-agent.mjs';

async function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'canvas-design-agent-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const store=new Store(dir),documents=new DocumentStore(dir),session=store.create();
  const bytes=await sharp({create:{width:200,height:200,channels:4,background:'#7961cf80'}}).png().toBuffer();
  const menu=store.addImage(session,bytes,{kind:'upload',demo:false,width:200,height:200,label:'内容明细'}),logo=store.addImage(session,bytes,{kind:'upload',demo:false,width:200,height:200,label:'Logo'});
  const job={outputMode:'design',designRevision:null,designCanvas:{title:'通用设计',width:180,height:240,unit:'mm',background:'#ffffff'},referenceIds:[menu.id,logo.id],userMessageId:'user-one',events:[],imageCalls:0};
  session.messages=[{id:'user-one',role:'user',text:'请结合明细和 Logo 制作可编辑设计稿',referenceIds:[menu.id,logo.id]}];
  const controller=new AbortController();
  const execute=runtime=>runAgent({store,documents,session,job,config:{agentModel:'test',imageModel:'test',maxTurns:8},skill:null,skills:null,runtime,emit:(type,data)=>job.events.push({type,...data}),signal:controller.signal,prompt:session.messages[0].text});
  return {store,documents,session,job,menu,logo,controller,execute};
}
const output=body=>JSON.parse(body.input.filter(i=>i.type==='function_call_output').at(-1).output);

test('product creative guidance reaches both image and editable conversations without forcing production',async t=>{
  for(const mode of ['image','design'])await t.test(mode,async t=>{
    const f=await fixture(t),skills=new Skills([path.resolve(import.meta.dirname,'../skills')],path.join(f.store.root,'skills'));
    const skill=skills.get('product-promotion');f.job.outputMode=mode;
    const prompt='先讨论：餐饮要诱人，珠宝要贵气，但根据各自商品和品牌决定画面。';
    const mock=mockDesignRuntime(body=>{
      assert.ok(body.instructions.includes(`<skill>\n${skill.body}\n</skill>`),'the selected creative guidance must reach the actual SDK request in either mode');
      assert.equal(body.input.at(-1).content[0].text,prompt);
      return '会结合具体商品、品牌和用途判断视觉表达。';
    });
    await runAgent({store:f.store,documents:f.documents,session:f.session,job:f.job,config:{agentModel:'test',imageModel:'test',maxTurns:3},skill,skills,runtime:mock.runtime,emit:()=>{},signal:f.controller.signal,prompt});
    assert.equal(mock.requests.length,1);assert.equal(f.job.imageCalls,0);assert.equal(f.documents.get(f.session.id),null);
  });
});

test('dialogue can create a 585 by 1080 design directly from the default 1200 by 1600 canvas',async t=>{
  const f=await fixture(t),document=boundDesign({width:585,height:1080,unit:'px',logoId:f.logo.id});
  f.job.designCanvas={title:'广告',width:1200,height:1600,unit:'px',background:'#ffffff'};
  f.session.messages[0].text='好，你设计一版我看下，记得尺寸是宽585、高1080';
  const mock=mockDesignRuntime((body,index)=>{
    if(index===0)return {name:'read_design_document',arguments:{}};
    if(index===1){assert.equal(output(body).canvas.width,1200);return {name:'create_design_document',arguments:{document,label:'585×1080 广告'}};}
    assert.equal(output(body).saved,true);assert.equal(output(body).canvas.width,585);assert.equal(output(body).canvas.height,1080);
    return '已按宽585、高1080 px 保存。';
  });
  await f.execute(mock.runtime);
  const saved=f.documents.require(f.session.id);assert.deepEqual(saved.document,document);
  assert.equal(saved.versions.length,1);assert.equal(f.job.designCanvas.width,585);assert.equal(f.job.designCanvas.height,1080);
  assert.equal(f.job.designResult.pageId,document.pages[0].id);assert.equal(f.job.imageCalls,0);
});

test('dialogue resizes and reflows an existing target page in one save while preserving locked objects and other pages',async t=>{
  const f=await fixture(t),before=boundDesign({width:1200,height:1600,unit:'px',logoId:f.logo.id});
  Object.assign(before.pages[0].objects[2],{x:10,y:10,width:30,height:30,locked:true});
  before.pages.push({...structuredClone(before.pages[0]),id:'other-page',objects:[]});
  f.documents.createFromDocument(f.session.id,before);f.job.designRevision=1;f.job.designPageId=before.pages[0].id;
  const resized=boundDesign({width:585,height:1080,unit:'px'}),mock=mockDesignRuntime((body,index)=>{
    if(index===0)return {name:'apply_design_changes',arguments:{pageSize:{width:585,height:1080,unit:'px'},upsertObjects:resized.pages[0].objects,removeObjectIds:[],newContent:[],contentUpdates:[],title:null,background:null,label:'调整为竖版广告'}};
    assert.equal(output(body).saved,true);assert.equal(output(body).canvas.width,585);return '已调整尺寸并重新排版。';
  });
  await f.execute(mock.runtime);
  const saved=f.documents.require(f.session.id),page=saved.document.pages[0];
  assert.equal(page.width,585);assert.equal(page.height,1080);assert.deepEqual(page.objects[2],before.pages[0].objects[2]);
  assert.deepEqual(saved.document.pages[1],before.pages[1]);assert.deepEqual(saved.document.content,before.content);
  assert.equal(saved.revision,2);assert.deepEqual(saved.versions[0].document,before);assert.equal(saved.versions.length,2);
});

test('a smaller canvas with overflowing unchanged objects is rejected without persisting the size',async t=>{
  const f=await fixture(t),before=boundDesign({width:1200,height:1600,unit:'px'});
  f.documents.createFromDocument(f.session.id,before);f.job.designRevision=1;
  const mock=mockDesignRuntime((body,index)=>{
    if(index===0)return {name:'apply_design_changes',arguments:{pageSize:{width:585,height:1080,unit:'px'},upsertObjects:[],removeObjectIds:[],newContent:[],contentUpdates:[],title:null,background:null,label:'需要重排'}};
    assert.equal(output(body).saved,false);assert.ok(output(body).issues.length);return '尚未保存，需要同步调整布局。';
  });
  await f.execute(mock.runtime);assert.deepEqual(f.documents.require(f.session.id).document,before);
  assert.equal(f.documents.require(f.session.id).revision,1);assert.equal(f.job.designResult,undefined);
});

test('automatic pagination accepts the dialogue page size instead of the initial canvas size',async t=>{
  const f=await fixture(t),mock=mockDesignRuntime((body,index)=>{
    if(index===0)return {name:'create_paginated_design',arguments:{pageSize:{width:585,height:1080,unit:'px'},heading:'今日菜单',rows:[{name:'麻辣烫',value:'28',description:'',status:'confirmed'}],columns:1,fontSize:18,color:'#292a31',label:'自定义尺寸菜单'}};
    assert.equal(output(body).saved,true);return '已按585×1080 px 排版。';
  });
  await f.execute(mock.runtime);
  const pages=f.documents.require(f.session.id).document.pages;
  assert.ok(pages.every(p=>p.width===585&&p.height===1080&&p.unit==='px'));
});

test('real SDK generates bound text and logo objects with independent PDF text and no image generation',async t=>{
  const f=await fixture(t),document=boundDesign({sourceId:f.menu.id,logoId:f.logo.id});
  const mock=mockDesignRuntime((body,index)=>{
    assert.ok(body.tools.some(t=>t.name==='create_design_document'));assert.ok(!body.tools.some(t=>t.name==='render_image'||t.name==='render_menu_layout'));
    assert.doesNotMatch(JSON.stringify(body.tools),/"oneOf"/);assert.equal(body.parallel_tool_calls,false);
    if(index===0)return {name:'read_design_document',arguments:{}};
    if(index===1){assert.equal(output(body).referenceIds.length,2);return {name:'create_design_document',arguments:{document,label:'AI 初稿'}};}
    assert.equal(output(body).saved,true);return '可编辑稿已生成。';
  });
  assert.equal(await f.execute(mock.runtime),'可编辑稿已生成。');
  const record=f.documents.require(f.session.id);assert.equal(record.document.pages[0].objects.length,3);assert.equal(record.versions.length,1);
  assert.equal(f.session.versions.length,2);assert.equal(f.job.imageCalls,0);
  const layout=await layoutDocument(record.document,id=>f.store.image(f.session,id).bytes),pdf=await renderPdf(layout);
  const parsed=await readAndRenderPdf(pdf.bytes);assert.match(parsed.text,/今日精选/);assert.match(parsed.text,/68/);
  const images=mock.requests[0].input.at(-1).content.filter(c=>c.type==='input_image');assert.equal(images.length,2);
});

test('content changes preserve unrelated objects and snapshot the manual design before AI changes',async t=>{
  const f=await fixture(t),before=boundDesign({logoId:f.logo.id});f.documents.createFromDocument(f.session.id,before);f.job.designRevision=1;
  const mock=mockDesignRuntime((body,index)=>index===0?{name:'update_design_content',arguments:{changes:[{id:'price',value:'78',status:'confirmed'}],label:'调整价格'}}:(assert.equal(output(body).saved,true),'价格已修改。'));
  await f.execute(mock.runtime);const result=f.documents.require(f.session.id);
  assert.equal(result.document.content[1].value,'78');assert.equal(result.document.pages[0].objects[1].text,'78');
  assert.deepEqual(result.document.pages[0].objects[0],before.pages[0].objects[0]);assert.deepEqual(result.document.pages[0].objects[2],before.pages[0].objects[2]);
  assert.equal(result.versions.length,2);assert.equal(result.versions[0].document.content[1].value,'68');assert.equal(result.revision,2);
});

test('strict SDK nullable optional fields round-trip into the document schema',async t=>{
  const f=await fixture(t),document=boundDesign();for(const field of document.content)field.sourceId=null;
  const mock=mockDesignRuntime((body,index)=>{
    if(index===0)return {name:'create_design_document',arguments:{document,label:'纯文字稿'}};
    assert.equal(output(body).saved,true);return '已保存。';
  });
  await f.execute(mock.runtime);assert.equal(f.documents.require(f.session.id).document.content[0].sourceId,undefined);
});

test('real SDK tool rejects locked content updates and preserves omitted hidden flags on unrelated edits',async t=>{
  const f=await fixture(t),document=boundDesign({logoId:f.logo.id});
  document.pages[0].objects[1].locked=true;document.pages[0].objects[2].hidden=true;
  f.documents.createFromDocument(f.session.id,document);f.job.designRevision=1;
  const mock=mockDesignRuntime((body,index)=>{
    if(index===0)return {name:'update_design_content',arguments:{changes:[{id:'price',value:'78',status:'confirmed'}],label:'修改锁定价格'}};
    if(index===1){
      assert.equal(output(body).saved,false);assert.match(output(body).error,/锁定/);assert.equal(f.documents.require(f.session.id).revision,1);
      return {name:'apply_design_changes',arguments:{upsertObjects:[{...document.pages[0].objects[2],hidden:null,x:100}],removeObjectIds:[],newContent:[],contentUpdates:[],title:null,background:null,label:'调整未锁定的隐藏图片'}};
    }
    assert.equal(output(body).saved,true);return '已保留锁定价格与隐藏状态。';
  });
  await f.execute(mock.runtime);const result=f.documents.require(f.session.id);
  assert.equal(result.document.content[1].value,'68');assert.equal(result.document.pages[0].objects[1].locked,true);
  assert.equal(result.document.pages[0].objects[2].hidden,true);assert.equal(result.document.pages[0].objects[2].x,100);assert.equal(result.revision,2);
});

test('AI reconstructs a flat reference into bound text while retaining unrelated objects',async t=>{
  const f=await fixture(t),target=boundDesign({sourceId:f.menu.id,logoId:f.logo.id}),p=target.pages[0];
  const flat={schemaVersion:1,title:'原有图片稿',pages:[{...p,objects:[{id:'flat-reference',type:'image',assetId:f.menu.id,x:0,y:0,width:p.width,height:p.height,fit:'contain'},{id:'accent',type:'rect',x:0,y:0,width:p.width,height:2,fill:'#7961cf'}]}]};
  f.documents.createFromDocument(f.session.id,flat);f.job.designRevision=1;
  const mock=mockDesignRuntime((body,index)=>index===0?{name:'apply_design_changes',arguments:{upsertObjects:p.objects,removeObjectIds:['flat-reference'],newContent:target.content,contentUpdates:[],title:null,background:null,label:'重新排成独立文字'}}:(assert.equal(output(body).saved,true),'已重排为可编辑对象。'));
  await f.execute(mock.runtime);const result=f.documents.require(f.session.id).document;
  assert.equal(result.pages[0].objects.length,4);assert.deepEqual(result.pages[0].objects[0],flat.pages[0].objects[1]);
  assert.equal(result.content.length,2);assert.equal(result.pages[0].objects.filter(o=>o.type==='text').length,2);
  assert.ok(!result.pages[0].objects.some(o=>o.id==='flat-reference'));
});

test('bad layout returns actionable issues without saving a partial design',async t=>{
  const f=await fixture(t),document=boundDesign();document.pages[0].objects[0].height=.1;
  const mock=mockDesignRuntime((body,index)=>{
    if(index===0)return {name:'create_design_document',arguments:{document,label:'溢出稿'}};
    const result=output(body);assert.equal(result.saved,false);assert.ok(result.issues.some(i=>i.code==='text_overflow'));return '排版需要调整，尚未保存。';
  });
  await f.execute(mock.runtime);assert.equal(f.documents.get(f.session.id),null);assert.equal(f.job.designResult,undefined);assert.equal(f.session.versions.length,2);
});

test('AI revision conflicts preserve the latest manual edit without rebasing or overwriting it',async t=>{
  const f=await fixture(t),document=boundDesign();f.documents.createFromDocument(f.session.id,document);f.job.designRevision=1;
  const manual=structuredClone(document);manual.title='另一个窗口的修改';
  const mock=mockDesignRuntime((body,index)=>{
    if(index===0){f.documents.update(f.session.id,manual,1);return {name:'update_design_content',arguments:{changes:[{id:'price',value:'78',status:'confirmed'}],label:'过期修改'}};}
    assert.equal(output(body).conflict,true);return '稿件已更新，请刷新。';
  });
  await f.execute(mock.runtime);const result=f.documents.require(f.session.id);assert.equal(result.document.title,manual.title);assert.equal(result.document.content[1].value,'68');assert.equal(result.versions.length,0);
});

test('cancel during layout leaves the prior document and versions untouched',async t=>{
  const f=await fixture(t),document=boundDesign({logoId:f.logo.id});f.documents.createFromDocument(f.session.id,document);f.job.designRevision=1;
  const before=f.documents.require(f.session.id),original=f.store.image.bind(f.store);
  // Only the layout resolves the asset: current request references are empty.
  f.job.referenceIds=[];
  t.mock.method(f.store,'image',(...args)=>{f.controller.abort(new Error('test cancelled'));return original(...args);});
  const mock=mockDesignRuntime(()=>({name:'update_design_content',arguments:{changes:[{id:'price',value:'78',status:'confirmed'}],label:'取消修改'}}));
  await assert.rejects(f.execute(mock.runtime));assert.deepEqual(f.documents.require(f.session.id),before);assert.equal(f.job.designResult,undefined);
});
