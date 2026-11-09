import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {imageGenerationPlan,generationSettings} from '../shared/image-generation.js';
import {targetGeometry} from '../shared/image-target.js';
import {imageGenerationSchema,adaptGeneratedImage} from '../server/image-target.js';

const model='gpt-image-2.5-sunburst',ratio={mode:'ratio',width:13,height:24,fit:'contain',background:'#ffffff'};
test('quality is independent of native pixels; 4K portrait is requested from the model, not locally enlarged',()=>{
  assert.deepEqual(generationSettings(),{quality:'high',resolution:'auto'});
  const settings={quality:'max',resolution:'4k'},p=imageGenerationPlan(ratio,settings,model);
  assert.equal(p.size,'2080x3840');assert.equal(p.quality,'max');assert.equal(p.experimental,true);assert.equal(p.adapted,false);
  assert.equal(imageGenerationPlan(ratio,{...settings,quality:'medium'},model).size,p.size);
  assert.deepEqual(targetGeometry(ratio,settings),{width:2080,height:3840,aspectWidth:13,aspectHeight:24});
  const pixels={...ratio,mode:'pixels',width:585,height:1080};
  assert.equal(imageGenerationPlan(pixels,settings,model).size,'2080x3840');
  assert.deepEqual([targetGeometry(pixels,settings).width,targetGeometry(pixels,settings).height],[585,1080]);
  assert.equal(imageGenerationPlan(pixels,{quality:'high',resolution:'auto'},model).size,'624x1152');
  assert.equal(imageGenerationPlan(ratio,{quality:'high',resolution:'2k'},model).size,'1040x1920');
});

test('all requested native sizes satisfy the Images API grid, aspect and pixel bounds',()=>{
  for(const resolution of ['auto','2k','4k'])for(const [width,height] of [[1,1],[9,16],[21,9],[37,19],[585,1081],[1,10],[10,1]]){
    const target={...ratio,width,height},p=imageGenerationPlan(target,{quality:'high',resolution},model),area=p.width*p.height;
    assert.equal(p.width%16,0);assert.equal(p.height%16,0);assert.ok(Math.max(p.width,p.height)<=3840);
    assert.ok(area>=655360&&area<=8294400,`${width}:${height}/${resolution}/${p.size}`);
    assert.ok(Math.max(p.width/p.height,p.height/p.width)<=3);
    if(resolution==='2k')assert.ok(Math.max(p.width,p.height)<=2048);
  }
  assert.equal(imageGenerationPlan({...ratio,width:1,height:1},{quality:'high',resolution:'4k'},model).size,'2880x2880','square obeys total pixel cap');
  assert.equal(imageGenerationPlan(null,undefined,model).size,'auto');
  assert.throws(()=>imageGenerationPlan(null,{quality:'high',resolution:'4k'},model),/先指定/);
});

test('legacy providers keep configured sizes and unsupported parameters are rejected explicitly',()=>{
  assert.equal(imageGenerationPlan(ratio,undefined,'gpt-image-1','1024x1536').size,'1024x1536');
  assert.throws(()=>imageGenerationPlan(ratio,{quality:'high',resolution:'4k'},'gpt-image-1'),/当前模型/);
  assert.throws(()=>imageGenerationPlan(ratio,{quality:'max',resolution:'auto'},'gpt-image-2'),/精细度/);
  for(const settings of [{quality:'ultra',resolution:'4k'},{quality:'high',resolution:'8k'},{quality:'high',resolution:'4k',unexpected:true}])assert.equal(imageGenerationSchema.safeParse(settings).success,false);
});

test('real returned dimensions govern delivery and the untouched high resolution source remains downloadable',async()=>{
  const source=await sharp({create:{width:2080,height:3840,channels:3,background:'#527c69'}}).png().toBuffer(),settings={quality:'high',resolution:'4k'};
  const native=await adaptGeneratedImage(source,ratio,settings);
  assert.equal(native.adaptation.method,'native');assert.equal(native.adaptation.upscaled,false);assert.equal(native.originalBytes,null);
  const small=await adaptGeneratedImage(source,{...ratio,mode:'pixels',width:585,height:1080},settings);
  assert.deepEqual([small.width,small.height],[585,1080]);assert.equal(small.adaptation.upscaled,false);
  assert.deepEqual(small.originalBytes,source);assert.equal(small.adaptation.method,'resize');
});
