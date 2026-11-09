// Optional independent EPS/AI rendering check. Install @jspawn/ghostscript-wasm
// in a temporary directory and point GHOSTSCRIPT_WASM_DIR to that package.
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {vectorFixture} from '../tests/helpers/vector.mjs';
import {buildVectorScene,renderVector} from '../server/design/vector.js';

const dir=process.env.GHOSTSCRIPT_WASM_DIR;
if(!dir)throw new Error('Set GHOSTSCRIPT_WASM_DIR to the installed @jspawn/ghostscript-wasm directory.');
// This older Emscripten loader mistakes Node fetch for browser WASM loading.
// The validation process uses only its local filesystem loader.
globalThis.fetch=undefined;
const factory=createRequire(import.meta.url)(path.resolve(dir,'gs.js'));
const out=path.resolve(import.meta.dirname,'../test-results/vector');fs.mkdirSync(out,{recursive:true});
const f=await vectorFixture(),scene=await buildVectorScene(f.layout,{format:'svg',pageId:f.pageId}),svg=(await renderVector(scene,'svg')).bytes;
fs.writeFileSync(path.join(out,'logo.svg'),svg);
const expected=await sharp(svg).flatten({background:'white'}).removeAlpha().raw().toBuffer();
for(const format of ['eps','ai']){
  const result=await renderVector(scene,format),messages=[];
  const engine=await factory({noInitialRun:true,print:message=>messages.push(message),printErr:message=>messages.push(message)});
  engine.FS.writeFile('/logo.'+format,result.bytes);
  try{
    const code=engine.callMain(['-dSAFER','-dBATCH','-dNOPAUSE','-dEPSCrop','-sDEVICE=pngalpha','-r96','-sOutputFile=/render.png','/logo.'+format,'-c','showpage']);
    assert.equal(code,0,messages.join('\n'));
  }catch(error){if(error.status!==0)throw error;}
  const png=Buffer.from(engine.FS.readFile('/render.png')),{width,height}=await sharp(png).metadata();
  assert.equal(width,300);assert.equal(height,280);
  const actual=await sharp(png).flatten({background:'white'}).removeAlpha().raw().toBuffer();assert.equal(actual.length,expected.length);
  const difference=actual.reduce((sum,n,i)=>sum+Math.abs(n-expected[i]),0)/actual.length;
  assert.ok(difference<5,`${format}: independent PostScript render differs from SVG by ${difference}`);
  fs.writeFileSync(path.join(out,'logo.'+format),result.bytes);fs.writeFileSync(path.join(out,format+'-preview.png'),png);
  console.log(`PASS ${format}: Ghostscript rendered ${width}×${height}, mean channel difference ${difference.toFixed(3)}/255.`);
}
fs.writeFileSync(path.join(out,'logo-vector.pdf'),(await renderVector(scene,'pdf')).bytes);
