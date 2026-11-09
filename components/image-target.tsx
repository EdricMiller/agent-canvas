'use client';

import {useState} from 'react';
import type {WorkspaceState} from '@/lib/use-workspace';
import type {ImageTarget,ImageVersion,ImageGeneration} from '@/lib/types';
import {targetGeometry} from '@/shared/image-target.js';
import {generationSettings,imageGenerationPlan,extendedImageQuality,customImageSizes,QUALITY_LABELS} from '@/shared/image-generation.js';
import {Modal} from './modal';

export function ImageTargetControl({w}:{w:WorkspaceState}){
  const target=w.session?.imageTarget,settings=generationSettings(w.session?.imageGeneration),g=target?targetGeometry(target,settings):null;
  const [open,setOpen]=useState(false);
  return <>
    <div className="image-target" id="imageTargetStatus" aria-label="图片交付尺寸"><div><strong>{g?target!.mode==='pixels'?`${g.width} × ${g.height} px`:`${target!.width}:${target!.height} 比例`:'尺寸随对话确定'} · {QUALITY_LABELS[settings.quality]}{settings.resolution!=='auto'?` · ${settings.resolution.toUpperCase()}`:''}</strong><small>{g?`${g.aspectWidth}:${g.aspectHeight} · ${target!.fit==='cover'?'居中裁切':'完整保留画面'}${target!.mode==='ratio'?` · 输出 ${g.width} × ${g.height} px`:''}`:'例如：宽 585、高 1080 像素，或自定义比例'}</small></div><button type="button" id="editImageTarget" className="text-button" disabled={w.locked} onClick={()=>setOpen(true)}>{g?'调整':'设置'}</button></div>
    {open&&<ImageTargetDialog w={w} onClose={()=>setOpen(false)}/>}
  </>;
}

function ImageTargetDialog({w,onClose}:{w:WorkspaceState;onClose:()=>void}){
  const current=w.session?.imageTarget;
  const [mode,setMode]=useState<ImageTarget['mode']|'auto'>(current?.mode||'auto'),[width,setWidth]=useState(String(current?.width||585)),[height,setHeight]=useState(String(current?.height||1080));
  const [fit,setFit]=useState<ImageTarget['fit']>(current?.fit||'contain'),[background,setBackground]=useState(current?.background||'#ffffff'),[error,setError]=useState('');
  const [settings,setSettings]=useState<ImageGeneration>(generationSettings(w.session?.imageGeneration));
  const candidate:ImageTarget={mode:mode==='auto'?'pixels':mode,width:Number(width),height:Number(height),fit,background},dimensionsValid=Number.isInteger(candidate.width)&&Number.isInteger(candidate.height)&&candidate.width>0&&candidate.height>0,valid=mode==='auto'||dimensionsValid;
  const g=dimensionsValid?targetGeometry(candidate,settings):null;
  let plan:ReturnType<typeof imageGenerationPlan>|null=null,planError='';
  if(valid)try{plan=imageGenerationPlan(mode==='auto'?null:candidate,settings,w.config?.imageModel||'',w.config?.imageSize||'auto',w.config?.imageBaseURL);}catch(e){planError=e instanceof Error?e.message:'参数不受支持';}
  async function apply(target:ImageTarget|null){
    setError('');await w.operate(async()=>{
      try{await w.patchSession({imageTarget:target,imageGeneration:target?settings:{...settings,resolution:'auto'}});onClose();w.notify(target?'已设置后续图片的尺寸与画质，现有图片保持原样。':'已设置后续图片画质，尺寸由模型选择。');}
      catch(e){setError(e instanceof Error?e.message:'尺寸保存失败');}
    });
  }
  return <Modal title="图片尺寸与画质" eyebrow="IMAGE SETTINGS" onClose={onClose}><form className="image-settings-form" onSubmit={e=>{e.preventDefault();if(valid)apply(mode==='auto'?null:candidate);}}><fieldset disabled={w.locked}>
    <div className="field-pair"><label>生成精细度<select id="imageGenerationQuality" value={settings.quality} onChange={e=>setSettings({...settings,quality:e.target.value as ImageGeneration['quality']})}><option value="low">快速预览 · low</option><option value="medium">标准 · medium</option><option value="high">精细 · high（默认）</option>{extendedImageQuality(w.config?.imageModel)&&<><option value="xhigh">更精细 · xhigh</option><option value="max">最高精细度 · max</option></>}<option value="auto">模型自动选择</option></select></label><label>原生分辨率<select id="imageGenerationResolution" value={settings.resolution} onChange={e=>setSettings({...settings,resolution:e.target.value as ImageGeneration['resolution']})}><option value="auto">按目标尺寸生成</option><option value="2k" disabled={mode==='auto'||!customImageSizes(w.config?.imageModel,w.config?.imageBaseURL)}>高清 · 最高 2K</option><option value="4k" disabled={mode==='auto'||!customImageSizes(w.config?.imageModel,w.config?.imageBaseURL)}>超清 · 最高 4K（实验）</option></select></label></div>
    <p className="help">精细度控制生成细节，分辨率控制原生像素。更高档位通常需要更多时间和费用，仅用于下一次生成或改图。</p>
    <label>尺寸设置<select id="imageTargetMode" value={mode} onChange={e=>{const next=e.target.value as ImageTarget['mode']|'auto';if(g&&next!=='auto'){setWidth(String(next==='ratio'?g.aspectWidth:g.width));setHeight(String(next==='ratio'?g.aspectHeight:g.height));}if(next==='auto')setSettings({...settings,resolution:'auto'});setMode(next);}}><option value="auto">由模型选择尺寸</option><option value="pixels">准确像素尺寸</option><option value="ratio">只指定宽高比</option></select></label>
    {mode==='auto'?<p className="help">可单独调整精细度，保持自由构图。选择尺寸或比例后，可进一步指定 2K / 4K。</p>:<><div className="field-pair"><label>{mode==='pixels'?'宽度 (px)':'比例 · 宽'}<input id="imageTargetWidth" aria-label="目标宽度" type="number" required min={1} max={8192} step={1} value={width} onChange={e=>setWidth(e.target.value)}/></label><label>{mode==='pixels'?'高度 (px)':'比例 · 高'}<input id="imageTargetHeight" aria-label="目标高度" type="number" required min={1} max={8192} step={1} value={height} onChange={e=>setHeight(e.target.value)}/></label></div>
    {mode==='ratio'&&<p className="help">宽高比例可自由填写，例如 9:16、21:9、7:11。确认后用于下一次生成和改图。</p>}
    {g&&<div className="target-size-preview"><div>最终交付 {g.width} × {g.height} px · {g.aspectWidth}:{g.aspectHeight}</div><div id="imageGenerationPreview">{plan?.width?`模型请求 ${plan.width} × ${plan.height} px`:'生成尺寸由模型自动选择'} · {QUALITY_LABELS[settings.quality]}</div>{plan?.experimental&&<small>此尺寸为实验高分辨率，可能耗时更长，需中转站支持。</small>}{plan?.adapted&&<small>模型原生画布与交付比例不同；生成后会在本地输出严格的 {g.width} × {g.height} px，并保留模型原图供下载。</small>}{g.aspectWidth/g.aspectHeight>3||g.aspectWidth/g.aspectHeight<1/3?<small>当前比例超出模型原生 3:1 范围，无法安全地直接请求 {g.width} × {g.height} px；要让模型原生输出该比例，需要更换支持超宽画布的模型或接口。</small>:null}</div>}
    <label>模型返回比例不同时<select id="imageTargetFit" value={fit} onChange={e=>setFit(e.target.value as ImageTarget['fit'])}><option value="contain">完整保留画面 · 等比缩放并留边</option><option value="cover">填满画布 · 居中裁切</option></select></label>
    <label className="check-row"><input id="imageTargetTransparent" type="checkbox" checked={background==='transparent'} onChange={e=>setBackground(e.target.checked?'transparent':'#ffffff')}/>透明背景（需要生图服务支持）</label>
    {fit==='contain'?<label>留边颜色<input id="imageTargetBackground" type="color" disabled={background==='transparent'} value={background==='transparent'?'#ffffff':background} onChange={e=>setBackground(e.target.value)}/></label>:<p className="help">居中裁切可能移除边缘的产品或文字，请为主体预留空间。</p>}
    </>}
    <p className="help">用于后续生成与改图。也可以直接在对话中说明尺寸。输出每边 16–8192 像素，总计不超过 2500 万像素；放大不增加原图细节。</p>
    {(error||planError)&&<p className="error" role="alert">{error||planError}</p>}
    <div className="target-dialog-actions"><button type="button" className="text-button" disabled={!current} onClick={()=>apply(null)}>取消固定尺寸</button><button id="saveImageTarget" className="btn primary" type="submit" disabled={!valid||Boolean(planError)}>应用设置</button></div>
  </fieldset></form></Modal>;
}

function adaptationLabel(method?:string){
  return method==='background-crop'?'已裁去外部留白并补齐背景':method==='contain'?'已等比适配并留边':method==='cover'?'已居中裁切适配':method==='resize'?'已等比缩放':'尺寸符合目标';
}

export function ImageOutputDetails({image}:{image:ImageVersion}){
  const a=image.adaptation,g=image.imageTarget?targetGeometry(image.imageTarget,image.imageGeneration):null,request=image.generation;
  const ratio=image.imageTarget?.mode==='ratio'?`${image.imageTarget.width}:${image.imageTarget.height}`:g?`${g.aspectWidth}:${g.aspectHeight}`:'';
  return <div className="image-output-details" id="imageOutputDetails"><strong>{image.width} × {image.height} px</strong>{image.composition&&<span id="imageCompositionDetails">Logo 组合 · 保留底图尺寸 · 未调用图片模型</span>}{image.localEdit&&<span id="localColorEditDetails">局部换色 · 原尺寸与布局保留 · 未调用图片模型</span>}{image.localResize&&<span>仅改尺寸 · 未调用 AI</span>}{request&&<span>请求 {request.size} · {QUALITY_LABELS[request.quality]||request.quality}{request.sourceWidth?` · 模型返回 ${request.sourceWidth} × ${request.sourceHeight} px`:''}</span>}{request?.sourceWidth&&request.size!=='auto'&&request.size!==`${request.sourceWidth}x${request.sourceHeight}`&&<span>服务返回尺寸与请求不同，以实际原图为准</span>}{image.transparency?.hasTransparency&&<span>已检测透明边缘 · 请核对主体与边缘质量</span>}{image.imageTarget&&!image.localEdit&&<span>目标 {ratio} · {adaptationLabel(a?.method)}</span>}{a?.upscaled&&<span>已放大，原图细节不增加</span>}{image.sourceUrl&&<a href={image.sourceUrl} download>{image.composition?'下载高清组合图 ↗':image.localEdit?'下载高清换色图 ↗':'下载适配前原图 ↗'}</a>}</div>;
}

export function ImageInspector({w}:{w:WorkspaceState}){
  const image=w.session?.versions.find(v=>v.id===w.view),target=w.session?.imageTarget,settings=generationSettings(w.session?.imageGeneration),g=target?targetGeometry(target,settings):null;
  return <aside className="inspector image-inspector" aria-label="图片信息"><div className="inspector-body">
    <div className="section-title"><h2>图片信息</h2><span>整图创作</span></div>
    {image?<><h3>当前作品</h3><strong className="image-inspector-size">{image.width} × {image.height} px</strong><p className="help">{image.localEdit?'局部换色，未选区域像素保持原样':image.adaptation?adaptationLabel(image.adaptation.method):'保留图片尺寸'}{image.adaptation?` · 适配前 ${image.adaptation.sourceWidth} × ${image.adaptation.sourceHeight} px`:''}</p></>:<p className="help">描述产品、用途和尺寸，完成后在画布中查看作品。</p>}
    <h3>后续生成目标</h3><strong className="image-inspector-size">{g?`${g.width} × ${g.height} px`:'随对话确定'}</strong><p className="help">{g?`${g.aspectWidth}:${g.aspectHeight} · ${target!.fit==='cover'?'居中裁切':'完整保留画面'}。修改目标不会改变已有作品。`:'可以直接说「宽585、高1080像素」，或只指定「13:24」。'}</p>
    <p className="help">生成质量：{QUALITY_LABELS[settings.quality]} · {settings.resolution==='auto'?'按目标尺寸生成':`最高 ${settings.resolution.toUpperCase()} 原生分辨率`}</p>
    <p className="help">在输入框上方查看和调整尺寸；后续改图沿用确认的目标。</p>
    {image&&<p className="help">需要独立编辑文字和图片时，点击画布上方「以此图创建设计稿」。</p>}
  </div></aside>;
}
