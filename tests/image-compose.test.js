import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {Store} from '../server/store.js';
import {composeLogoOnImage,composeRaster,logoPlacementSchema} from '../server/image-compose.js';
import {runAgent} from '../server/agent.js';
import {mockDesignRuntime} from './helpers/design-agent.mjs';
import {fitLogoPlacement,resizeLogoPlacement} from '../shared/image-compose.js';

const decode=bytes=>sharp(bytes).ensureAlpha().raw().toBuffer({resolveWithObject:true});
const base=()=>sharp({create:{width:40,height:30,channels:4,background:{r:240,g:235,b:220,alpha:1}}}).png().toBuffer();
const logo=()=>sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect x="3" y="3" width="14" height="14" rx="3" fill="#b00020"/><circle cx="10" cy="10" r="3" fill="#fff"/></svg>')).png().toBuffer();

test('portrait posters use the fitted Logo bounds and proportional resizing can reach every edge',()=>{
  const poster={width:585,height:1080},mark={width:1536,height:1536};
  const original={x:.72,y:.72,width:.28,height:.28,fit:'contain',opacity:1};
  const fitted=fitLogoPlacement(original,poster,mark);
  assert.equal(fitted.width,.28);
  assert.ok(Math.abs(fitted.width*poster.width-fitted.height*poster.height)<1e-9);
  assert.ok(Math.abs(fitted.y+fitted.height/2-(original.y+original.height/2))<1e-9,'tightening a saved box preserves its visible center');
  for(const dimension of ['width','height']){
    const resized=resizeLogoPlacement(fitted,poster,mark,dimension,.4);
    assert.ok(Math.abs(resized.width*poster.width-resized.height*poster.height)<1e-9);
    assert.ok(resized.x+resized.width<=1&&resized.y+resized.height<=1);
  }
  const maximum=resizeLogoPlacement(fitted,poster,mark,'height',1);
  assert.equal(maximum.width,1);assert.ok(maximum.height<1);
  const bottom=1-fitted.height;
  assert.ok(bottom>.72,'the fitted Logo can move below the old container limit');
  assert.equal(bottom+fitted.height,1);
  const wide=fitLogoPlacement(original,poster,{width:200,height:100});
  assert.ok(Math.abs(wide.width*poster.width/(wide.height*poster.height)-2)<1e-9);
  const cover={...original,fit:'cover'};
  assert.deepEqual(fitLogoPlacement(cover,poster,mark),cover);
  assert.deepEqual(resizeLogoPlacement(cover,poster,mark,'width',.2),{...cover,width:.2});
});

test('deterministic logo composition preserves canvas size and places transparent pixels over the base',async()=>{
  const result=await composeRaster(await base(),await logo(),{x:.25,y:.2,width:.5,height:.6,fit:'contain',opacity:1});
  assert.deepEqual([result.width,result.height],[40,30]);
  const {data,info}=await decode(result.bytes);
  const at=(x,y)=>[...data.subarray((y*info.width+x)*4,(y*info.width+x)*4+4)];
  assert.deepEqual(at(0,0),[240,235,220,255]);
  assert.ok([...data].some((value,index)=>index%4===0&&value>120&&data[index+1]<40&&data[index+2]<80),'red Logo pixels should be present');
  assert.deepEqual(logoPlacementSchema.safeParse({x:.8,y:0,width:.3,height:.2}).success,false);
  assert.deepEqual(logoPlacementSchema.safeParse({x:0,y:0,width:.2,height:.2,opacity:1.2}).success,false);
});

test('stored composition keeps native source for print output and rejects opaque Logo',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'canvas-compose-store-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const store=new Store(dir),session=store.create(),working=await base(),native=await sharp({create:{width:80,height:60,channels:4,background:'#eee8d8'}}).png().toBuffer();
  const source=store.addImage(session,working,{kind:'generated',demo:false,width:40,height:30,adaptation:{method:'resize',sourceWidth:80,sourceHeight:60}},{originalBytes:native});
  const mark=store.addImage(session,await logo(),{kind:'generated',demo:false,width:20,height:20});
  const version=await composeLogoOnImage({session,store,sourceId:source.id,logoId:mark.id,placement:{x:.1,y:.1,width:.25,height:.3},label:'叠加 Logo'});
  assert.equal(version.composition.type,'logo-overlay');assert.equal(version.parentId,source.id);assert.deepEqual([version.width,version.height],[40,30]);
  const nativeOutput=store.image(session,version.id,{original:true}).bytes;
  assert.deepEqual((await sharp(nativeOutput).metadata()).width,80);assert.deepEqual((await sharp(nativeOutput).metadata()).height,60);
  const opaque=store.addImage(session,await sharp({create:{width:10,height:10,channels:3,background:'#000'}}).png().toBuffer(),{kind:'generated',demo:false,width:10,height:10});
  await assert.rejects(()=>composeLogoOnImage({session,store,sourceId:source.id,logoId:opaque.id,placement:{x:0,y:0,width:.2,height:.2},label:'错误'}),/透明/);
  const other=store.create();
  await assert.rejects(()=>composeLogoOnImage({session:other,store,sourceId:source.id,logoId:mark.id,placement:{x:0,y:0,width:.2,height:.2},label:'跨会话'}),/不属于当前会话/);
});

test('SDK composition tool creates a version without image-model calls',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'canvas-compose-agent-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const store=new Store(dir),session=store.create(),source=store.addImage(session,await base(),{kind:'generated',demo:false,width:40,height:30}),mark=store.addImage(session,await logo(),{kind:'generated',demo:false,width:20,height:20}),job={imageCalls:0};
  const mock=mockDesignRuntime((body,index)=>{
    if(index===0){assert.ok(body.tools.some(t=>t.name==='compose_logo_on_image'));assert.match(body.instructions,/优先调用 compose_logo_on_image/);return {name:'compose_logo_on_image',arguments:{sourceId:source.id,logoId:mark.id,placement:{x:.1,y:.1,width:.3,height:.3,fit:'contain',opacity:1},label:'组合 Logo'}};}
    const result=JSON.parse(body.input.filter(i=>i.type==='function_call_output').at(-1).output);assert.equal(result.imageModelCalled,false);return '已完成 Logo 组合。';
  });
  mock.runtime.imageAdapter={edit:()=>assert.fail('composition must not call image edit'),generate:()=>assert.fail('composition must not call image generation')};
  await runAgent({session,store,skill:null,skills:null,config:{agentModel:'test',imageModel:'test',maxImages:1,maxTurns:4},runtime:mock.runtime,emit:()=>{},signal:new AbortController().signal,prompt:'把 Logo 直接拼接到这张底图上',job});
  assert.equal(job.imageCalls,0);assert.equal(job.composeEdits,1);assert.equal(session.versions.length,3);assert.equal(session.selectedId,session.versions.at(-1).id);
});

test('edge placement on odd canvas dimensions stays inside the image and opacity preserves the base',async()=>{
  const bytes=await sharp({create:{width:3,height:3,channels:4,background:'#ffffff'}}).png().toBuffer();
  const result=await composeRaster(bytes,await logo(),{x:.5,y:.5,width:.5,height:.5,opacity:1});
  assert.deepEqual([result.width,result.height],[3,3]);
  const untouched=await composeRaster(await base(),await logo(),{x:.25,y:.2,width:.5,height:.6,opacity:0});
  assert.deepEqual((await decode(untouched.bytes)).data,(await decode(await base())).data);
  const half=await composeRaster(await base(),await logo(),{x:.25,y:.2,width:.5,height:.6,opacity:.5});
  const before=await decode(await base()),after=await decode(half.bytes);
  for(let y=0;y<30;y++)for(let x=0;x<40;x++)if(x<10||x>=30||y<6||y>=24){
    const i=(y*40+x)*4;assert.deepEqual(after.data.subarray(i,i+4),before.data.subarray(i,i+4));
  }
  assert.notDeepEqual(after.data,before.data);
});

test('composition recalculates transparency and retains a smaller native source without claiming extra detail',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'canvas-compose-alpha-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const store=new Store(dir),session=store.create();
  const original=await sharp({create:{width:20,height:15,channels:3,background:'#fff'}}).png().toBuffer();
  const source=store.addImage(session,await base(),{kind:'generated',width:40,height:30,demo:false,background:'transparent',transparency:{hasTransparency:true},adaptation:{method:'resize',sourceWidth:20,sourceHeight:15,upscaled:true}},{originalBytes:original});
  const mark=store.addImage(session,await logo(),{kind:'upload',width:20,height:20,demo:false});
  const result=await composeLogoOnImage({session,store,sourceId:source.id,logoId:mark.id,placement:{x:0,y:0,width:.5,height:.5},label:'组合'});
  assert.equal(result.background,'opaque');assert.equal(result.transparency.hasTransparency,false);assert.equal(result.adaptation.upscaled,true);
  assert.deepEqual([result.adaptation.sourceWidth,result.adaptation.sourceHeight],[20,15]);
});
