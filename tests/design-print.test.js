import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {PDFDocument,PDFName,PDFArray,PDFRawStream,decodePDFRawStream} from 'pdf-lib';
import {PrintProfiles,getDefaultPrintProfile,inspectIcc} from '../server/design/profiles.js';
import {printSettingsSchema,exportSettingsSchema,exportReport,assertExportReport} from '../server/design/export-settings.js';
import {layoutDocument,renderPdf,renderPreview} from '../server/design/render.js';
import {createDocument} from '../server/design/document.js';
import {designFixture} from './fixtures/design.mjs';
import {readPdfPages} from './helpers/pdf.mjs';

const print=printSettingsSchema.parse({bleedMm:2,cropMarks:true}),settings=exportSettingsSchema.parse({revision:1,format:'pdf',colorSpace:'cmyk',dpi:300,print});
const streams=pdf=>pdf.getPages().map(page=>{const data=page.node.Contents();return(data instanceof PDFArray?data.asArray().map(ref=>pdf.context.lookup(ref,PDFRawStream)):[data]).map(s=>Buffer.from(decodePDFRawStream(s).decode()).toString()).join('\n');});

test('ICC import validates actual CMYK conversion, deduplicates and persists without exposing local paths',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'canvas-print-profile-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const library=new PrintProfiles(root),original=await getDefaultPrintProfile(),p=await library.import(original.icc,{name:'印刷方配置',description:'本地印刷条件'});
  assert.equal(p.hash,original.hash);assert.equal(p.custom,true);assert.equal(JSON.stringify(p).includes(root),false);
  assert.equal((await library.list()).length,2);assert.equal((await library.import(original.icc,{name:'重复导入'})).id,p.id);
  assert.deepEqual((await new PrintProfiles(root).resolve(p.id)).icc,original.icc);
  await assert.rejects(library.resolve('../private'),/不存在/);
  const bad=Buffer.from(original.icc);bad.write('RGB ',16);assert.throws(()=>inspectIcc(bad),/CMYK/);
  const malformed=Buffer.from(original.icc);malformed.writeUInt32BE(malformed.length+1,0);assert.throws(()=>inspectIcc(malformed),/无效/);
  const directory=Buffer.from(original.icc);directory.writeUInt32BE(0xffffffff,136);assert.throws(()=>inspectIcc(directory),/标签/);
  const corrupt=Buffer.from(original.icc);for(let i=0;i<corrupt.readUInt32BE(128);i++){const offset=132+i*12;if(corrupt.subarray(offset,offset+4).toString().startsWith('B2A'))corrupt.fill(0,corrupt.readUInt32BE(offset+4),corrupt.readUInt32BE(offset+4)+corrupt.readUInt32BE(offset+8));}
  await assert.rejects(library.import(corrupt,{name:'损坏的转换表'}),/无法完成/);
  const fake=Buffer.alloc(132);fake.writeUInt32BE(132,0);fake.write('prtr',12);fake.write('CMYK',16);fake.write('Lab ',20);fake.write('acsp',36);
  await assert.rejects(library.import(fake,{name:'伪造配置'}),/无法完成|转换标签/);assert.equal((await library.list()).length,2);
});

test('print PDF has mixed-size trim/bleed/media boxes, CMYK marks, real ICC and embedded Chinese text',async()=>{
  const f=await designFixture();f.document.pages.push({id:'px-page',name:'像素页面',width:640,height:360,unit:'px',background:'#f1eee7',objects:[]});
  const layout=await layoutDocument(f.document,f.resolveAsset),result=await renderPdf(layout,{...settings,profile:await getDefaultPrintProfile()});
  assert.equal(result.verification.passed,true);assert.equal(result.verification.pages,2);assert.equal(result.pdfX,false);
  const pdf=await PDFDocument.load(result.bytes),mm=n=>n*72/25.4;
  for(const [i,p] of pdf.getPages().entries()){
    const source=layout.pages[i],trim=p.getTrimBox(),bleed=p.getBleedBox();
    assert.ok(Math.abs(trim.x-mm(10))<.001);assert.ok(Math.abs(trim.width-source.width)<.001);assert.ok(Math.abs(p.getWidth()-source.width-mm(20))<.001);
    assert.ok(Math.abs(bleed.x-mm(8))<.001);assert.ok(Math.abs(bleed.width-source.width-mm(4))<.001);
  }
  const text=await readPdfPages(result.bytes);assert.match(text[0],/让好想法/);
  assert.doesNotMatch(streams(pdf).join('\n'),/\s(?:rg|RG)\s/);assert.match(streams(pdf)[0],/0 0 0 1 [kK]/);
});

test('black text strategy changes actual operators; marks remain K100 and pixels are downsampled without enlargement',async()=>{
  const f=await designFixture(),layout=await layoutDocument(f.document,f.resolveAsset);
  const preserved=await renderPdf(layout,{colorSpace:'cmyk',dpi:72,print:{...print,cropMarks:false,blackText:'preserve'}}),converted=await renderPdf(layout,{colorSpace:'cmyk',dpi:72,print:{...print,cropMarks:false,blackText:'convert'}});
  assert.match(streams(await PDFDocument.load(preserved.bytes))[0],/0 0 0 1 k/);assert.doesNotMatch(streams(await PDFDocument.load(converted.bytes))[0],/0 0 0 1 k/);
  const pdf=await PDFDocument.load(preserved.bytes);let imageCount=0;
  for(const [,value] of pdf.context.enumerateIndirectObjects())if(value instanceof PDFRawStream&&value.dict.get(PDFName.of('Subtype'))?.toString()==='/Image'&&value.dict.lookup(PDFName.of('ColorSpace')) instanceof PDFArray){
    imageCount++;assert.ok(value.dict.lookup(PDFName.of('Width')).asNumber()<=Math.ceil(152*72/25.4));
  }
  assert.equal(imageCount,2);
  const document=createDocument({width:160,height:100,unit:'mm'}),id='29620075-5cf3-4faa-9c7a-aed51acb2a5b';document.pages[0].objects.push({id:'low',type:'image',assetId:id,x:0,y:0,width:160,height:100,fit:'contain'});
  const low=await layoutDocument(document,()=>sharp({create:{width:80,height:50,channels:3,background:'#f00'}}).png().toBuffer()),bytes=(await renderPdf(low,{colorSpace:'cmyk',dpi:600,print})).bytes,lowPdf=await PDFDocument.load(bytes);
  for(const [,value] of lowPdf.context.enumerateIndirectObjects())if(value instanceof PDFRawStream&&value.dict.get(PDFName.of('Subtype'))?.toString()==='/Image')assert.equal(value.dict.lookup(PDFName.of('Width')).asNumber(),80);
});

test('print checks selected pages, adjustable resolution, edge content, warnings and bitmap limits',async()=>{
  const f=await designFixture();f.document.pages[0].objects.find(o=>o.id==='photo').x=0;
  const layout=await layoutDocument(f.document,f.resolveAsset),profile=await getDefaultPrintProfile(),report=exportReport(layout,settings,{revision:1,profile});
  assert.ok(report.issues.some(i=>i.code==='low_resolution'));assert.ok(report.issues.some(i=>i.code==='bleed_background_only'));assert.ok(report.issues.some(i=>i.code==='proof_profile'));
  assert.equal(report.canExport,true);assert.throws(()=>assertExportReport(report,settings),/确认/);assert.doesNotThrow(()=>assertExportReport(report,{...settings,acknowledgeWarnings:true}));
  const lower=exportReport(layout,{...settings,dpi:72},{revision:1,profile});assert.ok(lower.warnings<report.warnings);
  const huge=createDocument({width:19000,height:10000}),hugeLayout=await layoutDocument(huge,()=>{});
  assert.equal(exportReport(hugeLayout,exportSettingsSchema.parse({revision:1,format:'png',scale:4})).canExport,false);
  assert.throws(()=>exportReport(layout,{...settings,format:'png'}),/RGB|PDF/);
  assert.throws(()=>exportReport(layout,{...settings,pageIds:['missing']}),/不存在/);
  const image=await renderPreview(await layoutDocument(createDocument({width:25.4,height:50.8,unit:'mm'}),()=>{}),{dpi:600});assert.equal(image.width,600);assert.equal(image.height,1200);assert.equal((await sharp(image.bytes).metadata()).density,600);
});

const alternatePath=process.env.TEST_CMYK_PROFILE||'/System/Library/ColorSync/Profiles/Generic CMYK Profile.icc';
test('a distinct printer ICC changes actual vector conversion and survives output verification',{skip:!fs.existsSync(alternatePath)},async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'canvas-alternate-icc-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const library=new PrintProfiles(root),imported=await library.import(fs.readFileSync(alternatePath),{name:'不同的印刷输出条件'}),profile=await library.resolve(imported.id),f=await designFixture(),layout=await layoutDocument(f.document,f.resolveAsset);
  assert.notEqual(profile.hash,(await getDefaultPrintProfile()).hash);
  const custom=await renderPdf(layout,{...settings,profile}),builtin=await renderPdf(layout,settings);
  assert.equal(custom.verification.passed,true);assert.notDeepEqual(streams(await PDFDocument.load(custom.bytes)),streams(await PDFDocument.load(builtin.bytes)));
});
