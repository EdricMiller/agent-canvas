import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {Store} from '../server/store.js';
import {adaptGeneratedImage} from '../server/image-target.js';
import {printImageSource} from '../server/design/print-source.js';
import {nativePrintGeometry} from '../shared/print-image.js';

test('native print assets preserve the displayed composition for resize, contain and cover',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'canvas-print-source-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const store=new Store(dir),session=store.create();
  const source=await sharp(Buffer.from('<svg width="600" height="300"><rect width="600" height="300" fill="#d32d24"/><rect x="180" width="240" height="300" fill="#1e763b"/></svg>')).png().toBuffer();
  for(const [width,height,fit,expectedWidth,expectedHeight] of [[120,60,'contain',600,300],[120,120,'contain',600,600],[120,120,'cover',300,300],[1200,600,'contain',600,300]]){
    const target={mode:'pixels',width,height,fit,background:'#efe1c2'},adapted=await adaptGeneratedImage(source,target);
    const image=store.addImage(session,adapted.bytes,{kind:'generated',demo:false,width,height,adaptation:adapted.adaptation,imageTarget:target},{originalBytes:adapted.originalBytes});
    const before=JSON.stringify(session),bytes=await printImageSource(store,session,image.id),meta=await sharp(bytes).metadata();
    assert.equal(meta.width,expectedWidth);assert.equal(meta.height,expectedHeight);
    const preferred=await printImageSource(store,session,image.id,{preferWorkingPixels:true});
    assert.deepEqual(preferred,expectedWidth*expectedHeight<=width*height?adapted.bytes:bytes);
    const actual=await sharp(bytes).resize(width,height).removeAlpha().raw().toBuffer(),working=await sharp(adapted.bytes).removeAlpha().raw().toBuffer();
    const error=actual.reduce((sum,v,i)=>sum+Math.abs(v-working[i]),0)/actual.length;
    assert.ok(error<1.5,`${fit} must preserve crop, padding and colors; mean error ${error}`);
    assert.equal(JSON.stringify(session),before);
  }
});

test('native print geometry limits pixel allocation and counts native detail rather than upscaled pixels',()=>{
  assert.deepEqual(nativePrintGeometry(585,1080,923,1704),{width:923,height:1704});
  assert.deepEqual(nativePrintGeometry(2400,3600,400,600),{width:400,height:600});
  const bounded=nativePrintGeometry(1000,1000,12000,12000);assert.ok(bounded.width*bounded.height<=25000000);
});
