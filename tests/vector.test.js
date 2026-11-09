import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {PDFDocument,PDFName,PDFRawStream} from 'pdf-lib';
import {normalizePath,buildVectorScene,renderVector,sceneSvg,vectorPreview} from '../server/design/vector.js';
import {exportSettingsSchema,validateExportSettings,exportReport,assertExportReport} from '../server/design/export-settings.js';
import {layoutDocument,renderPreview} from '../server/design/render.js';
import {vectorFixture} from './helpers/vector.mjs';
import {readAndRenderPdf} from './helpers/pdf.mjs';

async function rgba(bytes){return sharp(bytes).ensureAlpha().raw().toBuffer({resolveWithObject:true});}
async function difference(a,b){const x=await sharp(a).flatten({background:'white'}).removeAlpha().raw().toBuffer(),y=await sharp(b).flatten({background:'white'}).removeAlpha().raw().toBuffer();assert.equal(x.length,y.length);return x.reduce((sum,n,i)=>sum+Math.abs(n-y[i]),0)/x.length;}

test('color tracing produces real paths, preserves transparent holes and white foreground, and stays visually close',async()=>{
  const f=await vectorFixture({text:false}),scene=await buildVectorScene(f.layout,{format:'svg',pageId:f.pageId}),svg=sceneSvg(scene);
  assert.doesNotMatch(svg,/<image|<text|data:image|base64|<script/);assert.match(svg,/<path/);assert.match(svg,/<title>小菜 Logo &lt;&amp;&gt;<\/title>/);
  const output=await rgba(Buffer.from(svg)),pixel=(x,y)=>[...output.data.subarray((y*output.info.width+x)*4,(y*output.info.width+x)*4+4)];
  assert.equal(output.info.width,300);assert.equal(output.info.height,280);
  assert.equal(pixel(5,5)[3],0);assert.equal(pixel(79,85)[3],0,'ring center must remain transparent');
  const white=pixel(164,104);assert.equal(white[3],255);assert.ok(white.slice(0,3).every(n=>n>=245),'white eye detail must survive palette approximation');
  const png=await sharp(Buffer.from(svg)).png().toBuffer(),original=await renderPreview(f.layout,{pageId:f.pageId});
  assert.ok(await difference(png,original.bytes)<12,'traced artwork should remain close to the source');
  assert.ok(scene.pathCount>2);assert.equal(scene.imageCount,1);
});

test('SVG, outlined PDF, EPS and legacy AI share paths; PDF contains no images or font dependencies',async()=>{
  const f=await vectorFixture(),scene=await buildVectorScene(f.layout,{format:'svg',pageId:f.pageId}),svg=await renderVector(scene,'svg'),eps=await renderVector(scene,'eps'),ai=await renderVector(scene,'ai'),pdf=await renderVector(scene,'pdf');
  assert.doesNotMatch(svg.bytes.toString(),/<text|<image/);assert.ok(scene.groups.find(g=>g.id==='brand').paths.length>=4);
  for(const bytes of [eps.bytes,ai.bytes]){assert.match(bytes.toString(),/^%!PS-Adobe-3\.0 EPSF-3\.0/);assert.doesNotMatch(bytes.toString(),/colorimage|\/ImageType|base64|<image|%PDF/);assert.ok([...bytes].every(n=>n<128));assert.match(bytes.toString(),/%%BoundingBox: 0 0 225 210/);}
  assert.match(eps.bytes.toString(),/curveto/);assert.match(ai.bytes.toString(),/%AI5_FileFormat 3.0/);assert.match(ai.bytes.toString(),/\*u\n/);assert.match(ai.bytes.toString(),/\nf\n\*U/);
  const document=await PDFDocument.load(pdf.bytes);assert.equal(document.getPageCount(),1);
  for(const [,object] of document.context.enumerateIndirectObjects())if(object instanceof PDFRawStream)assert.notEqual(object.dict.get(PDFName.of('Subtype'))?.toString(),'/Image');
  assert.equal(document.getPage(0).node.Resources().lookup(PDFName.of('Font'))?.keys().length||0,0);
  const rendered=await readAndRenderPdf(pdf.bytes),png=await sharp(svg.bytes).png().toBuffer();
  assert.equal(rendered.text,'');assert.ok(await difference(png,rendered.png)<3,'independent PDF renderer should match SVG output');
  const preview=await vectorPreview(scene);assert.match(preview.dataUrl,/^data:image\/png;base64,/);assert.equal(preview.pageId,f.pageId);
});

test('vector output clips cover images, respects hidden objects, and does not mutate the source document',async()=>{
  const f=await vectorFixture({text:false,fit:'cover'});f.document.pages[0].objects[0].width=100;
  f.document.pages[0].objects.push({id:'hidden',type:'rect',x:0,y:0,width:10,height:10,fill:'#ff0000',hidden:true});
  const before=JSON.stringify(f.document),layout=await layoutDocument(f.document,()=>f.bytes),scene=await buildVectorScene(layout,{format:'svg',pageId:f.pageId}),svg=sceneSvg(scene),{data,info}=await rgba(Buffer.from(svg));
  assert.match(svg,/clip-path/);assert.ok(!scene.groups.some(g=>g.id==='hidden'));
  for(let y=0;y<info.height;y++)for(let x=121;x<info.width;x++)assert.equal(data[(y*info.width+x)*4+3],0,'cover image must not leak outside its frame');
  assert.equal(JSON.stringify(f.document),before);
});

test('vector settings reject invalid combinations, require preview acknowledgment and report approximation',async()=>{
  const f=await vectorFixture(),body=exportSettingsSchema.parse({revision:1,format:'svg',pageId:f.pageId}),report=exportReport(f.layout,body);
  assert.ok(report.issues.some(i=>i.code==='vector_approximation'));assert.ok(!report.issues.some(i=>i.code==='low_resolution'));
  assert.throws(()=>assertExportReport(report,body),/预览/);assert.doesNotThrow(()=>assertExportReport(report,{...body,acknowledgeWarnings:true}));
  for(const invalid of [{colorSpace:'cmyk'},{dpi:300},{scale:2},{vectorize:true},{print:{}}])assert.throws(()=>validateExportSettings({...body,...invalid}));
  f.layout.pages.push({...f.layout.pages[0],id:'second'});await assert.rejects(buildVectorScene(f.layout,{...body,pageId:undefined}),/指定页面|一页/);
});

test('path conversion handles quadratic curves, shorthand, relative segments and arcs without rasterization',()=>{
  const d=normalizePath('M0 0h20v10q5 5 10 0t10 0a5 5 0 0 1 5 5z','translate(5 7) scale(2)').segments;
  assert.ok(d.every(s=>['M','L','C','Z'].includes(s[0])));assert.ok(d.some(s=>s[0]==='C'));assert.deepEqual(d[0],['M',5,7]);
  assert.throws(()=>normalizePath('MNaN 2'),/路径/);
});
