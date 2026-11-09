'use client';

import {useEffect,useState} from 'react';
import type {WorkspaceState} from '@/lib/use-workspace';
import type {ExportReport,PrintPreview} from '@/lib/types';

export type ProofRequest={endpoint:string;body:Record<string,unknown>;report:ExportReport};

export function PrintProof({request,api}:{request:ProofRequest;api:WorkspaceState['api']}){
  const [pageId,setPageId]=useState(request.report.pages[0].id),[preview,setPreview]=useState<PrintPreview|null>(null),[error,setError]=useState(''),[guides,setGuides]=useState(true),[retry,setRetry]=useState(0);
  const selected=request.report.pages.find(p=>p.id===pageId)||request.report.pages[0];
  useEffect(()=>{
    const controller=new AbortController();setPreview(null);setError('');
    api<PrintPreview>(request.endpoint,'POST',{...request.body,previewPageId:selected.id},controller.signal).then(value=>{if(!controller.signal.aborted)setPreview(value);}).catch(e=>{if(!controller.signal.aborted)setError(e.message);});
    return()=>controller.abort();
  },[request,selected.id,api,retry]);
  const g=preview?.geometry;
  return <section className="print-proof" aria-label="印刷裁切预览">
    <div className="proof-heading"><strong>裁切预览</strong><select id="proofPage" aria-label="预览页码" value={selected.id} onChange={e=>setPageId(e.target.value)}>{request.report.pages.map(p=><option key={p.id} value={p.id}>第 {p.number} 页 · {p.name}</option>)}</select></div>
    {preview&&g?<svg id="printProof" className="proof-canvas" viewBox={`0 0 ${g.width} ${g.height}`} role="img" aria-label={`第 ${selected.number} 页裁切预览`}>
      <rect width={g.width} height={g.height} fill="#ffffff"/>
      <image href={preview.dataUrl} width={g.width} height={g.height}/>
      {guides&&<g fill="none" strokeWidth={1} vectorEffect="non-scaling-stroke">
        <rect data-guide="bleed" x={g.marks} y={g.marks} width={g.trimWidth+2*g.bleed} height={g.trimHeight+2*g.bleed} stroke="#d96d83" strokeDasharray="6 3" vectorEffect="non-scaling-stroke"/>
        <rect data-guide="trim" x={g.offset} y={g.offset} width={g.trimWidth} height={g.trimHeight} stroke="#6a67c4" vectorEffect="non-scaling-stroke"/>
        {g.safe>0&&g.trimWidth>2*g.safe&&g.trimHeight>2*g.safe&&<rect data-guide="safe" x={g.offset+g.safe} y={g.offset+g.safe} width={g.trimWidth-2*g.safe} height={g.trimHeight-2*g.safe} stroke="#429779" strokeDasharray="3 3" vectorEffect="non-scaling-stroke"/>}
      </g>}
    </svg>:error?<p className="error" role="alert">{error}<button type="button" className="text-button" onClick={()=>setRetry(n=>n+1)}>重新加载</button></p>:<p className="help" role="status">正在生成裁切预览…</p>}
    <label className="check-row"><input id="proofGuides" type="checkbox" checked={guides} onChange={e=>setGuides(e.target.checked)}/>显示辅助线（不写入下载文件）</label>
    {guides&&<div className="proof-legend"><span className="trim">成品线</span><span className="bleed">出血线</span><span className="safe">安全区域</span></div>}
    <p className="help">用于核对延展、裁切和主体位置；屏幕显示为 RGB，不是印刷色彩软打样。裁切线按下载设置单独输出。</p>
  </section>;
}
