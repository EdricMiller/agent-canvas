'use client';

import {useEffect,useRef,useState} from 'react';
import type {WorkspaceState} from '@/lib/use-workspace';
import type {DesignRecord,ExportReport,PrintProfile,Issue} from '@/lib/types';
import {parsePageRange} from '@/shared/page-range.js';
import {nativePrintGeometry} from '@/shared/print-image.js';
import {download} from '@/lib/api';
import {Modal} from './modal';
import {PrintProof,type ProofRequest} from './print-proof';

export function DownloadDialog({w,onClose,onLocate}:{w:WorkspaceState;onClose:()=>void;onLocate:(issue:Issue)=>void}){
  const [format,setFormat]=useState('png'),[color,setColor]=useState('rgb'),[scale,setScale]=useState(1),[dpi,setDpi]=useState('original');
  const [vectorize,setVectorize]=useState(false),[vectorProof,setVectorProof]=useState<string|null>(null);
  const [printReady,setPrintReady]=useState(false),[customPrintSize,setCustomPrintSize]=useState(false);
  const [range,setRange]=useState('all'),[customRange,setCustomRange]=useState('');
  const [bleed,setBleed]=useState(3),[marks,setMarks]=useState(false),[blackText,setBlackText]=useState('preserve'),[profileId,setProfileId]=useState('');
  const [bleedMode,setBleedMode]=useState('objects'),[safe,setSafe]=useState(3),[proof,setProof]=useState<ProofRequest|null>(null);
  const [profiles,setProfiles]=useState<PrintProfile[]>([]),[report,setReport]=useState<ExportReport|null>(null),[ack,setAck]=useState(false),[error,setError]=useState('');
  const [phase,setPhase]=useState<'idle'|'saving'|'checking'|'review'|'downloading'|'done'|'importing'>('idle');
  const importFile=useRef<HTMLInputElement>(null),checkResult=useRef<HTMLElement>(null),vectorResult=useRef<HTMLElement>(null);
  const record=w.data.design,design=w.view==='design'&&record,image=w.session?.versions.find(v=>v.id===w.view),printing=format==='pdf'&&color==='cmyk';
  const vector=['svg','eps','ai'].includes(format)||format==='pdf'&&vectorize;
  const title=design?w.document!.title:image?.label||'当前图片',p=design?w.activePage:null;
  const [imageWidth,setImageWidth]=useState(Number(((image?.width||1200)*25.4/96).toFixed(2))),[imageHeight,setImageHeight]=useState(Number(((image?.height||1600)*25.4/96).toFixed(2)));
  const nativeImage=image?nativePrintGeometry(image.width||1200,image.height||1600,image.adaptation?.sourceWidth||image.generation?.sourceWidth||image.width||1200,image.adaptation?.sourceHeight||image.generation?.sourceHeight||image.height||1600,image.adaptation?.method==='cover'?'cover':'contain'):null;
  const printPpi=dpi==='original'?300:Number(dpi),autoWidth=(nativeImage?.width||0)*25.4/printPpi,autoHeight=(nativeImage?.height||0)*25.4/printPpi;
  const working=['saving','checking','downloading','importing'].includes(phase),canCmyk=!!w.capabilities?.cmyk||profiles.length>0;
  const selectedProfile=profiles.find(profile=>profile.id===profileId),needsPrintProfile=printing&&!selectedProfile,testProfile=printing&&selectedProfile&&!selectedProfile.custom;
  const needsPrintAck=printing&&!!report?.canExport&&report.warnings>0&&!ack;
  const settingsKey=JSON.stringify([format,color,scale,dpi,vectorize,printReady,customPrintSize,range,customRange,bleed,marks,blackText,profileId,bleedMode,safe,imageWidth,imageHeight,record?.revision]);
  useEffect(()=>{setReport(null);setProof(null);setVectorProof(null);setAck(false);setError('');setPhase(value=>value==='review'||value==='done'?'idle':value);},[settingsKey]);
  useEffect(()=>{const controller=new AbortController();w.api<PrintProfile[]>('/api/design/profiles','GET',undefined,controller.signal).then(list=>{setProfiles(list);setProfileId(id=>list.some(p=>p.id===id)?id:list.find(p=>p.id==='default'&&p.custom)?.id||'');}).catch(e=>{if(!controller.signal.aborted)setError(e.message);});return()=>controller.abort();},[w.api]);
  useEffect(()=>{if(phase==='review'){const target=vector&&vectorProof?vectorResult.current:checkResult.current;target?.scrollIntoView({block:'start'});target?.focus({preventScroll:true});}},[phase,report,vector,vectorProof]);
  function preset(value:'image'|'pdf'|'print'){
    setVectorize(false);setPrintReady(value==='print');setCustomPrintSize(false);setFormat(value==='image'?'png':'pdf');setColor('rgb');setDpi(value==='print'?'300':'original');
  }
  async function importProfile(file:File){
    setError('');setPhase('importing');
    try{
      if(!file.size||file.size>4*1024*1024)throw new Error('ICC 文件须在 4 MB 以内');
      const data=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(new Error('ICC 文件读取失败'));reader.readAsDataURL(file);});
      const imported=await w.api<PrintProfile>('/api/design/profiles','POST',{data,name:file.name.replace(/\.(icc|icm)$/i,'').slice(0,100)});
      setProfiles(await w.api<PrintProfile[]>('/api/design/profiles'));setProfileId(imported.id);setReport(null);setAck(false);w.notify('ICC 配置已验证并加入本机配置库。');
    }catch(e){setError(e instanceof Error?e.message:'ICC 导入失败');}finally{setPhase('idle');}
  }
  async function submit(checkOnly=false){
    if(working||w.locked)return;setError('');const sourceEndpoint=w.endpoint();
    if(needsPrintProfile){setError('请先选择或导入印刷方 ICC；保留原图 RGB 颜色可改用普通 PDF。');return;}
    try{
      const snapshot:{record:DesignRecord|null}={record:null};
      if(design){setPhase('saving');await w.operate(async()=>{snapshot.record=await w.save();});if(!snapshot.record)throw new Error('设计稿保存失败，请检查当前修改后重试');}
      const saved=snapshot.record;
      if(image?.demo){
        if(format!=='png')throw new Error('演示图片仅支持原图 PNG 下载');
        const a=document.createElement('a');a.href=image.url;a.download=`canvas-v${image.number}.png`;a.click();setPhase('done');return;
      }
      if(!saved&&!image)throw new Error('请先选择要下载的设计稿或图片');
      const selection=saved?vector||format!=='pdf'||range==='current'?{pageId:p!.id}:range==='custom'?{pageIds:parsePageRange(customRange,saved.document.pages.length).map(i=>saved.document.pages[i].id)}:{}:{};
      const body={format,colorSpace:vector?'rgb':color,scale:vector?1:scale,...(format==='pdf'&&vectorize?{vectorize:true}:{}),...(printReady?{printReady:true}:{}),...(!vector&&dpi!=='original'?{dpi:Number(dpi)}:{}),...(saved?{revision:saved.revision,...selection}:{imageId:image!.id,...(format==='pdf'&&(!printReady||customPrintSize)?{width:imageWidth,height:imageHeight,unit:'mm'}:{})}),...(printing?{print:{profileId,bleedMm:bleed,cropMarks:marks,bleedMode,safeMm:safe,blackText}}:{})};
      setPhase('checking');
      const checked=await w.api<ExportReport>(sourceEndpoint+(saved?'/export-check':'/export-image-check'),'POST',body);setReport(checked);
      setProof(printing?{endpoint:sourceEndpoint+(saved?'/export-preview':'/export-image-preview'),body,report:checked}:null);
      if(!checked.canExport){setPhase('review');return;}
      if(vector){const preview=await w.api<{dataUrl:string}>(sourceEndpoint+(saved?'/export-preview':'/export-image-preview'),'POST',body);setVectorProof(preview.dataUrl);}
      if(checkOnly||vector&&!ack||printing&&checked.warnings&&!ack){setPhase('review');return;}
      setPhase('downloading');
      await download(sourceEndpoint+(saved?'/export':'/export-image'),w.config!.token,{...body,acknowledgeWarnings:ack},`${title}-${color}.${format==='jpeg'?'jpg':format}`);
      setPhase('done');w.notify(testProfile?'测试用 CMYK PDF 已生成；正式印刷请使用印刷方提供的 ICC。':printReady?'打印 PDF 已生成，已按成品尺寸检查实际图片清晰度。':printing?'印刷 PDF 已通过文件检查并生成；请按印刷方要求打样确认颜色。':'文件已生成，内容来自本次保存的设计版本。');
    }catch(e){setError(e instanceof Error?e.message:'下载失败');setPhase('idle');}
  }
  function saveReport(){
    if(!report)return;
    const url=URL.createObjectURL(new Blob([JSON.stringify({title,checkedAt:new Date().toISOString(),...report},null,2)],{type:'application/json'}));
    const link=document.createElement('a');link.href=url;link.download=`${title}-${report.revision?`r${report.revision}`:'image'}-preflight.json`.replace(/[\\/]/g,'_');link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  const outputDpi=dpi==='original'?96*scale:Number(dpi),factor=p?.unit==='mm'?96/25.4:1;
  const pixelWidth=Math.round((p?.width||image?.width||0)*factor*outputDpi/96),pixelHeight=Math.round((p?.height||image?.height||0)*factor*outputDpi/96);
  return <Modal title="下载作品" eyebrow="DOWNLOAD ARTWORK" className="download-dialog" onClose={onClose}>
    <form className="download-form" onSubmit={e=>{e.preventDefault();submit();}}><div className="download-body">
    <div className="download-summary"><strong>{title}</strong><span>{design?`可编辑设计稿 · r${record.revision}`:'图片作品'} · {p?`${Number(p.width.toFixed(2))} × ${Number(p.height.toFixed(2))} ${p.unit}`:`${image?.width||'—'} × ${image?.height||'—'} px`}</span></div>
    <fieldset disabled={working||w.locked}>
      <div className="export-presets" aria-label="下载预设"><button type="button" aria-pressed={format!=='pdf'} onClick={()=>preset('image')}>线上图片</button><button type="button" aria-pressed={format==='pdf'&&!printing&&!printReady} disabled={image?.demo||!w.capabilities?.pdf} onClick={()=>preset('pdf')}>普通 PDF</button><button id="printPreset" type="button" aria-pressed={format==='pdf'&&(printing||printReady)} disabled={image?.demo||!w.capabilities?.pdf} onClick={()=>preset('print')}>打印 PDF</button></div>
      {printReady&&!printing&&<p id="printQualityHint" className="help">使用可用的原始高清素材，保留 RGB 颜色；按成品尺寸检查实际分辨率。独立文字和图形保留矢量，图片不做矢量描摹。</p>}
      {printing&&<section className="export-color-note" aria-label="PDF 色彩设置"><strong>{needsPrintProfile?'请选择印刷方 ICC':testProfile?'当前配置仅供技术测试':'按所选 ICC 转换颜色'}</strong><p>{needsPrintProfile?'CMYK 会转换原图颜色。没有印刷方配置时，可先下载 RGB PDF，交给接受 RGB 文件的印刷方处理。':testProfile?'内置验证配置不对应你的实际印刷条件，可能明显改变红色和暗部；仅用于测试，不应直接作为正式印刷文件。':'请确认所选 ICC 对应本次印刷设备与材料，并打样确认。导入成功仅表示配置可用。'}</p><div><button id="useRgbPdf" type="button" className="btn small" onClick={()=>preset(printReady?'print':'pdf')}>{printReady?'改用 RGB 打印 PDF':'改用普通 PDF · RGB'}</button><button type="button" className="btn small" id="importPrintProfile" onClick={()=>importFile.current?.click()}>导入印刷方 ICC</button></div></section>}
      {format==='pdf'&&!printing&&!vector&&!printReady&&<p id="pdfColorHint" className="help">RGB PDF 优先使用可用的高清原图。选择「保留原始像素」可避免导出时降采样；实际清晰度仍取决于原图像素和成品尺寸。不进行 CMYK 转换，可交给接受 RGB 文件的印刷方处理。</p>}
      <div className="field-pair"><label>文件格式<select id="downloadFormat" value={format} onChange={e=>{setFormat(e.target.value);setVectorize(false);setPrintReady(false);if(e.target.value!=='pdf'){setColor('rgb');setDpi('original');}}}><option value="png">PNG 图片</option><option value="jpeg" disabled={image?.demo}>JPG 图片</option><option value="pdf" disabled={image?.demo||!w.capabilities?.pdf}>PDF 文档</option><option value="svg" disabled={image?.demo}>SVG 矢量 Logo</option><option value="eps" disabled={image?.demo}>EPS 矢量 Logo</option><option value="ai" disabled={image?.demo}>AI 矢量 Logo · Illustrator 7 兼容</option></select></label><label>色彩模式<select id="downloadColor" value={vector?'rgb':color} disabled={vector} onChange={e=>{setColor(e.target.value);setDpi(e.target.value==='cmyk'||printReady?'300':'original');}}><option value="rgb">RGB · 保留颜色</option><option value="cmyk" disabled={format!=='pdf'||!canCmyk}>CMYK · 按印刷方 ICC 转换</option></select></label></div>
      {format==='pdf'&&!printing&&!printReady&&<label className="check-row"><input id="vectorPdf" type="checkbox" checked={vectorize} onChange={e=>setVectorize(e.target.checked)}/>矢量 Logo PDF · 描摹图片，文字转轮廓</label>}
      {design&&format==='pdf'&&!vector&&<label>导出页面<select id="downloadRange" value={range} onChange={e=>setRange(e.target.value)}><option value="all">整册 · {w.document!.pages.length} 页</option><option value="current">当前页 · 第 {w.document!.pages.indexOf(p!)+1} 页</option><option value="custom">自定义页码</option></select></label>}
      {design&&format==='pdf'&&!vector&&range==='custom'&&<label>页码范围<input id="downloadPageRange" placeholder="例如：1-3,5" value={customRange} onChange={e=>setCustomRange(e.target.value)} required/></label>}
      {!design&&format==='pdf'&&printReady&&<section className="print-size-summary" aria-label="打印尺寸"><p id="printSizeHint" className="help">打印素材约 {nativeImage?.width} × {nativeImage?.height} px；按 {printPpi} PPI 自动匹配成品 {autoWidth.toFixed(2)} × {autoHeight.toFixed(2)} mm，保持图片比例。打印店按此尺寸打印即可；放大需要更高像素的原图。</p><label className="check-row"><input id="customPrintSize" type="checkbox" checked={customPrintSize} onChange={e=>{setCustomPrintSize(e.target.checked);if(e.target.checked){setImageWidth(Number(autoWidth.toFixed(2)));setImageHeight(Number(autoHeight.toFixed(2)));}}}/>自定义打印尺寸</label></section>}
      {!design&&format==='pdf'&&(!printReady||customPrintSize)&&<div className="field-pair"><label>成品宽度 (mm)<input aria-label="成品宽度" type="number" step="any" min={1} max={5000} value={imageWidth} onChange={e=>setImageWidth(e.target.valueAsNumber)} required/></label><label>成品高度 (mm)<input aria-label="成品高度" type="number" step="any" min={1} max={5000} value={imageHeight} onChange={e=>setImageHeight(e.target.valueAsNumber)} required/></label></div>}
      {!vector&&<label>{format==='pdf'?'PDF 图片分辨率上限':'输出清晰度'}<select id="downloadDpi" value={dpi} disabled={image?.demo} onChange={e=>setDpi(e.target.value)}><option value="original" disabled={printing||printReady}>保留原始像素</option>{[72,96,150,300,600].map(n=><option key={n} value={n}>{n} PPI</option>)}</select></label>}
      {!vector&&format!=='pdf'&&dpi==='original'&&<label>图片缩放<select value={scale} disabled={image?.demo} onChange={e=>setScale(Number(e.target.value))}>{[1,2,3].map(n=><option key={n} value={n}>{n}×</option>)}</select></label>}
      {!vector&&format!=='pdf'&&<p className="help">{design?`当前第 ${w.document!.pages.indexOf(p!)+1} 页 · `:''}{pixelWidth} × {pixelHeight} px。多页下载请选择 PDF。</p>}
      {format==='pdf'&&!printing&&!canCmyk&&<button type="button" className="btn small" onClick={()=>importFile.current?.click()}>导入印刷 ICC 配置</button>}
      {printing&&<details className="print-options" open><summary>印刷设置</summary>
        <label>目标 ICC<select id="printProfile" value={profileId} required onChange={e=>setProfileId(e.target.value)}><option value="" disabled>请选择或导入印刷方 ICC</option>{profiles.map(profile=><option key={profile.id} value={profile.id}>{profile.name}{profile.custom?'':' · 仅技术测试'}</option>)}</select></label>
        <p className="help">{profiles.find(p=>p.id===profileId)?.description||'请导入印刷方提供的 ICC 配置。'}</p>
        <div className="field-pair"><label>四边出血 (mm)<input id="printBleed" type="number" min={0} max={20} step="any" value={bleed} onChange={e=>setBleed(e.target.valueAsNumber)} required/></label><label>单黑文字<select id="printBlackText" value={blackText} onChange={e=>setBlackText(e.target.value)}><option value="preserve">纯黑文字保持 K100</option><option value="convert">全部按 ICC 转换</option></select></label></div>
        <div className="field-pair"><label>出血内容<select id="printBleedMode" value={bleedMode} onChange={e=>setBleedMode(e.target.value)}><option value="objects">背景 + 已启用延展的对象</option><option value="background">仅页面背景</option></select></label><label>安全距离 (mm)<input id="printSafe" type="number" min={0} max={20} step="any" value={safe} onChange={e=>setSafe(e.target.valueAsNumber)} required/></label></div>
        <label className="check-row"><input id="printCropMarks" type="checkbox" checked={marks} onChange={e=>setMarks(e.target.checked)}/>添加裁切线</label>
        <p className="help">在对象属性中勾选延展贴边图片或色块；图片按原比例重新裁切，Logo 默认保持完整显示。检查后可预览裁切效果。输出为普通 CMYK PDF，尚未验证 PDF/X-4。</p>
      </details>}
      <p className="help">{vector?`仅导出当前页。图片会缩至最长边 768 px、最多 32 色后描摹；照片、渐变和细小文字可能失真。要保留原图细节，请选 PNG 或普通 PDF。${format==='ai'?'AI 使用旧版 Illustrator 7 兼容格式。':'独立文字转为轮廓，文件不依赖本机字体。'} 请先检查预览，确认轮廓与颜色。`:design?'先保存当前修改，再按该版本检查和下载。PDF 保留独立文字和图形。输出分辨率不会补充低清原图的细节。':'整图中的文字保持位图形式。JPG 有损压缩；普通 PDF 保留图片像素，放大不会增加细节。'}</p>
      {(p?.background==='transparent'||image?.transparency?.hasTransparency)&&<p id="transparentDownloadHint" className="help">{vector?'透明区域不绘制背景；柔和透明边缘会转换为实边。':format==='png'?'PNG 保留透明背景；预览中的棋盘格不会写入文件。':format==='jpeg'?'JPG 不支持透明背景，将使用白色底。':'PDF 保留独立文字；图形图片仍为位图，阅读器通常以白纸显示。'}</p>}
      {report&&<section ref={checkResult} tabIndex={-1} className="export-check" aria-label="下载检查结果"><strong>{report.canExport?'文件检查':'需要处理'} · {report.errors} 项错误 · {report.warnings} 项提示</strong><p>{report.pages.length} 页{report.revision?` · r${report.revision}`:''}{report.settings.dpi?` · ${report.settings.dpi} PPI`:''} · 字体：{report.font}</p>
        {report.pages.map(page=><p key={page.id}>第 {page.number} 页 · 成品 {(page.width*25.4/72).toFixed(2)} × {(page.height*25.4/72).toFixed(2)} mm{page.outputWidth?` · 含出血/标记 ${(page.outputWidth*25.4/72).toFixed(2)} × ${(page.outputHeight!*25.4/72).toFixed(2)} mm`:''}</p>)}
        {report.profile&&<p>ICC：{report.profile.name} · 校验 {report.profile.hash.slice(0,12)}</p>}
        {report.vector&&<p>矢量路径：{report.vector.pathCount} 条 · 已描摹图片：{report.vector.imageCount} 张 · 文字已转轮廓</p>}
        {report.issues.map((issue,i)=><p key={i} className={issue.severity} role={issue.severity==='error'?'alert':undefined}>{issue.pageId?`第 ${report.pages.find(p=>p.id===issue.pageId)?.number} 页 · `:''}{issue.message}{design&&issue.pageId&&<button type="button" className="text-button locate-issue" data-locate={issue.code} onClick={()=>onLocate(issue)}>定位{issue.objectId?'对象':issue.contentId?'内容':'页面'} ↗</button>}</p>)}
        <button id="savePreflight" type="button" className="text-button" onClick={saveReport}>导出检查报告 JSON</button>
      </section>}
      {vector&&vectorProof&&<section ref={vectorResult} tabIndex={-1} className="vector-proof" aria-label="矢量描摹预览"><strong>矢量描摹预览</strong><img id="vectorPreview" className="proof-canvas transparency-preview" src={vectorProof} alt="导出矢量路径的预览，请核对轮廓和颜色"/><label className="check-row"><input id="confirmVectorPreview" type="checkbox" checked={ack} onChange={e=>setAck(e.target.checked)}/>我已核对描摹后的轮廓与颜色</label></section>}
      {printing&&proof&&<PrintProof request={proof} api={w.api}/>}
    </fieldset></div>
    <fieldset className="download-footer" disabled={working||w.locked}>
      {error&&<p className="error" role="alert">{error}</p>}
      {printing&&report?.canExport&&report.warnings>0&&<label className="check-row print-confirmation"><input id="confirmPrintWarnings" type="checkbox" checked={ack} onChange={e=>setAck(e.target.checked)}/>我已核对 {report.warnings} 项印刷提示，按当前设置下载</label>}
      <div className="download-buttons"><button className="btn" type="button" id="checkExport" disabled={image?.demo||needsPrintProfile} onClick={()=>submit(true)}>检查文件</button><button id="downloadSubmit" className="btn primary" type={needsPrintProfile?'button':'submit'} onClick={needsPrintProfile?()=>importFile.current?.click():undefined} disabled={needsPrintAck} aria-describedby="exportStatus">{phase==='saving'?'正在保存…':phase==='checking'?'正在检查…':phase==='downloading'?'正在生成…':needsPrintProfile?'导入印刷方 ICC':needsPrintAck?'请先确认印刷提示':testProfile?'下载测试 PDF':phase==='done'?'再次下载':printReady?'下载打印 PDF':vector&&!ack?'预览并检查':'下载文件'}</button></div>
      <p id="exportStatus" className="export-status" role="status">{working?'正在处理，完成后会自动更新。':needsPrintProfile?'尚未选择印刷 ICC。请导入或选择配置，也可改用普通 PDF（RGB）。':report&&!report.canExport?'请先处理文件检查中的错误，再重新检查。':needsPrintAck?`检查完成，有 ${report!.warnings} 项印刷提示。请阅读检查结果并勾选确认后下载。`:phase==='done'?(testProfile?'测试文件已生成；正式印刷请使用印刷方 ICC 并打样确认。':printReady?'打印 PDF 已生成，请按文件中的成品尺寸打印。':'文件已生成并交给浏览器下载。'):phase==='review'?(vector&&!ack?'请核对矢量预览，勾选确认后下载。':'检查完成，可以下载文件。'):printing?'CMYK 按所选 ICC 转换颜色；请核对检查提示并打样确认。':printReady?'默认 300 PPI，自动匹配图片尺寸；清晰度不足时会指出所需像素。':''}</p>
    </fieldset></form>
    <input ref={importFile} id="iccFileInput" type="file" accept=".icc,.icm" hidden onChange={e=>{const file=e.target.files?.[0];if(file)importProfile(file);e.target.value='';}}/>
  </Modal>;
}
