'use client';

import {useEffect,useRef} from 'react';
import type {WorkspaceState} from '@/lib/use-workspace';
// The model registry UI keeps its existing, independently tested implementation.
// @ts-expect-error The legacy controller is JavaScript without declarations.
import {initDebugPanel} from '../public/debug.js';
import {Icon} from './icons';

export function DebugDialog({w,onClose}:{w:WorkspaceState;onClose:()=>void}){
  const ref=useRef<HTMLDialogElement>(null),latest=useRef(w),close=useRef(onClose);latest.current=w;close.current=onClose;
  useEffect(()=>{
    const controller=initDebugPanel({api:(url:string,options:{method?:string;body?:string}={})=>latest.current.api(url,options.method||'GET',options.body?JSON.parse(options.body):undefined),onConfig:latest.current.setConfig,toast:latest.current.notify});
    controller.open();
    const dialog=ref.current!,closed=()=>close.current();dialog.addEventListener('close',closed);
    return()=>{dialog.removeEventListener('close',closed);dialog.close();};
  },[]);
  return <dialog ref={ref} id="debugDialog" className="modal wide debug-dialog"><button id="debugNav" hidden/><button id="debugButton" hidden/><div className="modal-heading"><div><span className="eyebrow">MODEL STUDIO</span><h2 id="debugTitle">模型设置</h2></div><button className="icon-button" aria-label="关闭" onClick={onClose}><Icon name="close"/></button></div><p className="help">独立选择对话与生图的服务和模型，配置继续保存在本机。</p><div className="debug-tabs" role="tablist" aria-label="调试设置"><button id="debugRoutesTab" role="tab" aria-controls="debugRoutes" aria-selected="true" data-debug-tab="routes">调用路由</button><button id="debugProvidersTab" role="tab" aria-controls="debugProviders" aria-selected="false" tabIndex={-1} data-debug-tab="providers">中转站</button><button id="debugModelsTab" role="tab" aria-controls="debugModels" aria-selected="false" tabIndex={-1} data-debug-tab="models">模型库</button></div><p id="debugNotice" className="debug-notice" role="status" hidden/><p id="debugError" className="debug-error" role="alert" hidden/><div id="debugContent"/></dialog>;
}
