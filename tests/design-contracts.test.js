import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {createApp} from '../server/app.js';
import {PDFDocument} from 'pdf-lib';
const root=path.resolve(import.meta.dirname,'..');

async function fixture(t){
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'canvas-design-api-'));
  const instance=createApp({root,dataDir,demo:true,maxImages:2,agentModel:'test',imageModel:'test',sandboxMode:'off'});
  const server=await new Promise((resolve,reject)=>{const s=instance.app.listen(0,'127.0.0.1');s.once('listening',()=>resolve(s));s.once('error',reject);});
  t.after(()=>{instance.shutdown();server.closeAllConnections();server.close();fs.rmSync(dataDir,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}`,config=await(await fetch(base+'/api/config')).json();
  const request=async(url,method='GET',body,token=config.token)=>fetch(base+url,{method,headers:{'Content-Type':'application/json','X-Studio-Token':token},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const session=instance.store.create();return {...instance,base,request,session,url:`/api/sessions/${session.id}/design`};
}

test('design API persists edits and snapshots independently of attachments and PNG versions',async t=>{
  const f=await fixture(t);
  assert.equal((await(await f.request(f.url)).json()).design,null);
  let data=await(await f.request(f.url,'POST',{title:'通用海报',width:640,height:960,unit:'px'})).json();
  const document=data.design.document,p=document.pages[0];p.objects.push({id:'t',type:'text',x:30,y:30,width:580,height:100,fontSize:24,color:'#292a31',text:'设计平台'});
  assert.equal((await f.request(f.url,'PUT',{revision:1,document},'')).status,403);
  assert.equal((await f.request(f.url,'PUT',{revision:1,document})).status,200);
  assert.equal((await f.request(f.url,'PUT',{revision:1,document})).status,409);
  data=await(await f.request(f.url+'/versions','POST',{revision:2,label:'确认版'})).json();
  assert.equal(data.design.versions.length,1);assert.equal(data.design.versions[0].document,undefined);
  const preview=await f.request(f.url+'/preview?revision=3');assert.equal(preview.status,200);assert.equal((await sharp(Buffer.from(await preview.arrayBuffer())).metadata()).width,640);
  const json=await(await f.request(f.url+'/preflight')).json();assert.equal(json.issues.length,0);
  const pdf=await f.request(f.url+'/export','POST',{revision:3,format:'pdf',colorSpace:'cmyk'});assert.equal(pdf.status,200);assert.equal(pdf.headers.get('content-type'),'application/pdf');
  assert.match(pdf.headers.get('content-disposition'),/filename\*=UTF-8/);
  assert.equal((await PDFDocument.load(await pdf.arrayBuffer())).getPage(0).getWidth(),480);
  assert.equal((await f.request(f.url+'/export','POST',{revision:3,format:'png',colorSpace:'cmyk'})).status,400);
  assert.equal((await f.request(f.url+'/export','POST',{revision:3,format:'pdfx4'})).status,400);
  assert.equal((await f.request(f.url+'/export','POST',{revision:2,format:'pdf'})).status,409);
  assert.equal(f.session.versions.length,0);assert.deepEqual(f.session.referenceIds,[]);
  const versionId=data.design.versions[0].id;document.title='修改标题';
  assert.equal((await f.request(f.url,'PUT',{revision:3,document})).status,200);
  const restored=await(await f.request(f.url+'/restore','POST',{revision:4,versionId})).json();assert.equal(restored.design.document.title,'通用海报');
});

test('design API rejects cross-session images, missing pages, overflow and malformed objects',async t=>{
  const f=await fixture(t),other=f.store.create(),bytes=await sharp({create:{width:50,height:50,channels:3,background:'#abc'}}).png().toBuffer();
  const foreign=f.store.addImage(other,bytes,{kind:'upload',demo:false});
  let data=await(await f.request(f.url,'POST',{width:150,height:200,unit:'mm'})).json(),document=data.design.document;
  document.pages[0].objects=[{id:'img',type:'image',assetId:foreign.id,x:1,y:1,width:20,height:20}];
  assert.equal((await f.request(f.url,'PUT',{revision:1,document})).status,400);
  document.pages[0].objects=[{id:'t',type:'text',x:1,y:1,width:20,height:1,text:'溢出文字',fontSize:30,color:'#000000'}];
  assert.equal((await f.request(f.url,'PUT',{revision:1,document})).status,200);
  assert.equal((await f.request(f.url+'/export','POST',{revision:2,format:'pdf'})).status,422);
  assert.equal((await f.request(f.url+'/preview?pageId=missing')).status,404);
  assert.equal((await f.request(f.url+'/preview?revision=1')).status,409);
  assert.equal((await f.request(f.url,'POST',{})).status,409);
  assert.equal((await f.request(`/api/sessions/${other.id}/design/restore`,'POST',{revision:1,versionId:data.design.id})).status,404);
});

test('workspace downloads current images in RGB/CMYK without changing documents or image history',async t=>{
  const f=await fixture(t),bytes=await sharp({create:{width:240,height:360,channels:4,background:'#7961cf80'}}).png().toBuffer();
  const image=f.store.addImage(f.session,bytes,{kind:'generated',demo:false,width:240,height:360,label:'当前作品'});
  const before=JSON.stringify(f.session),url=f.url+'/export-image';
  const png=await f.request(url,'POST',{imageId:image.id,format:'png'});
  assert.equal(png.status,200);assert.deepEqual(Buffer.from(await png.arrayBuffer()),bytes,'native PNG keeps source bytes');
  const jpg=await f.request(url,'POST',{imageId:image.id,format:'jpeg',scale:2});
  assert.equal(jpg.status,200);assert.equal((await sharp(Buffer.from(await jpg.arrayBuffer())).metadata()).width,480);
  for(const colorSpace of ['rgb','cmyk']){
    const pdf=await f.request(url,'POST',{imageId:image.id,format:'pdf',colorSpace,width:160,height:230,unit:'mm'});
    assert.equal(pdf.status,200);assert.equal(pdf.headers.get('content-type'),'application/pdf');
    assert.equal(pdf.headers.get('x-image-source'),image.id);assert.equal(pdf.headers.get('x-design-color-space'),colorSpace);
    const page=(await PDFDocument.load(await pdf.arrayBuffer())).getPage(0);
    assert.ok(Math.abs(page.getWidth()-160*72/25.4)<.001);assert.ok(Math.abs(page.getHeight()-230*72/25.4)<.001);
  }
  assert.equal((await f.request(url,'POST',{imageId:image.id,format:'png',colorSpace:'cmyk'})).status,400);
  assert.equal((await f.request(url,'POST',{imageId:image.id,format:'pdf'},'')).status,403);
  assert.equal(f.documents.get(f.session.id),null);assert.equal(JSON.stringify(f.session),before);
  const other=f.store.create(),foreign=f.store.addImage(other,bytes,{kind:'upload',demo:false});
  assert.equal((await f.request(url,'POST',{imageId:foreign.id,format:'pdf'})).status,404);
  const demo=f.store.addImage(f.session,bytes,{kind:'generated',demo:true});
  assert.equal((await f.request(url,'POST',{imageId:demo.id,format:'pdf'})).status,400);
});

test('workspace source import creates one image object and preserves existing designs and references',async t=>{
  const f=await fixture(t),bytes=await sharp({create:{width:640,height:960,channels:3,background:'#abc'}}).png().toBuffer();
  const image=f.store.addImage(f.session,bytes,{kind:'upload',demo:false,width:640,height:960}),before=JSON.stringify(f.session);
  const other=f.store.create(),foreign=f.store.addImage(other,bytes,{kind:'upload',demo:false});
  assert.equal((await f.request(f.url,'POST',{sourceId:foreign.id})).status,404);assert.equal(f.documents.get(f.session.id),null);
  const imported=await f.request(f.url,'POST',{sourceId:image.id,title:'从当前作品开始',width:150,height:210,unit:'mm'});
  assert.equal(imported.status,201);
  const data=await imported.json(),p=data.design.document.pages[0];
  assert.equal(p.width,150);assert.equal(p.height,210);assert.equal(p.unit,'mm');assert.equal(data.design.revision,1);
  assert.equal(p.objects.length,1);assert.equal(p.objects[0].assetId,image.id);assert.equal(p.objects[0].fit,'contain');
  assert.equal(p.objects[0].width,p.width);assert.equal(p.objects[0].height,p.height);
  assert.equal((await f.request(f.url,'POST',{sourceId:image.id})).status,409);
  assert.equal(f.documents.require(f.session.id).document.title,'从当前作品开始');assert.equal(JSON.stringify(f.session),before);
});

test('editor draft text is read-only, checks revision/assets and renders uncommitted pages without saving',async t=>{
  const f=await fixture(t),created=await(await f.request(f.url,'POST',{width:120,height:160,unit:'mm'})).json(),before=structuredClone(f.documents.require(f.session.id)),document=structuredClone(created.design.document);
  const p={...structuredClone(document.pages[0]),id:'local-page',objects:[{id:'local-text',type:'text',x:10,y:20,width:80,height:30,text:'未保存的草稿',fontSize:18,lineHeight:1.35,color:'#000000',align:'left'}]};document.pages.push(p);
  const body={revision:1,pageId:p.id,document};assert.equal((await f.request(f.url+'/editor-text','POST',body,'')).status,403);
  const response=await f.request(f.url+'/editor-text','POST',body);assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
  const layers=await response.json();assert.equal(layers.pageId,p.id);assert.equal(layers.revision,1);assert.ok(layers.objects[0].runs.length>0);assert.equal(layers.objects[0].id,'local-text');
  assert.equal((await f.request(f.url+'/editor-text','POST',{...body,revision:2})).status,409);assert.equal((await f.request(f.url+'/editor-text','POST',{...body,pageId:'missing'})).status,404);
  const invalid=structuredClone(body);invalid.document.pages[1].objects.push({id:'foreign',type:'image',assetId:'29620075-5cf3-4faa-9c7a-aed51acb2a5b',x:0,y:0,width:10,height:10,fit:'contain'});
  assert.equal((await f.request(f.url+'/editor-text','POST',invalid)).status,400);
  const overflow=structuredClone(body);overflow.document.pages[1].objects[0].height=.1;
  const broken=await(await f.request(f.url+'/editor-text','POST',overflow)).json();assert.ok(broken.issues.some(i=>i.code==='text_overflow'));assert.ok(broken.objects[0].runs.length>0);
  assert.deepEqual(f.documents.require(f.session.id),before);assert.equal(f.session.versions.length,0);
});
