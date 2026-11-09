'use client';

import {useEffect,useRef,useState,type PointerEvent as ReactPointerEvent} from 'react';
import type {WorkspaceState} from '@/lib/use-workspace';
import type {DesignObject,EditorTextLayers} from '@/lib/types';
import {textSignature,transformBox,type Guide,type ObjectBox,type Alignment} from '@/shared/design-geometry.js';

export function DesignCanvas({w,zoom,onSelect,onInspect}:{w:WorkspaceState;zoom:number;onSelect:()=>void;onInspect:()=>void}){
  const page=w.activePage!,stage=useRef<HTMLDivElement>(null),svg=useRef<SVGSVGElement>(null),latest=useRef(w);latest.current=w;
  const [size,setSize]=useState({width:600,height:500}),[layers,setLayers]=useState<EditorTextLayers|null>(null),[error,setError]=useState(''),[retry,setRetry]=useState(0),[snap,setSnap]=useState(true);
  const [draft,setDraft]=useState<{id:string;box:ObjectBox;guides:Guide[]}|null>(null);
  const gesture=useRef<{pointer:number;id:string;handle:string;object:DesignObject;start:{x:number;y:number};document:WorkspaceState['document'];box?:ObjectBox}|null>(null);
  const signatures=JSON.stringify([w.session?.id,w.data.design?.revision,page.id,page.unit,page.objects.filter(o=>o.type==='text').filter(o=>!o.hidden).map(o=>[o.id,textSignature(o,page.unit)])]);
  useEffect(()=>{
    const element=stage.current!;const observer=new ResizeObserver(([entry])=>setSize({width:entry.contentRect.width,height:entry.contentRect.height}));observer.observe(element);return()=>observer.disconnect();
  },[]);
  useEffect(()=>{
    const controller=new AbortController(),c=latest.current;setError('');
    const timer=setTimeout(()=>c.api<EditorTextLayers>(c.endpoint('/editor-text'),'POST',{revision:c.data.design!.revision,pageId:c.activePage!.id,document:c.document},controller.signal).then(value=>{if(!controller.signal.aborted)setLayers(value);}).catch(e=>{if(!controller.signal.aborted)setError(e.message);}),160);
    return()=>{clearTimeout(timer);controller.abort();};
  },[signatures,retry,w.api]);
  useEffect(()=>{
    if(gesture.current&&(w.locked||gesture.current.document!==w.document)){gesture.current=null;setDraft(null);}
  },[w.locked,w.document]);
  const scale=Math.max(.01,Math.min(Math.max(100,size.width-64)/page.width,Math.max(200,size.height-64)/page.height))*zoom;
  const selected=page.objects.find(o=>o.id===w.selected),selection=selected&&!selected.hidden?draft?.id===selected.id?{...selected,...draft.box}:selected:null;
  function point(event:ReactPointerEvent<SVGSVGElement>){
    const matrix=svg.current?.getScreenCTM();if(!matrix)return {x:0,y:0};const p=new DOMPoint(event.clientX,event.clientY).matrixTransform(matrix.inverse());return {x:p.x,y:p.y};
  }
  function start(event:ReactPointerEvent<SVGSVGElement>){
    if(event.button!==0||!event.isPrimary||w.locked)return;
    const target=(event.target as Element).closest('[data-canvas-object]'),id=target?.getAttribute('data-canvas-object'),object=page.objects.find(o=>o.id===id);
    w.endEdit();svg.current?.focus({preventScroll:true});
    if(!object){w.setSelected(null);return;}
    if(object.locked||object.hidden)return;
    event.preventDefault();w.setSelected(object.id);onSelect();
    const handle=(event.target as Element).getAttribute('data-handle')||'move';
    gesture.current={pointer:event.pointerId,id:object.id,handle,object:structuredClone(object),start:point(event),document:w.document};
    svg.current?.setPointerCapture(event.pointerId);
  }
  function move(event:ReactPointerEvent<SVGSVGElement>){
    const g=gesture.current;if(!g||g.pointer!==event.pointerId)return;
    const p=point(event);if(!g.box&&Math.hypot(p.x-g.start.x,p.y-g.start.y)*scale<2)return;
    const result=transformBox(page,g.object,{dx:p.x-g.start.x,dy:p.y-g.start.y,handle:g.handle,keepAspect:event.shiftKey,snap:snap&&!event.altKey,tolerance:6/scale});g.box=result.box;
    setDraft({id:g.id,...result});
  }
  function finish(event:ReactPointerEvent<SVGSVGElement>,cancel=false){
    const g=gesture.current;if(!g||g.pointer!==event.pointerId)return;
    gesture.current=null;
    if(!cancel&&g.document===latest.current.document&&g.box)w.changeBox(g.id,g.box);
    setDraft(null);if(svg.current?.hasPointerCapture(event.pointerId))svg.current.releasePointerCapture(event.pointerId);
  }
  const pending=page.objects.some(o=>o.type==='text'&&!o.hidden&&!layers?.objects.some(t=>t.id===o.id&&t.signature===textSignature(o,page.unit)));
  return <>
    <div className="editor-tools"><div className="editor-selection"><span>{selected?`已选中${selected.type==='text'?'文字':selected.type==='image'?'图片':'色块'}`:'点击对象直接编辑'}</span>{selected&&<button id="editObjectProperties" className="btn small" disabled={w.locked} onClick={onInspect}>编辑属性 <span aria-hidden="true">↗</span></button>}</div><label><input id="canvasSnap" type="checkbox" checked={snap} onChange={e=>setSnap(e.target.checked)}/>吸附</label><select aria-label="对齐到画布" value="" disabled={w.locked||!selected||!!selected.locked||!!selected.hidden} onChange={e=>{w.alignSelected(e.target.value as Alignment);svg.current?.focus({preventScroll:true});}}><option value="" disabled>对齐到画布</option>{([['left','左对齐'],['center','水平居中'],['right','右对齐'],['top','顶部对齐'],['middle','垂直居中'],['bottom','底部对齐']] as const).map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></div>
    <div ref={stage} className="editor-stage"><div className="editor-scroll" style={{width:Math.max(size.width,page.width*scale+64),height:Math.max(size.height,page.height*scale+64)}}>
      <svg ref={svg} id="designCanvas" className={`design-canvas ${page.background==='transparent'?'transparency-preview':''}`}  width={page.width*scale} height={page.height*scale} viewBox={`0 0 ${page.width} ${page.height}`} role="group" aria-label="可直接编辑的设计画布" tabIndex={0} data-page-id={page.id} data-ready={!pending&&!error} onPointerDown={start} onPointerMove={move} onPointerUp={e=>finish(e)} onPointerCancel={e=>finish(e,true)} onLostPointerCapture={()=>{gesture.current=null;setDraft(null);}} onKeyDown={e=>{
        if(e.key==='Escape'){gesture.current=null;setDraft(null);w.setSelected(null);e.preventDefault();}
        if(!w.locked&&!gesture.current&&(e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='d'&&selected){e.preventDefault();w.objectOperation({type:'duplicate'});return;}
        if(w.locked||gesture.current||e.metaKey||e.ctrlKey||e.altKey)return;
        const directions:Record<string,[number,number]>={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]};
        if(directions[e.key]&&selected){e.preventDefault();const [dx,dy]=directions[e.key],step=(page.unit==='mm'?.25:1)*(e.shiftKey?10:1);w.nudgeSelected(dx*step,dy*step);}
        if((e.key==='Delete'||e.key==='Backspace')&&selected){e.preventDefault();w.deleteSelected();}
      }} onKeyUp={e=>{if(e.key.startsWith('Arrow'))w.endEdit();}} onBlur={w.endEdit}>
        <rect width={page.width} height={page.height} fill={page.background==='transparent'?'none':page.background}/>
        <svg width={page.width} height={page.height} viewBox={`0 0 ${page.width} ${page.height}`} overflow="hidden">
          {page.objects.filter(o=>!o.hidden).map(original=>{
            const o=draft?.id===original.id?{...original,...draft.box}:original;
            const text=o.type==='text'?layers?.objects.find(t=>t.id===o.id&&t.signature===textSignature(original as typeof o,page.unit)):null;
            return <g key={o.id} data-canvas-object={o.id} transform={`translate(${o.x} ${o.y})`} pointerEvents={o.locked?'none':undefined} className={w.locked||o.locked?'locked':'editable'}>
              <rect width={o.width} height={o.height} fill="transparent"/>
              {o.type==='rect'&&<rect width={o.width} height={o.height} fill={o.fill} pointerEvents="none"/>}
              {o.type==='image'&&<svg width={o.width} height={o.height} overflow="hidden" pointerEvents="none"><image href={w.data.assets.find(a=>a.id===o.assetId)?.url} width={o.width} height={o.height} preserveAspectRatio={`xMidYMid ${o.fit==='cover'?'slice':'meet'}`}/></svg>}
              {o.type==='text'&&text&&<g pointerEvents="none" fill={o.color}>{text.runs.map((run,i)=><path key={i} d={layers!.glyphs[run.glyph]} transform={`translate(${run.x} ${run.y}) scale(${run.scale} ${-run.scale})`}/>)}</g>}
              {o.type==='text'&&!text&&<rect width={o.width} height={Math.min(o.height,page.unit==='mm'?4:16)} fill={o.color} opacity={.1} pointerEvents="none"/>}
            </g>;
          })}
        </svg>
        {draft?.guides.map((g,i)=><line key={i} x1={g.axis==='x'?g.value:0} x2={g.axis==='x'?g.value:page.width} y1={g.axis==='y'?g.value:0} y2={g.axis==='y'?g.value:page.height} stroke="#d86eaa" strokeWidth={1} strokeDasharray="4 3" vectorEffect="non-scaling-stroke" pointerEvents="none"/>)}
        {selection&&<g data-canvas-object={selection.id} className="canvas-selection" pointerEvents={selection.locked?'none':undefined}><rect x={selection.x} y={selection.y} width={selection.width} height={selection.height} fill="none" stroke="#7961cf" strokeWidth={1.5} strokeDasharray={selection.locked?'4 3':undefined} vectorEffect="non-scaling-stroke" pointerEvents="none"/>{!w.locked&&!selection.locked&&([['nw',selection.x,selection.y],['ne',selection.x+selection.width,selection.y],['sw',selection.x,selection.y+selection.height],['se',selection.x+selection.width,selection.y+selection.height]] as const).map(([handle,x,y])=>{
          // Expand mostly outward so even a small object keeps a draggable center.
          const hit=32/scale,inset=Math.min(8/scale,selection.width/3,selection.height/3);
          return <g key={handle}><rect data-handle={handle} aria-label={`调整尺寸 ${handle}`} x={x-(handle.includes('w')?hit-inset:inset)} y={y-(handle.includes('n')?hit-inset:inset)} width={hit} height={hit} fill="transparent" style={{cursor:`${handle}-resize`}}/><rect x={x-5/scale} y={y-5/scale} width={10/scale} height={10/scale} fill="white" stroke="#7961cf" strokeWidth={1.5} vectorEffect="non-scaling-stroke" pointerEvents="none"/></g>;
        })}</g>}
      </svg>
    </div></div>
    <div className="editor-hint" role="status">{error?<><span>{error}</span><button className="text-button" onClick={()=>setRetry(n=>n+1)}>重新排版</button></>:draft?`${draft.box.x.toFixed(2)}, ${draft.box.y.toFixed(2)} · ${draft.box.width.toFixed(2)} × ${draft.box.height.toFixed(2)} ${page.unit}`:selected?.locked?'对象已锁定，可在对象面板解锁；复制会得到可编辑的副本。':selected?.hidden?'对象已隐藏，可在对象面板显示；隐藏对象不参与下载。':pending?'正在更新文字排版…':'拖动移动 · 四角调整大小 · 方向键微调 · Shift 加速 / 等比例缩放 · Alt 暂停吸附'}</div>
  </>;
}
