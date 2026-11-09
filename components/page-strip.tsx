'use client';

import type {WorkspaceState} from '@/lib/use-workspace';
import {MAX_PAGES} from '@/shared/design-pages.js';

export function PageStrip({w,onPaginate}:{w:WorkspaceState;onPaginate:()=>void}){
  const pages=w.document?.pages||[],index=pages.findIndex(p=>p.id===w.activePage?.id);
  return <nav className="page-strip" aria-label="设计页面">
    <div className="page-strip-heading"><strong>页面 <span>{pages.length} / {MAX_PAGES}</span></strong><div className="page-tools">
      <button id="paginateDesign" disabled={w.locked||!w.ready||!w.session||pages.length>=MAX_PAGES} onClick={onPaginate}>清单自动分页</button>
      {!!pages.length&&<><button aria-label="新增页面" disabled={w.locked||!w.ready||!w.session||pages.length>=MAX_PAGES} onClick={()=>w.pageOperation('add')}>＋ 新增</button><button aria-label="复制当前页面" disabled={w.locked||!w.ready||!w.session||pages.length>=MAX_PAGES} onClick={()=>w.pageOperation('duplicate')}>复制</button><button aria-label="当前页前移" disabled={w.locked||index<=0} onClick={()=>w.pageOperation('move',index-1)}>←</button><button aria-label="当前页后移" disabled={w.locked||index===pages.length-1} onClick={()=>w.pageOperation('move',index+1)}>→</button><button aria-label="删除当前页面" disabled={w.locked||pages.length<=1} onClick={()=>w.pageOperation('delete')}>删除</button></>}
    </div></div>
    {!!pages.length&&<div className="page-list">{pages.map((page,i)=><button key={page.id} data-page={page.id} aria-label={`第 ${i+1} 页：${page.name}`} aria-current={page.id===w.activePage?.id?'page':undefined} onClick={()=>w.selectPage(page.id)}><span className="page-number">{i+1}</span><span><strong>{page.name}</strong><small>{page.objects.length} 个对象 · {page.width.toFixed(0)} × {page.height.toFixed(0)} {page.unit}</small></span></button>)}</div>}
  </nav>;
}
