import test from 'node:test';
import assert from 'node:assert/strict';
import {DesignHistory} from '../shared/design-history.js';
import {transformBox,alignBox,textSignature} from '../shared/design-geometry.js';
import {changePages} from '../shared/design-pages.js';
import {createDocument,documentSchema} from '../server/design/document.js';
import {layoutDocument,editorTextLayers,renderPreview} from '../server/design/render.js';
import sharp from 'sharp';

function states(){
  const document=createDocument({width:100,height:160,unit:'mm'});document.content=[{id:'field',label:'标题',value:'原始文字',status:'confirmed'}];
  const p=document.pages[0];p.objects=[{id:'text',type:'text',x:10,y:20,width:70,height:20,text:'原始文字',fontSize:12,lineHeight:1.35,color:'#000000',align:'left',bindingId:'field'}];
  return {document,pageId:p.id,selected:'text'};
}

test('history groups input, retains whole-book bindings and selection, ignores no-ops and invalidates redo after a new edit',()=>{
  const history=new DesignHistory(),a=states(),b=structuredClone(a),c=structuredClone(a);
  b.document.title='输入一';c.document.title='输入二';history.record(a,b,'title');history.record(b,c,'title');
  a.document.title='caller mutated';const old=history.undo(c);assert.equal(old.document.title,'未命名设计稿');assert.equal(history.canUndo,false);
  assert.deepEqual(history.redo(old),c);assert.equal(history.canRedo,false);
  history.endGroup();const next=structuredClone(c);next.document.content[0].value='新内容';next.document.pages[0].objects[0].text='新内容';history.record(c,next,'content');
  assert.equal(history.record(next,structuredClone(next),'content'),false);assert.deepEqual(history.undo(next),c);
  const branch=structuredClone(c);branch.document.title='新分支';history.record(c,branch);assert.equal(history.canRedo,false);assert.deepEqual(history.undo(branch),c);
});

test('page deletion/duplication history restores exact IDs, exclusive content and active page',()=>{
  const history=new DesignHistory(),a=states(),copy=changePages(a.document,{type:'duplicate',pageId:a.pageId}),b={document:copy.document,pageId:copy.selectedId,selected:null};
  history.record(a,b);const deleted=changePages(b.document,{type:'delete',pageId:b.pageId}),c={document:deleted.document,pageId:deleted.selectedId,selected:null};history.record(b,c);
  assert.equal(c.document.content.length,1);assert.deepEqual(history.undo(c),b);assert.equal(b.document.content.length,2);assert.deepEqual(history.undo(b),a);
  assert.deepEqual(history.redo(a),b);assert.deepEqual(history.redo(b),c);documentSchema.parse(b.document);
  history.clear();assert.equal(history.canUndo,false);assert.equal(history.canRedo,false);
});

test('history bounds count and serialized memory without retaining caller mutations',()=>{
  const history=new DesignHistory({limit:2}),a=states();let before=a;
  for(let n=0;n<4;n++){const next=structuredClone(before);next.document.title=String(n);history.record(before,next);before=next;}
  const one=history.undo(before),two=history.undo(one);assert.equal(one.document.title,'2');assert.equal(two.document.title,'1');assert.equal(history.undo(two),null);
  const limited=new DesignHistory({maxBytes:1}),b=structuredClone(a);b.document.title='large';limited.record(a,b);assert.equal(limited.canUndo,false);
});

test('move/resize clamp to page bounds and snap in page units; alignment and aspect constraints remain valid',()=>{
  const o={id:'move',type:'rect',x:10,y:20,width:30,height:40,fill:'#000000'},p={id:'page',name:'页',width:100,height:120,unit:'mm',background:'#ffffff',objects:[o,{...o,id:'other',x:60,y:75,width:10,height:10}]};
  assert.deepEqual(transformBox(p,o,{dx:1000,dy:-1000}).box,{x:70,y:0,width:30,height:40});
  const snapped=transformBox(p,o,{dx:19,dy:14,snap:true,tolerance:1});assert.equal(snapped.box.x,30);assert.ok(snapped.guides.some(g=>g.axis==='x'&&g.value===60));
  assert.equal(transformBox(p,o,{dx:19,dy:14,snap:false,tolerance:5}).box.x,29);
  for(const handle of ['nw','ne','sw','se'])for(const [dx,dy] of [[-999,-999],[999,999],[12,-8]]){
    const box=transformBox(p,o,{dx,dy,handle}).box;assert.ok(box.x>=0&&box.y>=0&&box.width>=.25&&box.height>=.25);assert.ok(box.x+box.width<=100.00001&&box.y+box.height<=120.00001);
  }
  const ratio=transformBox(p,o,{dx:12,dy:16,handle:'se',keepAspect:true}).box;assert.ok(Math.abs(ratio.width/ratio.height-.75)<.000001);
  assert.equal(alignBox(p,o,'center').x,35);assert.equal(alignBox(p,o,'bottom').y,80);assert.equal(alignBox(p,{...o,width:200},'right').x,0);
  assert.deepEqual(o,{id:'move',type:'rect',x:10,y:20,width:30,height:40,fill:'#000000'});
});

test('editor glyph outlines use the same baselines/wrapping as export, support mm/px and do not contain user markup',async()=>{
  for(const unit of ['mm','px']){
    const document=createDocument({width:unit==='mm'?100:400,height:unit==='mm'?120:480,unit}),p=document.pages[0];
    p.objects=[{id:'text',type:'text',x:10,y:20,width:unit==='mm'?75:300,height:unit==='mm'?70:280,text:'中文设计 <script>\nSecond line',fontSize:12,lineHeight:1.35,color:'#7961cf',align:'center'}];
    const layout=await layoutDocument(document,()=>{}),before=structuredClone(document),layers=editorTextLayers(layout,p.id),o=layout.pages[0].objects[0],factor=unit==='mm'?72/25.4:.75;
    assert.equal(layers.objects[0].signature,textSignature(p.objects[0],unit));assert.equal(layers.objects[0].runs[0].y,(o.lines[0].baseline-o.y)/factor);
    assert.ok(layers.objects[0].runs.length>10);assert.ok(Object.values(layers.glyphs).every(d=>!d.includes('<')));assert.deepEqual(document,before);
    // Reconstruct the browser's vector layers and compare the visible pixels to
    // the renderer, rather than trusting only the placement data.
    const paths=layers.objects[0].runs.map(r=>`<path d="${layers.glyphs[r.glyph]}" transform="translate(${r.x} ${r.y}) scale(${r.scale} ${-r.scale})"/>`).join('');
    const width=unit==='mm'?p.width*96/25.4:p.width,height=unit==='mm'?p.height*96/25.4:p.height;
    const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(width)}" height="${Math.round(height)}" viewBox="0 0 ${p.width} ${p.height}"><rect width="100%" height="100%" fill="white"/><g fill="#7961cf" transform="translate(10 20)">${paths}</g></svg>`;
    const actual=await sharp(Buffer.from(svg)).removeAlpha().raw().toBuffer(),expected=await sharp((await renderPreview(layout)).bytes).removeAlpha().raw().toBuffer();
    assert.equal(actual.length,expected.length);let error=0;for(let i=0;i<actual.length;i++)error+=Math.abs(actual[i]-expected[i]);assert.ok(error/actual.length<.2,`pixel difference ${error/actual.length}`);
  }
});
