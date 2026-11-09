'use client';

import {useState} from 'react';
import type {WorkspaceState} from '@/lib/use-workspace';

export function SaveStatus({w}:{w:WorkspaceState}){
  const text=w.conflict?'同步已暂停':w.saving?'正在保存…':w.saveError?'保存未完成':w.dirty?'等待自动保存…':'已保存';
  return <span id="autoSaveStatus" role="status" className={`save-state ${w.conflict||w.saveError?'save-failed':w.dirty?'unsaved':''}`} title={w.dirty?w.localState==='saved'?'当前修改已在本机保留':w.localState==='writing'?'正在保留本机草稿':'修改尚未同步':w.data.design?`保存于 ${new Date(w.data.design.updatedAt).toLocaleString('zh-CN')}`:undefined}>{text}</span>;
}

export function DraftNotices({w}:{w:WorkspaceState}){
  const [chosen,setChosen]=useState(''),draft=w.recovery.find(d=>d.id===chosen)||w.recovery[0];
  const backup=w.localState==='saved'?'当前草稿已在本机保留。':w.localState==='writing'?'正在保留本机草稿。':'当前修改仍保留在此窗口。';
  return <div className="draft-notices">
    {draft&&<section className="draft-notice recovery-notice" aria-label="本机草稿恢复"><div className="draft-notice-copy"><strong>发现未同步的本机草稿</strong><p>{draft.snapshot.document.title||'未命名设计稿'} · {new Date(draft.updatedAt).toLocaleString('zh-CN')} · {draft.snapshot.document.pages.length} 页</p>{draft.baseRevision!==w.data.design?.revision&&<p>保存的设计已有更新。恢复后会保留两份内容，暂停自动同步。</p>}{w.recovery.length>1&&<select aria-label="选择要恢复的草稿" value={draft.id} onChange={e=>setChosen(e.target.value)}>{w.recovery.map(item=><option key={item.id} value={item.id}>{new Date(item.updatedAt).toLocaleString('zh-CN')} · {item.snapshot.document.title||'未命名设计稿'}</option>)}</select>}</div><div className="draft-notice-actions"><button id="recoverLocalDraft" className="btn small" disabled={w.locked} onClick={()=>w.recoverDraft(draft)}>恢复草稿</button><button className="text-button" disabled={w.locked} onClick={()=>w.discardDraft(draft)}>舍弃此草稿</button></div></section>}
    {w.conflict?<section className="draft-notice conflict" role="alert"><div className="draft-notice-copy"><strong>其他窗口已更新，自动保存已暂停</strong><p>{backup}重新载入前会保留本机草稿，再查看最新设计。</p></div><div className="draft-notice-actions"><button className="btn small" onClick={w.downloadDraft}>下载草稿备份</button><button className="text-button" onClick={w.reload} disabled={w.busy}>重新载入</button></div></section>:w.saveError&&<section className="draft-notice save-error" role="alert"><div className="draft-notice-copy"><strong>保存未完成 · {w.saveError}</strong><p>{backup}可以继续编辑，网络恢复后会重试。</p></div><div className="draft-notice-actions"><button id="retrySave" className="btn small" disabled={w.locked||w.saving} onClick={()=>w.operate(async()=>{await w.save();})}>{w.saving?'正在重试…':'重试保存'}</button><button className="text-button" onClick={w.downloadDraft}>下载草稿备份</button></div></section>}
    {w.localState==='error'&&<section className="draft-notice local-draft-error" role="alert"><div className="draft-notice-copy"><strong>无法保留本机草稿</strong><p>浏览器存储可能不可用。请及时保存，或下载草稿备份。</p></div>{w.document&&<button className="btn small" onClick={w.downloadDraft}>下载草稿备份</button>}</section>}
  </div>;
}
