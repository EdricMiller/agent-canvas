'use client';

import {useState} from 'react';
import type {WorkspaceState} from '@/lib/use-workspace';
import {Modal} from './modal';

export function PaginationDialog({w,onClose}:{w:WorkspaceState;onClose:()=>void}){
  const [heading,setHeading]=useState('产品清单'),[rows,setRows]=useState(''),[columns,setColumns]=useState(1),[fontSize,setFontSize]=useState(12),[logoId,setLogoId]=useState(''),[error,setError]=useState('');
  const count=rows.split('\n').filter(line=>line.trim()).length,p=w.activePage||w.canvas;
  function submit(){
    setError('');
    try{
      const parsed=rows.split('\n').filter(line=>line.trim()).map((line,index)=>{
        const parts=line.split('|').map(s=>s.trim());
        if(parts.length>3||!parts[0])throw new Error(`第 ${index+1} 行格式有误，请填写“名称 | 值 | 说明”`);
        return {name:parts[0],value:parts[1]||'',description:parts[2]||'',status:'confirmed' as const};
      });
      if(!parsed.length||parsed.length>250)throw new Error('请输入 1 至 250 条内容');
      w.paginate({heading,rows:parsed,columns,fontSize,...(logoId?{logoId}:{})},onClose,setError);
    }catch(e){setError(e instanceof Error?e.message:'内容格式有误');}
  }
  return <Modal title="清单自动分页" eyebrow="FLOW YOUR CONTENT" onClose={onClose}>
    <p className="help">按 {p.width} × {p.height} {p.unit} 排版；整条内容放入同一栏，标题和 Logo 逐页重复。{w.document?'结果追加到整册末尾。':'将创建可编辑的多页设计稿。'}</p>
    <form onSubmit={e=>{e.preventDefault();submit();}}><fieldset disabled={w.locked}>
      <label>每页标题<input aria-label="分页标题" value={heading} onChange={e=>setHeading(e.target.value)} maxLength={200} required/></label>
      <label>条目内容 · {count} / 250<textarea id="paginationRows" rows={8} placeholder={'每行一条，例：\n拿铁 | 28 元 | 冰 / 热可选\n美式 | 22 元'} value={rows} onChange={e=>setRows(e.target.value)} required/></label>
      <div className="field-pair"><label>每页分栏<select aria-label="分页分栏" value={columns} onChange={e=>setColumns(Number(e.target.value))}>{[1,2,3].map(n=><option value={n} key={n}>{n} 栏</option>)}</select></label><label>正文字号 (pt)<input aria-label="分页字号" type="number" min={10} max={36} value={fontSize} onChange={e=>setFontSize(Number(e.target.value))} required/></label></div>
      <label>每页 Logo<select aria-label="分页 Logo" value={logoId} onChange={e=>setLogoId(e.target.value)}><option value="">不添加</option>{w.data.assets.map(asset=><option key={asset.id} value={asset.id}>{asset.name}</option>)}</select></label>
      <p className="help">适用于清单、菜单和价目表；输入内容按已核对处理。单条超出页面或超过整册 20 页时会提示调整。</p>
      {error&&<p className="error" role="alert">{error}</p>}
      <button id="paginationSubmit" className="btn primary full" type="submit">{w.busy?'正在排版…':w.document?'追加分页结果':'生成多页设计稿'}</button>
    </fieldset></form>
  </Modal>;
}
