'use client';

import {useEffect,useRef,useState} from 'react';
import type {WorkspaceState} from '@/lib/use-workspace';
import type {DesignObject,Unit} from '@/lib/types';
import {Icon} from './icons';
import {lockedBinding} from '@/shared/design-objects.js';

function Numeric({label,value,onChange,min=.1}:{label:string;value:number;onChange:(v:number)=>void;min?:number}){
  return <label>{label}<input type="number" step="any" min={min} max={20000} value={Number(value.toFixed(6))} onChange={e=>{if(e.target.value&&Number.isFinite(e.target.valueAsNumber))onChange(e.target.valueAsNumber);}}/></label>;
}
export function Inspector({w,tab,setTab,inspectRequest=0}:{w:WorkspaceState;tab:'canvas'|'content'|'objects';setTab:(t:'canvas'|'content'|'objects')=>void;inspectRequest?:number}){
  const [allContent,setAllContent]=useState(false);
  const properties=useRef<HTMLDivElement>(null),replacement=useRef<HTMLInputElement>(null),lastInspect=useRef(inspectRequest);
  useEffect(()=>{
    const requested=lastInspect.current!==inspectRequest;lastInspect.current=inspectRequest;
    if(tab!=='objects'||!w.selected)return;
    if(requested){properties.current?.focus({preventScroll:true});properties.current?.scrollIntoView({block:'nearest',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});}
    else if(document.activeElement?.id!=='designCanvas')properties.current?.scrollIntoView({block:'nearest'});
  },[tab,w.selected,inspectRequest]);
  const p=w.activePage,o=p?.objects.find(o=>o.id===w.selected),settings=p?{...p,title:w.document!.title}:w.canvas;
  function setting(key:string,value:string|number){
    if(w.document)w.edit(doc=>{if(key==='title')doc.title=String(value);else Object.assign(doc.pages.find(page=>page.id===p!.id)!,{[key]:value});});
    else w.setCanvas(c=>({...c,[key]:value}));
  }
  function unit(next:Unit){
    const factor=next===settings.unit?1:next==='mm'?25.4/96:96/25.4;
    if(p)w.edit(doc=>{const page=doc.pages.find(page=>page.id===p!.id)!;page.unit=next;page.width*=factor;page.height*=factor;for(const o of page.objects)for(const key of ['x','y','width','height'] as const)o[key]*=factor;});
    else w.setCanvas(c=>({...c,unit:next,width:c.width*factor,height:c.height*factor}));
  }
  function property(key:string,value:string|number|boolean){
    w.edit(doc=>{
      const target=doc.pages.find(page=>page.id===p!.id)!.objects.find(item=>item.id===w.selected);if(!target||target.locked||key==='text'&&target.type==='text'&&lockedBinding(doc,target.bindingId))return;
      Object.assign(target,{[key]:value});
      if(target.type==='image'&&key==='fit'&&value==='contain')target.bleed=false;
      if(target.type==='text'&&key==='text'&&target.bindingId){
        const field=doc.content?.find(f=>f.id===target.bindingId);if(field)field.value=String(value);
        for(const page of doc.pages)for(const linked of page.objects)if(linked.type==='text'&&linked.bindingId===target.bindingId)linked.text=String(value);
      }
    });
  }
  const fields=w.document?.content?.filter(field=>allContent||p?.objects.some(o=>o.type==='text'&&o.bindingId===field.id)||!w.document!.pages.some(page=>page.objects.some(o=>o.type==='text'&&o.bindingId===field.id)))||[];
  return <aside className="inspector" aria-label="设计属性">
    <div className="inspector-tabs" role="tablist" aria-label="编辑面板">{([['canvas','画布'],['content','内容'],['objects','对象']] as const).map(([id,label])=><button key={id} role="tab" aria-selected={tab===id} onClick={()=>setTab(id)}>{label}{id==='content'&&w.document?.content?.some(f=>f.status==='needs_confirmation')&&<i/>}</button>)}</div>
    <fieldset disabled={w.locked||w.view!=='design'} className="inspector-body" onFocusCapture={e=>{if(e.target.matches('input,textarea,select'))w.beginEdit(crypto.randomUUID());}} onBlurCapture={w.endEdit}>
      {tab==='canvas'&&<>
        <div className="section-title"><h2>画布设置</h2><span>自定义尺寸</span></div>
        <label>设计稿名称<input id="designTitle" value={settings.title} maxLength={100} onChange={e=>setting('title',e.target.value)}/></label>
        {p&&<label>页面名称<input aria-label="页面名称" value={p.name} maxLength={100} onChange={e=>setting('name',e.target.value)}/></label>}
        <div className="field-pair"><Numeric label="宽度" value={settings.width} onChange={v=>setting('width',v)}/><Numeric label="高度" value={settings.height} onChange={v=>setting('height',v)}/></div>
        <div className="field-pair"><label>单位<select id="pageUnit" value={settings.unit} onChange={e=>unit(e.target.value as Unit)}><option value="px">像素 px</option><option value="mm">毫米 mm</option></select></label><label>背景颜色<input type="color" disabled={settings.background==='transparent'} value={settings.background==='transparent'?'#ffffff':settings.background} onChange={e=>setting('background',e.target.value)}/></label></div>
        <label className="check-row"><input id="pageTransparent" type="checkbox" checked={settings.background==='transparent'} onChange={e=>setting('background',e.target.checked?'transparent':'#ffffff')}/>透明画布 · PNG 保留透明背景</label>
        <p className="help">尺寸适用于预览和下载。切换单位保留实际尺寸；字号使用 pt。</p>
        {!p&&<button id="createDesign" className="btn primary full" onClick={()=>w.create()}>创建设计稿</button>}
        {p&&<div className="canvas-summary"><Icon name="layout"/><div><strong>{p.name}</strong><small>{p.objects.length} 个独立对象 · 第 {w.document!.pages.indexOf(p)+1} / {w.document!.pages.length} 页</small></div></div>}
      </>}
      {tab==='content'&&<>
        <div className="section-title"><h2>内容核对</h2><span>{fields.length} 项</span></div>
        <p className="help">修改会同步到绑定的文字。待核对项确认后才能下载。</p>
        <label className="check-row"><input type="checkbox" checked={allContent} onChange={e=>setAllContent(e.target.checked)}/>显示整册内容（默认当前页）</label>
        {fields.length?fields.map(field=><div key={field.id} className={`content-field ${field.status==='needs_confirmation'?'pending':''}`}>
          <label>{field.label}<textarea data-content={field.id} disabled={lockedBinding(w.document!,field.id)} value={field.value} maxLength={10000} onChange={e=>w.edit(doc=>{
            const f=doc.content!.find(f=>f.id===field.id)!;f.value=e.target.value;
            for(const page of doc.pages)for(const object of page.objects)if(object.type==='text'&&object.bindingId===f.id)object.text=f.value;
          })}/></label>
          <label className="check-row"><input type="checkbox" data-confirm={field.id} checked={field.status==='confirmed'} onChange={e=>w.edit(doc=>{doc.content!.find(f=>f.id===field.id)!.status=e.target.checked?'confirmed':'needs_confirmation';})}/>{field.status==='confirmed'?'已核对':'待核对'}</label>
          <small>{w.document!.pages.filter(page=>page.objects.some(o=>o.type==='text'&&o.bindingId===field.id)).map(page=>`第 ${w.document!.pages.indexOf(page)+1} 页`).join('、')||'尚未放置'} · 共享字段会同步修改</small>
          {lockedBinding(w.document!,field.id)&&<small>绑定对象已锁定，解锁后可修改文字。</small>}
          {field.sourceId&&<small>来源：{w.data.assets.find(a=>a.id===field.sourceId)?.name||'参考素材'}</small>}
        </div>):<div className="panel-empty">AI 生成的文案会在这里核对。<br/>手动添加的文字可在对象面板修改。</div>}
      </>}
      {tab==='objects'&&<>
        <div className="section-title"><h2>设计对象</h2><span>{p?.objects.length||0} 个</span></div>
        {p?<>
          <div className="add-objects"><button className="btn" id="addText" onClick={()=>w.addObject('text')}><Icon name="text"/>文字</button><button className="btn" id="addShape" onClick={()=>w.addObject('rect')}><Icon name="rect"/>色块</button></div>
          <label>插入图片或 Logo<select aria-label="插入图片或 Logo" value="" onChange={e=>{if(e.target.value)w.addObject('image',e.target.value);}}><option value="" disabled>选择当前会话素材</option>{w.data.assets.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
          <div className="layer-heading"><strong>图层</strong><small>上方图层显示在前</small></div>
          <div className="object-list">{[...p.objects].reverse().map(item=>{
            const name=item.type==='text'?item.text||'空文字':item.type==='rect'?'色块':w.data.assets.find(a=>a.id===item.assetId)?.name||'图片';
            return <div key={item.id} className={`layer-row ${item.hidden?'is-hidden':''}`} data-selected={item.id===w.selected}>
              <button className="layer-select" data-object={item.id} aria-pressed={item.id===w.selected} onClick={()=>w.setSelected(item.id)} title={name}><Icon name={item.type==='text'?'text':item.type==='image'?'image':'rect'} size={16}/><span>{name}</span></button>
              <button className="layer-toggle" data-layer-lock={item.id} aria-label={`${item.locked?'解锁':'锁定'}：${name}`} title={item.locked?'解锁对象':'锁定对象，防止误改'} aria-pressed={!!item.locked} onClick={()=>w.objectOperation({type:'lock',value:!item.locked},item.id)}><Icon name={item.locked?'lock':'unlock'} size={16}/></button>
              <button className="layer-toggle" data-layer-visibility={item.id} aria-label={`${item.hidden?'显示':'隐藏'}：${name}`} title={item.hidden?'显示对象':'隐藏对象，不参与下载'} aria-pressed={!!item.hidden} onClick={()=>w.objectOperation({type:'visibility',value:!item.hidden},item.id)}><Icon name={item.hidden?'eye-off':'eye'} size={16}/></button>
            </div>;
          })}</div>
          {o&&<div ref={properties} id="objectProperties" className="object-properties" tabIndex={-1} aria-label="对象属性"><div className="section-title"><h3>对象属性</h3><div className="property-actions"><button className="text-button return-to-canvas" onClick={()=>{const canvas=document.getElementById('designCanvas');canvas?.focus({preventScroll:true});(canvas?.closest('.canvas-surface')||canvas)?.scrollIntoView({block:'start',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});}}>返回画布</button><button className="text-button danger" disabled={!!o.locked} onClick={w.deleteSelected}>删除</button></div></div>
            <div className="object-actions"><button className="btn" id="duplicateObject" onClick={()=>w.objectOperation({type:'duplicate'})}><Icon name="copy" size={15}/>复制对象</button><button className="btn" id="toggleObjectLock" onClick={()=>w.objectOperation({type:'lock',value:!o.locked})}>{o.locked?'解锁对象':'锁定对象'}</button></div>
            {(o.locked||o.hidden)&&<p className="object-state" role="status">{o.hidden?'已隐藏，画布与下载中不显示。':''}{o.locked?'已锁定，解锁后可移动或修改。':''}{o.hidden&&<button className="text-button" onClick={()=>w.objectOperation({type:'visibility',value:false})}>显示对象</button>}</p>}
            <fieldset className="object-fields" disabled={!!o.locked}>
            <div className="layer-order" aria-label="图层顺序">{([['front','置顶'],['forward','上移一层'],['backward','下移一层'],['back','置底']] as const).map(([direction,label])=><button className="btn" key={direction} data-layer-order={direction} disabled={p.objects.indexOf(o)===(direction==='front'||direction==='forward'?p.objects.length-1:0)} onClick={()=>w.objectOperation({type:'order',direction})}>{label}</button>)}</div>
            {o.type==='text'&&<label>文字内容<textarea data-property="text" disabled={lockedBinding(w.document!,o.bindingId)} value={o.text} maxLength={10000} onChange={e=>property('text',e.target.value)}/>{!o.locked&&lockedBinding(w.document!,o.bindingId)&&<small>共享文字的另一个对象已锁定，请先解锁。</small>}</label>}
            <div className="field-pair">{(['x','y','width','height'] as const).map(key=><Numeric key={key} label={`${({x:'X',y:'Y',width:'宽度',height:'高度'})[key]} (${p.unit})`} value={o[key]} min={key==='x'||key==='y'?0:.1} onChange={v=>property(key,v)}/>)}</div>
            {o.type==='text'&&<><div className="field-pair"><Numeric label="字号 (pt)" value={o.fontSize} min={4} onChange={v=>property('fontSize',v)}/><label>文字颜色<input type="color" value={o.color} onChange={e=>property('color',e.target.value)}/></label></div><label>对齐<select value={o.align} onChange={e=>property('align',e.target.value)}><option value="left">左对齐</option><option value="center">居中</option><option value="right">右对齐</option></select></label></>}
            {o.type==='rect'&&<label>填充颜色<input type="color" value={o.fill} onChange={e=>property('fill',e.target.value)}/></label>}
            {o.type==='image'&&<><div className="replace-image"><label>替换图片或 Logo<select id="replaceImageAsset" value={o.assetId} onChange={e=>w.objectOperation({type:'replace',assetId:e.target.value})}>{w.data.assets.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label><input ref={replacement} id="replaceImageFile" type="file" hidden accept="image/png,image/jpeg,image/webp" onChange={e=>{const file=e.target.files?.[0];e.target.value='';if(file)w.uploadReplacement(file);}}/><button id="uploadReplacement" className="btn full" onClick={()=>replacement.current?.click()}>上传新图并替换</button><p className="help">保留位置、尺寸和适配方式。原图仍可用于历史版本。</p></div><label>图片适配<select value={o.fit} onChange={e=>property('fit',e.target.value)}><option value="contain">完整显示</option><option value="cover">居中裁切填充</option></select></label></>}
            {o.type!=='text'&&<><label className="check-row"><input id="objectBleed" type="checkbox" checked={!!o.bleed} disabled={o.type==='image'&&o.fit!=='cover'} onChange={e=>property('bleed',e.target.checked)}/>印刷时延展到出血区</label><p className="help">仅延展贴着成品边缘的部分。{o.type==='image'?'图片需选择居中裁切填充，会按原图比例重新裁切；Logo 通常保持完整显示。':'色块保持原色延展。'}普通预览和线上下载保持成品画面。</p></>}
            </fieldset>
          </div>}
        </>:<div className="panel-empty">先创建设计稿或让 AI 排版，<br/>再添加和编辑独立对象。</div>}
      </>}
    </fieldset>
  </aside>;
}
