import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {imageTargetSchema,imageTargetGeometry,imageTargetPrompt,adaptGeneratedImage} from '../server/image-target.js';

const target=(patch={})=>({mode:'pixels',width:585,height:1080,fit:'contain',background:'#ffffff',...patch});
const image=(width,height,background='#d83232')=>sharp({create:{width,height,channels:3,background}}).png().toBuffer();
const metadata=async bytes=>{const {width,height}=await sharp(bytes).metadata();return {width,height};};

test('exact pixels and ratio-only geometry keep the specified ratio without rounding distortion',()=>{
  assert.deepEqual(imageTargetGeometry(target()),{width:585,height:1080,aspectWidth:13,aspectHeight:24});
  assert.deepEqual(imageTargetGeometry(target({mode:'ratio',width:13,height:24})),{width:832,height:1536,aspectWidth:13,aspectHeight:24});
  assert.deepEqual(imageTargetGeometry(target({mode:'ratio',width:16,height:9})),{width:1536,height:864,aspectWidth:16,aspectHeight:9});
  assert.deepEqual(imageTargetGeometry(target({mode:'ratio',width:26,height:48})),imageTargetGeometry(target({mode:'ratio',width:13,height:24})));
  for(const patch of [{width:0},{height:1.5},{width:8193},{width:8192,height:8192},{mode:'ratio',width:1,height:8192},{fit:'fill'},{background:'none'},{unknown:true}])assert.equal(imageTargetSchema.safeParse(target(patch)).success,false,JSON.stringify(patch));
  assert.equal(imageTargetSchema.safeParse(target({background:'transparent'})).success,true);
  assert.equal(imageTargetSchema.safeParse(target({width:5000,height:5000})).success,true);
});

test('responsive reflow prompt asks for layout reconstruction instead of shrinking the old frame',()=>{
  const prompt=imageTargetPrompt(target({width:2390,height:560}),undefined,{reflow:true});
  assert.match(prompt,/响应式重新排版/);
  assert.match(prompt,/不要在中央缩小放置原图/);
  assert.match(prompt,/宽 2390 × 高 560/);
});

test('free ratios support portrait, panorama and uncommon values beyond the current advertising example',async()=>{
  const source=await image(64,64);
  for(const [width,height] of [[1,1],[9,16],[21,9],[7,11],[37,19]]){
    const goal=target({mode:'ratio',width,height});assert.equal(imageTargetSchema.safeParse(goal).success,true);
    const fitted=await adaptGeneratedImage(source,goal),actual=await metadata(fitted.bytes);
    assert.equal(actual.width*height,actual.height*width,`${width}:${height} actual output ratio`);
  }
});

test('contain preserves the entire frame, centers it and records padding without stretching',async()=>{
  const source=await image(100,100),out=await adaptGeneratedImage(source,target({width:100,height:200,background:'#123456'}));
  assert.deepEqual(await metadata(out.bytes),{width:100,height:200});
  assert.equal(out.adaptation.method,'contain');assert.equal(out.adaptation.upscaled,false);
  assert.deepEqual(out.originalBytes,source);
  const {data,info}=await sharp(out.bytes).removeAlpha().raw().toBuffer({resolveWithObject:true});
  const pixel=(x,y)=>[...data.subarray((y*info.width+x)*3,(y*info.width+x)*3+3)];
  assert.deepEqual(pixel(50,5),[18,52,86]);assert.deepEqual(pixel(50,50),[216,50,50]);
  assert.deepEqual(pixel(50,149),[216,50,50]);assert.deepEqual(pixel(50,195),[18,52,86]);
});

test('extreme contain targets trim provider white borders and fill a banner with artwork color',async()=>{
  const source=await sharp({create:{width:1916,height:821,channels:3,background:'#ffffff'}}).composite([
    {input:Buffer.from('<svg width="1916" height="821"><rect x="430" y="230" width="1056" height="360" fill="#ed101a"/><text x="520" y="430" font-size="120" fill="white">18元一碗</text></svg>')},
  ]).png().toBuffer();
  const out=await adaptGeneratedImage(source,target({width:2390,height:560}));
  assert.equal(out.adaptation.method,'background-crop');
  assert.deepEqual(await metadata(out.bytes),{width:2390,height:560});
  const {data}=await sharp(out.bytes).removeAlpha().raw().toBuffer({resolveWithObject:true});
  assert.ok(data[0]>180&&data[1]<80&&data[2]<80);
});

test('cover crops only the requested frame, native and resize remain distinct, upscaling is disclosed',async()=>{
  const source=await sharp({create:{width:200,height:100,channels:3,background:'#ff0000'}}).composite([{input:await image(100,100,'#00ff00'),left:50,top:0}]).png().toBuffer();
  const crop=await adaptGeneratedImage(source,target({width:100,height:100,fit:'cover'}));
  assert.equal(crop.adaptation.method,'cover');assert.equal(crop.adaptation.upscaled,false);
  const {data}=await sharp(crop.bytes).removeAlpha().raw().toBuffer({resolveWithObject:true});assert.deepEqual([...data.subarray(0,3)],[0,255,0]);
  const same=await adaptGeneratedImage(await image(585,1080),target());
  assert.equal(same.adaptation.method,'native');assert.equal(same.originalBytes,null);
  const resize=await adaptGeneratedImage(await image(13,24),target());
  assert.equal(resize.adaptation.method,'resize');assert.equal(resize.adaptation.upscaled,true);assert.deepEqual(await metadata(resize.bytes),{width:585,height:1080});
  const ratio=await adaptGeneratedImage(source,target({mode:'ratio',width:13,height:24}));
  assert.deepEqual(await metadata(ratio.bytes),{width:832,height:1536});assert.equal(ratio.adaptation.upscaled,true);
});

test('legacy generation keeps its returned size; EXIF orientation is normalized before fitting',async()=>{
  const source=await image(20,30),unchanged=await adaptGeneratedImage(source,null);
  assert.deepEqual(unchanged.bytes,source);assert.equal(unchanged.adaptation,null);assert.deepEqual(await metadata(unchanged.bytes),{width:20,height:30});
  const oriented=await sharp(source).withMetadata({orientation:6}).jpeg().toBuffer();
  const out=await adaptGeneratedImage(oriented,target({width:30,height:20}));
  assert.equal(out.adaptation.method,'native');assert.deepEqual([out.adaptation.sourceWidth,out.adaptation.sourceHeight],[30,20]);
  await assert.rejects(()=>adaptGeneratedImage(source,target({width:9000})),/8192/);
});
