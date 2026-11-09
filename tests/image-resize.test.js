import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {preservingResizeRequest,resizePreservingContent} from '../server/image-resize.js';

test('content-preserving size requests are parsed without invoking image generation',()=>{
  assert.deepEqual(preservingResizeRequest('把这个尺寸改为长3650X高1090，内容不变'),{width:3650,height:1090});
  assert.deepEqual(preservingResizeRequest('你看我样式让它调整尺寸，改为长2390X高560'),{width:2390,height:560});
  assert.equal(preservingResizeRequest('重新设计一张 3650x1090 海报'),null);
});

test('plain-background resize crops only background and preserves exact output size',async()=>{
  const source=await sharp({create:{width:800,height:300,channels:3,background:'#e4e2db'}}).composite([{input:Buffer.from('<svg width="800" height="300"><text x="40" y="190" font-size="120" fill="black">标题</text></svg>')}]).png().toBuffer();
  const result=await resizePreservingContent(source,365,109);
  const meta=await sharp(result.bytes).metadata();
  assert.equal(result.method,'background-crop');
  assert.deepEqual([meta.width,meta.height],[365,109]);
  assert.equal(result.sourceWidth,800);assert.equal(result.sourceHeight,300);
});

test('wide banner resize crops detected outer margins instead of adding contain whitespace',async()=>{
  const source=await sharp({create:{width:1916,height:821,channels:3,background:'#ffffff'}}).composite([
    {input:Buffer.from('<svg width="1916" height="821"><rect x="430" y="230" width="1056" height="360" fill="#ed101a"/><text x="520" y="430" font-size="120" fill="white">18元一碗</text></svg>')},
  ]).png().toBuffer();
  const result=await resizePreservingContent(source,2390,560);
  const meta=await sharp(result.bytes).metadata();
  assert.equal(result.method,'background-crop');
  assert.deepEqual([meta.width,meta.height],[2390,560]);
  assert.ok(result.crop.width<1916,'crop should remove the outer white canvas');
  const {data,info}=await sharp(result.bytes).removeAlpha().raw().toBuffer({resolveWithObject:true});
  const corner=[...data.subarray(0,3)];
  assert.ok(corner[0]>180&&corner[1]<80&&corner[2]<80,'detected red artwork should fill the banner background');
});
