'use client';

import {useRef,useState,type PointerEvent} from 'react';
import type {WorkspaceState} from '@/lib/use-workspace';
import type {LogoPlacement} from '@/lib/types';
import {fitLogoPlacement,resizeLogoPlacement} from '@/shared/image-compose.js';
import {Modal} from './modal';

const defaults:LogoPlacement={x:.06,y:.05,width:.28,height:.28,fit:'contain',opacity:1};
const percent=(value:number)=>Number((value*100).toFixed(2));

export function ImageComposeDialog({w,onClose}:{w:WorkspaceState;onClose:()=>void}){
  const assets=w.session?.versions.filter(v=>!v.demo)||[];
  const selected=assets.find(v=>v.id===w.view)||assets.find(v=>v.id===w.session?.selectedId);
  const existing=selected?.composition,initialSource=existing?.baseId||selected?.id||assets[0]?.id||'';
  const [sourceId,setSourceId]=useState(initialSource),[logoId,setLogoId]=useState(existing?.logoId||assets.find(v=>v.id!==initialSource&&v.transparency?.hasTransparency)?.id||'');
  const [draftPlacement,setPlacement]=useState<LogoPlacement>(existing?.placement||defaults),[error,setError]=useState('');
  const baseInput=useRef<HTMLInputElement>(null),logoInput=useRef<HTMLInputElement>(null);
  const drag=useRef<{pointerId:number;x:number;y:number;left:number;top:number;width:number;height:number}|null>(null);
  const source=assets.find(v=>v.id===sourceId),logo=assets.find(v=>v.id===logoId);
  const placement=fitLogoPlacement(draftPlacement,source,logo);
  const valid=!!source&&!!logo&&sourceId!==logoId;
  function change(key:keyof Omit<LogoPlacement,'fit'>,value:number){
    if(!Number.isFinite(value))return;
    setPlacement(draft=>{
      const p=fitLogoPlacement(draft,source,logo);
      if(key==='width'||key==='height')return resizeLogoPlacement(p,source,logo,key,value);
      const next={...p,[key]:Math.max(0,Math.min(1,value))};
      next.x=Math.min(next.x,1-next.width);next.y=Math.min(next.y,1-next.height);return next;
    });setError('');
  }
  function startDrag(event:PointerEvent<HTMLButtonElement>){
    if(w.locked||event.button!==0)return;
    const box=event.currentTarget.parentElement!.getBoundingClientRect();
    drag.current={pointerId:event.pointerId,x:event.clientX,y:event.clientY,left:placement.x,top:placement.y,width:box.width,height:box.height};
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function moveDrag(event:PointerEvent<HTMLButtonElement>){
    const start=drag.current;if(!start||start.pointerId!==event.pointerId||w.locked)return;
    setPlacement(draft=>{const p=fitLogoPlacement(draft,source,logo);return {...p,x:Math.max(0,Math.min(1-p.width,start.left+(event.clientX-start.x)/start.width)),y:Math.max(0,Math.min(1-p.height,start.top+(event.clientY-start.y)/start.height))};});
  }
  function upload(file:File,kind:'base'|'logo'){
    setError('');w.uploadCompositionAsset(file,id=>{if(kind==='base'){setSourceId(id);if(id===logoId)setLogoId('');}else setLogoId(id);},setError);
  }
  return <Modal title="图片组合" eyebrow="PLACE YOUR LOGO" wide className="compose-dialog" onClose={onClose}>
    <p className="help">选择底图和透明 Logo，拖动预览中的 Logo 或输入位置。保存后生成一个新版本。</p>
    <form onSubmit={e=>{e.preventDefault();setError('');if(valid)w.composeImage({sourceId,logoId,placement,label:'图片组合 · Logo'},onClose,setError);}}>
      <fieldset disabled={w.locked}>
        <div className="compose-layout"><div>
          <div className="compose-preview-frame">{source?<div id="composePreview" className="compose-preview transparency-preview" style={{aspectRatio:`${source.width||1} / ${source.height||1}`,width:`min(100%, ${48*(source.width||1)/(source.height||1)}dvh)`}}>
            <img className="compose-base" src={source.url} alt="组合底图" draggable={false}/>
            {valid&&<button type="button" id="composeOverlay" className="compose-overlay" aria-label="拖动 Logo 调整位置" style={{left:`${placement.x*100}%`,top:`${placement.y*100}%`,width:`${placement.width*100}%`,height:`${placement.height*100}%`,opacity:placement.opacity}} onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={()=>{drag.current=null;}} onPointerCancel={()=>{drag.current=null;}} onLostPointerCapture={()=>{drag.current=null;}} onKeyDown={e=>{if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)){e.preventDefault();const key=e.key==='ArrowLeft'||e.key==='ArrowRight'?'x':'y';change(key,placement[key]+(e.key==='ArrowLeft'||e.key==='ArrowUp'?-.01:.01));}}}>
              <img src={logo!.url} alt="组合 Logo" draggable={false} style={{objectFit:placement.fit}}/>
            </button>}
          </div>:<p className="help">先选择或上传一张底图</p>}</div>
          <p className="help compose-caption">{source?`${source.width} × ${source.height} px · 保留底图尺寸`:'支持 PNG、JPG、WebP'}{valid?' · 可用方向键微调 Logo':''}</p>
        </div><div className="compose-controls">
          <label>底图<select id="composeSource" value={sourceId} onChange={e=>{setSourceId(e.target.value);if(e.target.value===logoId)setLogoId('');setError('');}} required><option value="">选择底图</option>{assets.map(v=><option key={v.id} value={v.id}>{v.label||`图片 V${v.number}`}</option>)}</select></label>
          <button type="button" className="btn small" onClick={()=>baseInput.current?.click()}>上传底图</button>
          <label>透明 Logo<select id="composeLogo" value={logoId} onChange={e=>{setLogoId(e.target.value);setError('');}} required><option value="">选择透明 Logo</option>{assets.filter(v=>v.id!==sourceId).map(v=><option key={v.id} value={v.id}>{v.label||`图片 V${v.number}`}</option>)}</select></label>
          <button type="button" className="btn small" onClick={()=>logoInput.current?.click()}>上传 Logo</button>
          <p className="help">Logo 需有真实透明背景，保存时会检查。每张不超过 10 MB。</p>
          <div className="field-pair">{(['x','y','width','height'] as const).map((key,index)=><label key={key}>{['左侧位置 (%)','顶部位置 (%)','宽度 (%)','高度 (%)'][index]}<input id={`compose-${key}`} type="number" min={key==='width'||key==='height'?.01:0} max={100} step="any" value={percent(placement[key])} onChange={e=>change(key,e.target.valueAsNumber/100)} required/></label>)}</div>
          <label>Logo 适配<select id="composeFit" value={placement.fit} onChange={e=>setPlacement({...placement,fit:e.target.value as LogoPlacement['fit']})}><option value="contain">完整显示 · 保持比例</option><option value="cover">填满区域 · 居中裁切</option></select></label>
          <p className="help">完整显示时宽高按 Logo 比例联动，可拖到图片边缘。</p>
          <label>不透明度 · {percent(placement.opacity)}%<input id="composeOpacity" type="range" min={0} max={100} value={percent(placement.opacity)} onChange={e=>change('opacity',Number(e.target.value)/100)}/></label>
          <input id="composeBaseInput" ref={baseInput} type="file" hidden accept="image/png,image/jpeg,image/webp" onChange={e=>{const file=e.target.files?.[0];e.target.value='';if(file)upload(file,'base');}}/>
          <input id="composeLogoInput" ref={logoInput} type="file" hidden accept="image/png,image/jpeg,image/webp" onChange={e=>{const file=e.target.files?.[0];e.target.value='';if(file)upload(file,'logo');}}/>
        </div></div>
        {error&&<p className="error" role="alert">{error}</p>}
        <div className="compose-footer"><span className="help">直接拼接图片 · 不调用模型</span><button id="composeSubmit" className="btn primary" type="submit" disabled={!valid||w.locked}>{w.busy?'正在处理…':'保存组合图片'}</button></div>
      </fieldset>
    </form>
  </Modal>;
}
