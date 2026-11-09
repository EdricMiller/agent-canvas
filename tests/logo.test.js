import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {inspectTransparency,assertTransparentImage} from '../server/image-output.js';
import {adaptGeneratedImage} from '../server/image-target.js';
import {Store} from '../server/store.js';
import {DocumentStore} from '../server/design/store.js';
import {composeLogo} from '../server/logo.js';
import {layoutDocument,renderPreview,renderPdf} from '../server/design/render.js';
import {runAgent} from '../server/agent.js';
import {Skills} from '../server/skills.js';
import {mockDesignRuntime} from './helpers/design-agent.mjs';
import {readAndRenderPdf} from './helpers/pdf.mjs';
import {logoWithBrand} from './helpers/logo.mjs';

const root=path.resolve(import.meta.dirname,'..');
export const logoFixture=()=>sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240"><circle cx="120" cy="100" r="66" fill="#f4c797"/><path d="M50 92Q120 2 190 92" fill="#2b2930"/><g stroke="#151515" stroke-width="6" fill="white"><circle cx="94" cy="106" r="21"/><circle cx="146" cy="106" r="21"/><path d="M115 105h10"/></g><path d="M48 230Q50 158 120 164Q190 158 192 230" fill="#627d65"/></svg>')).png().toBuffer();
function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'canvas-logo-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const store=new Store(dir),session=store.create(),documents=new DocumentStore(dir);
  session.skillId='logo-design';return {dir,session,store,documents,signal:new AbortController().signal};
}
const composition=(imageId,patch={})=>({imageId,brandName:'小菜食堂',layout:'stacked',pageId:null,label:'Logo 初稿',...patch});

test('transparency checks pixels: white details survive, fake transparency and blank images fail',async()=>{
  const bytes=await logoFixture(),report=await assertTransparentImage(bytes);
  assert.ok(report.transparentPixels>0);assert.ok(report.visiblePixels>0);assert.ok(report.edgeTransparentPixels>0);
  const {data,info}=await sharp(bytes).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  const white=(106*info.width+94)*4;assert.deepEqual([...data.subarray(white,white+4)],[255,255,255,255]);
  for(const background of ['#ffffff','#999999','#00000000']){
    const opaque=await sharp({create:{width:32,height:32,channels:4,background}}).png().toBuffer();
    assert.equal((await inspectTransparency(opaque)).hasTransparency,false);
    await assert.rejects(assertTransparentImage(opaque),/透明/);
  }
  const checker=await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="white"/><rect width="16" height="16" fill="#ccc"/></svg>')).png().toBuffer();
  await assert.rejects(assertTransparentImage(checker),/透明边缘/);
});

test('transparent size adaptation preserves alpha and adds transparent padding',async()=>{
  const out=await adaptGeneratedImage(await logoFixture(),{mode:'pixels',width:240,height:480,fit:'contain',background:'transparent'});
  assert.equal(out.adaptation.method,'contain');assert.equal(out.adaptation.background,'transparent');
  await assertTransparentImage(out.bytes);
  const {data,info}=await sharp(out.bytes).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  assert.equal(data[(10*info.width+120)*4+3],0);
  assert.equal(data[(226*info.width+94)*4+3],255);
});

test('Logo composition separates exact brand text, preserves existing pages, and exports true transparent PNG',async t=>{
  const f=fixture(t),asset=f.store.addImage(f.session,await logoFixture(),{kind:'generated',demo:false});
  const existing=f.documents.create(f.session.id,{title:'已有宣传页',width:400,height:500});
  const first=await composeLogo({...f,revision:1},composition(asset.id));
  assert.equal(first.record.document.pages.length,2);assert.deepEqual(first.record.document.pages[0],existing.document.pages[0]);
  const page=first.record.document.pages[1];assert.equal(page.background,'transparent');assert.equal(page.objects.length,2);
  const text=page.objects.find(o=>o.type==='text');assert.equal(text.text,'小菜食堂');assert.ok(text.bindingId);
  const layout=await layoutDocument(first.record.document,id=>f.store.image(f.session,id).bytes);
  const png=await renderPreview(layout,{pageId:page.id});await assertTransparentImage(png.bytes);
  const jpeg=await renderPreview(layout,{pageId:page.id,format:'jpeg'});
  const {data}=await sharp(jpeg.bytes).raw().toBuffer({resolveWithObject:true});assert.deepEqual([...data.subarray(0,3)],[255,255,255]);
  const pdf=await renderPdf(layout,{pageId:page.id}),rendered=await readAndRenderPdf(pdf.bytes);assert.match(rendered.text,/小菜食堂/);
  const changed=await composeLogo({...f,revision:first.record.revision},composition(asset.id,{pageId:page.id,brandName:'小菜饭馆',label:'仅改店名'}));
  const next=changed.record.document.pages[1];assert.equal(next.objects.find(o=>o.type==='text').text,'小菜饭馆');
  assert.deepEqual({...next.objects[1],text:''},{...text,text:''},'editing the name preserves geometry, styles and IDs');
  assert.equal(changed.record.document.pages.length,2);assert.equal(f.session.versions.length,1,'composing and renaming do not generate images');
  assert.equal(changed.record.versions.at(-2).document.pages[1].objects[1].text,'小菜食堂');
});

test('Logo writes reject foreign/opaque assets, stale revisions, locked fields and cancellation',async t=>{
  const f=fixture(t),bytes=await logoFixture(),asset=f.store.addImage(f.session,bytes,{kind:'generated',demo:false});
  const other=f.store.create(),foreign=f.store.addImage(other,bytes,{kind:'upload',demo:false});
  await assert.rejects(composeLogo({...f,revision:null},composition(foreign.id)),/当前会话/);
  const opaque=f.store.addImage(f.session,await sharp(bytes).flatten({background:'white'}).png().toBuffer(),{kind:'generated',demo:false});
  await assert.rejects(composeLogo({...f,revision:null},composition(opaque.id)),/透明边缘/);
  const first=await composeLogo({...f,revision:null},composition(asset.id));
  await assert.rejects(composeLogo({...f,revision:null},composition(asset.id)),/其他窗口/);
  const doc=structuredClone(first.record.document);doc.pages[0].objects[1].locked=true;
  const locked=f.documents.update(f.session.id,doc,1),before=structuredClone(locked);
  await assert.rejects(composeLogo({...f,revision:2},composition(asset.id,{pageId:first.pageId,brandName:'其他店名'})),/锁定/);
  await assert.rejects(composeLogo({...f,revision:2,signal:AbortSignal.abort()},composition(asset.id)),/abort/i);
  assert.deepEqual(f.documents.require(f.session.id),before);
});

test('explicit layered request composes editable text and renames without a paid image call',async t=>{
  const f=fixture(t),bytes=await logoFixture(),reference=f.store.addImage(f.session,bytes,{kind:'upload',demo:false}),events=[];
  const skills=new Skills([path.join(root,'skills')],path.join(f.dir,'skills')),skill=skills.get('logo-design');
  assert.equal(skill.workflow,'logo-design');
  let imageCalls=0;
  const mock=mockDesignRuntime((_body,index)=>[
    {name:'read_logo_design',arguments:{}},
    {name:'render_image',arguments:{prompt:'依照人物照片，Q版人物，黑色圆框眼镜，不含文字',sourceId:reference.id,label:'人物图形'}},
    {name:'compose_logo',arguments:composition(f.session.versions.at(-1).id)},
    '已保存透明 Logo，店名可以独立修改。',
  ][index]);
  mock.runtime.imageAdapter={async edit(_client,args){imageCalls++;assert.equal(args.background,'transparent');return {data:[{b64_json:bytes.toString('base64')}]};}};
  const job={logoRevision:null,referenceIds:[reference.id]};
  await runAgent({...f,skills,skill,config:{agentModel:'test',imageModel:'test',maxImages:1,maxTurns:6},runtime:mock.runtime,emit:(type,data)=>events.push({type,...data}),prompt:'把我转成戴黑圆框眼镜的Q版人物，店名小菜食堂；我需要分层组合，店名是独立可编辑文字',job});
  assert.equal(imageCalls,1);assert.ok(f.session.versions.at(-1).transparency.hasTransparency);assert.ok(job.designResult.pageId);
  const rename=mockDesignRuntime((_body,index)=>index===0?{name:'compose_logo',arguments:composition(f.session.versions.at(-1).id,{pageId:job.designResult.pageId,brandName:'小菜饭馆',label:'改店名'})}:'店名已修改。');
  rename.runtime.imageAdapter={generate(){assert.fail('renaming must not generate an image');},edit(){assert.fail('renaming must not edit an image');}};
  await runAgent({...f,skills,skill,config:{agentModel:'test',imageModel:'test',maxImages:1,maxTurns:4},runtime:rename.runtime,emit:()=>{},prompt:'只把店名改成小菜饭馆',job:{logoRevision:job.designResult.revision,referenceIds:[]}});
  assert.equal(f.documents.require(f.session.id).document.pages[0].objects[1].text,'小菜饭馆');assert.equal(imageCalls,1);
});

test('complete Logo request includes the exact brand in image generation, delivers one image and edits that image to rename',async t=>{
  const f=fixture(t),portrait=await logoFixture(),reference=f.store.addImage(f.session,portrait,{kind:'upload',demo:false});
  const skills=new Skills([path.join(root,'skills')],path.join(f.dir,'skills')),skill=skills.get('logo-design'),bytes=await logoWithBrand(portrait);
  // Preserve a prior layered composition when a new complete Logo is made.
  const existing=await composeLogo({...f,revision:null},composition(reference.id)),before=JSON.stringify(f.documents.require(f.session.id));
  let calls=0;
  const mock=mockDesignRuntime((body,index)=>{
    assert.match(body.instructions,/默认一体化设计/);
    assert.ok(body.instructions.includes(skill.body));
    const compose=body.tools.find(t=>t.name==='compose_logo');assert.match(compose.description,/仅用于用户明确要求/);
    if(index===0)return {name:'render_image',arguments:{prompt:'完整品牌 Logo，准确店名「菜火生」必须出现在标志内，与戴黑圆框眼镜的Q版人物、边框统一设计字形、配色和比例，透明底',sourceId:reference.id,label:'菜火生 · 完整 Logo'}};
    const result=JSON.parse(body.input.filter(i=>i.type==='function_call_output').at(-1).output);
    assert.match(result.next,/默认直接交付包含店名的一体化 Logo/);
    assert.match(result.next,/不再叠加店名/);
    return '已生成包含店名的完整透明 Logo，请核对文字与人物特征。';
  });
  mock.runtime.imageAdapter={async edit(_client,args){calls++;assert.match(args.prompt,/准确店名「菜火生」/);assert.equal(args.background,'transparent');return {data:[{b64_json:bytes.toString('base64')}]};}};
  const job={logoRevision:existing.record.revision,referenceIds:[reference.id]};
  await runAgent({...f,skills,skill,config:{agentModel:'test',imageModel:'test',maxImages:1,maxTurns:4},runtime:mock.runtime,emit:()=>{},prompt:'参考我的照片，为「菜火生」设计完整Q版Logo，保留黑色圆框眼镜',job});
  const complete=f.session.versions.at(-1);assert.equal(calls,1);assert.ok(complete.transparency.hasTransparency);assert.equal(job.designResult,undefined);
  assert.equal(JSON.stringify(f.documents.require(f.session.id)),before);assert.deepEqual(f.store.image(f.session,complete.id).bytes,bytes);
  const updated=await logoWithBrand(portrait,'菜火生小馆');
  const rename=mockDesignRuntime((_body,index)=>index===0?{name:'render_image',arguments:{prompt:'编辑完整Logo，把店名准确改为「菜火生小馆」，统一字形和整体风格，尽量保留其余内容',sourceId:complete.id,label:'菜火生小馆 · 完整 Logo'}}:'已保存新版本，请核对店名。');
  rename.runtime.imageAdapter={async edit(_client,args,inputs){calls++;assert.match(args.prompt,/菜火生小馆/);assert.ok((Array.isArray(inputs)?inputs:[inputs]).some(input=>input.equals(bytes)));return {data:[{b64_json:updated.toString('base64')}]};}};
  const renameJob={logoRevision:existing.record.revision,referenceIds:[]};
  await runAgent({...f,skills,skill,config:{agentModel:'test',imageModel:'test',maxImages:1,maxTurns:4},runtime:rename.runtime,emit:()=>{},prompt:'完整Logo中的店名改为「菜火生小馆」',job:renameJob});
  assert.equal(calls,2);assert.equal(f.session.versions.at(-1).parentId,complete.id);assert.equal(renameJob.designResult,undefined);assert.equal(JSON.stringify(f.documents.require(f.session.id)),before);
});

test('opaque provider output is rejected before transparent padding; no retry or false Logo version',async t=>{
  const f=fixture(t),skills=new Skills([path.join(root,'skills')],path.join(f.dir,'skills')),skill=skills.get('logo-design'),events=[];
  f.session.imageTarget={mode:'pixels',width:240,height:480,fit:'contain',background:'#ffffff'};
  const raw=await sharp({create:{width:32,height:32,channels:4,background:'#ffffff'}}).png().toBuffer();let calls=0;
  const mock=mockDesignRuntime((_body,index)=>index===0?{name:'render_image',arguments:{prompt:'透明Logo',sourceId:null,label:'Logo'}}:'透明检查失败，未保存。');
  mock.runtime.imageAdapter={async generate(){calls++;return {data:[{b64_json:raw.toString('base64')}]};}};
  const job={};await runAgent({...f,skills,skill,config:{agentModel:'test',imageModel:'test',maxImages:1,maxTurns:3},runtime:mock.runtime,emit:(type,data)=>events.push({type,...data}),prompt:'制作透明Logo',job});
  assert.equal(calls,1);assert.equal(job.imageCalls,1);assert.equal(f.session.versions.length,0);assert.equal(f.documents.get(f.session.id),null);
  assert.ok(events.some(e=>e.type==='tool_error'&&e.text.includes('透明边缘')));
});
