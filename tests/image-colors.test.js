import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {Store} from '../server/store.js';
import {recolorImage,colorRegionsSchema} from '../server/image-colors.js';
import {editImageColors} from '../server/image-color-edit.js';
import {printImageSource} from '../server/design/print-source.js';
import {runAgent} from '../server/agent.js';
import {mockDesignRuntime} from './helpers/design-agent.mjs';

const decode=bytes=>sharp(bytes).toColourspace('srgb').ensureAlpha().raw().toBuffer();
function poster(width=80,height=100){
  const data=Buffer.alloc(width*height*4);
  const set=(x,y,rgb)=>{const i=(y*width+x)*4;data.set([...rgb,255],i);};
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const title=y>=height*.1&&y<height*.3&&x>=width*.1&&x<width*.9;
    const plate=y>=height*.6&&y<height*.9&&x>=width*.2&&x<width*.8;
    const rim=plate&&(y<height*.64||y>=height*.86||x<width*.25||x>=width*.75);
    set(x,y,rim?[20,20,20]:plate?[160,20,30]:title?(x<width/2?[30,20,10]:[245,235,217]):x<width/2?[245,235,217]:[160,20,30]);
  }
  return sharp(data,{raw:{width,height,channels:4}}).png().toBuffer();
}
const background={seeds:[{x:.98,y:.01}],color:'#f5ebd9',tolerance:0};

test('connected background recoloring keeps the original canvas, title, same-color food and every unselected pixel',async()=>{
  const source=await poster(),before=await decode(source),result=await recolorImage(source,[background]),after=await decode(result.bytes);
  assert.deepEqual([result.width,result.height],[80,100]);let changed=0;
  for(let y=0;y<100;y++)for(let x=0;x<80;x++){
    const i=(y*80+x)*4,title=y>=10&&y<30&&x>=8&&x<72,plate=y>=60&&y<90&&x>=16&&x<64;
    if(x>=40&&!title&&!plate){assert.deepEqual([...after.subarray(i,i+4)],[245,235,217,255]);changed++;}
    else assert.deepEqual(after.subarray(i,i+4),before.subarray(i,i+4),`protected ${x},${y}`);
  }
  assert.equal(result.changedPixels,changed);assert.equal(result.preservedPixels,8000-changed);
  assert.deepEqual(await decode(source),before);
});

test('bounded matching recolors disconnected title glyphs without touching the same color elsewhere; regions sample the original',async()=>{
  const source=await poster(),before=await decode(source);
  const title={seeds:[{x:.6,y:.2}],color:'#241a14',mode:'matching',bounds:{x:.5,y:.1,width:.4,height:.2},tolerance:0};
  const result=await recolorImage(source,[background,title]),after=await decode(result.bytes);
  for(let y=0;y<100;y++)for(let x=0;x<80;x++){
    const i=(y*80+x)*4;
    if(y>=10&&y<30&&x>=40&&x<72)assert.deepEqual([...after.subarray(i,i+3)],[36,26,20]);
    else if(x<40||y>=60&&y<90&&x>=16&&x<64)assert.deepEqual(after.subarray(i,i+4),before.subarray(i,i+4));
  }
  assert.equal(colorRegionsSchema.safeParse([{...title,bounds:null}]).success,false);
  assert.equal(colorRegionsSchema.safeParse([{...title,bounds:{x:.9,y:0,width:.2,height:1}}]).success,false);
  assert.equal(colorRegionsSchema.safeParse([{...background,tolerance:81}]).success,false);
  await assert.rejects(()=>recolorImage(source,[{...background,color:'#a0141e'}]),/没有产生颜色变化/);
});

test('local color edits preserve alpha and stop at an explicit rectangle',async()=>{
  const data=Buffer.from([100,20,30,255,100,20,30,255,100,20,30,0,100,20,30,120]);
  const source=await sharp(data,{raw:{width:4,height:1,channels:4}}).png().toBuffer();
  const result=await recolorImage(source,[{seeds:[{x:0,y:0}],color:'#123456',bounds:{x:0,y:0,width:.25,height:1},tolerance:0}]);
  const actual=await decode(result.bytes);assert.deepEqual([...actual.subarray(0,4)],[18,52,86,255]);assert.deepEqual(actual.subarray(4),data.subarray(4));
  await assert.rejects(()=>recolorImage(source,[{...background,seeds:[{x:.6,y:0}]}]),/透明区域/);
  await assert.rejects(()=>recolorImage(source,[background],{signal:AbortSignal.abort()}),/abort/i);
});

test('regions sample original colors even when another replacement introduced the same color; grayscale inputs are supported',async()=>{
  const source=await sharp(Buffer.from([200,0,0,0,0,200]),{raw:{width:2,height:1,channels:3}}).png().toBuffer();
  const result=await recolorImage(source,[{seeds:[{x:0,y:0}],color:'#0000c8',tolerance:0},{seeds:[{x:1,y:0}],color:'#00c800',mode:'matching',bounds:{x:0,y:0,width:1,height:1},tolerance:0}]);
  assert.deepEqual([...await decode(result.bytes)],[0,0,200,255,0,200,0,255]);
  const gray=await sharp(Buffer.from([0,100,200]),{raw:{width:3,height:1,channels:1}}).toColourspace('b-w').png().toBuffer();
  const colored=await recolorImage(gray,[{seeds:[{x:.5,y:0}],color:'#ff0000',tolerance:0}]);
  assert.deepEqual([...await decode(colored.bytes)],[0,0,0,255,255,0,0,255,200,200,200,255]);
});

test('explicit product protection stops color leakage even when food touches an identical background',async()=>{
  const input=await sharp({create:{width:20,height:20,channels:3,background:'#a0141e'}}).png().toBuffer();
  const protect=[[{x:.2,y:.4},{x:.8,y:.4},{x:.8,y:.9},{x:.2,y:.9}]];
  const {bytes}=await recolorImage(input,[background],{protect}),before=await decode(input),after=await decode(bytes);
  for(let y=0;y<20;y++)for(let x=0;x<20;x++){
    const i=(y*20+x)*4;
    if(x>=4&&x<16&&y>=8&&y<18)assert.deepEqual(after.subarray(i,i+4),before.subarray(i,i+4));
    else assert.deepEqual([...after.subarray(i,i+3)],[245,235,217]);
  }
  await assert.rejects(()=>recolorImage(input,[{...background,seeds:[{x:.5,y:.5}]}],{protect}),/保护区内/);
});

test('stored local edits preserve history, native print detail and session ownership',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'canvas-color-store-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const store=new Store(dir),session=store.create(),other=store.create(),working=await poster(),native=await poster(160,200);
  const source=store.addImage(session,working,{kind:'generated',demo:false,width:80,height:100,adaptation:{method:'resize',sourceWidth:160,sourceHeight:200},imageTarget:{mode:'pixels',width:80,height:100,fit:'contain',background:'#f5ebd9'}},{originalBytes:native});
  const version=await editImageColors({store,session,sourceId:source.id,regions:[background],label:'背景换色'});
  assert.equal(version.parentId,source.id);assert.equal(version.renderSourceId,source.id);assert.equal(version.generation,undefined);assert.equal(version.localEdit.type,'recolor');
  assert.deepEqual([version.width,version.height],[80,100]);assert.deepEqual([version.adaptation.sourceWidth,version.adaptation.sourceHeight],[160,200]);
  assert.deepEqual(store.image(session,source.id).bytes,working);assert.deepEqual(store.image(session,source.id,{original:true}).bytes,native);
  assert.deepEqual(await decode(await printImageSource(store,session,version.id)),await decode((await recolorImage(native,[background])).bytes));
  await assert.rejects(()=>editImageColors({store,session:other,sourceId:source.id,regions:[background],label:'foreign'}),/不属于当前会话/);
  assert.equal(other.versions.length,0);assert.equal(session.versions.length,2);
});

test('SDK color edit tool creates a real version without image-model calls or an automatic repaint',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'canvas-color-agent-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const store=new Store(dir),session=store.create(),source=store.addImage(session,await poster(),{kind:'generated',demo:false,width:80,height:100}),job={imageCalls:0},events=[];
  const mock=mockDesignRuntime((body,index)=>{
    if(index===0){
      assert.ok(body.tools.some(t=>t.name==='recolor_image'));assert.match(body.instructions,/优先用 recolor_image/);
      return {name:'recolor_image',arguments:{sourceId:source.id,label:'只改背景',regions:[background]}};
    }
    const result=JSON.parse(body.input.filter(i=>i.type==='function_call_output').at(-1).output);
    if(index===1){assert.equal(result.imageModelCalled,false);assert.equal(result.localEdit.preservedPixels>0,true);return {name:'render_image',arguments:{sourceId:source.id,prompt:'自动重绘',label:'不应生成'}};}
    assert.match(result.error,/用完/);return '背景局部换色完成。';
  });
  mock.runtime.imageAdapter={edit:()=>assert.fail('must not call paid image editing'),generate:()=>assert.fail('must not call paid image generation')};
  await runAgent({session,store,skill:null,skills:null,config:{agentModel:'test',imageModel:'test',maxImages:1,maxTurns:5},runtime:mock.runtime,emit:(type,data)=>events.push({type,...data}),signal:new AbortController().signal,prompt:'只把背景改成暖米白，其他都别动',job});
  assert.equal(job.imageCalls,0);assert.equal(job.colorEdits,1);assert.equal(session.versions.length,2);assert.equal(events.filter(e=>e.type==='image').length,1);
  assert.deepEqual(await decode(store.image(session,session.selectedId).bytes),await decode((await recolorImage(store.image(session,source.id).bytes,[background])).bytes));
});

test('failed color selection saves nothing and cannot silently fall back to a billed repaint',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'canvas-color-failed-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const store=new Store(dir),session=store.create(),source=store.addImage(session,await poster(),{kind:'generated',demo:false}),job={imageCalls:0};
  const mock=mockDesignRuntime((body,index)=>{
    if(index===0)return {name:'recolor_image',arguments:{sourceId:source.id,label:'同色失败',regions:[{...background,color:'#a0141e'}]}};
    const result=JSON.parse(body.input.filter(i=>i.type==='function_call_output').at(-1).output);
    if(index===1){assert.match(result.error,/没有产生颜色变化/);return {name:'render_image',arguments:{sourceId:source.id,label:'不应重绘',prompt:'改背景'}};}
    assert.match(result.error,/不能自动改用整图重绘/);return '请先确认选区。';
  });
  mock.runtime.imageAdapter={edit:()=>assert.fail('unexpected image request'),generate:()=>assert.fail('unexpected image request')};
  await runAgent({session,store,skill:null,skills:null,config:{agentModel:'test',imageModel:'test',maxImages:2,maxTurns:5},runtime:mock.runtime,emit:()=>{},signal:new AbortController().signal,prompt:'只换背景色',job});
  assert.equal(job.imageCalls,0);assert.equal(session.versions.length,1);assert.equal(session.selectedId,source.id);
});
