'use client';
import {useEffect,useRef,type ReactNode} from 'react';
import {Icon} from './icons';

export function Modal({title,eyebrow,children,onClose,wide=false,className=''}:{title:string;eyebrow?:string;children:ReactNode;onClose:()=>void;wide?:boolean;className?:string}){
  const ref=useRef<HTMLDialogElement>(null),close=useRef(onClose);close.current=onClose;
  useEffect(()=>{const dialog=ref.current!;dialog.showModal();const closed=()=>close.current();dialog.addEventListener('close',closed);return()=>{dialog.removeEventListener('close',closed);dialog.close();};},[]);
  return <dialog ref={ref} className={`modal ${wide?'wide':''} ${className}`} onClick={e=>{if(e.target===ref.current)onClose();}}><div className="modal-heading"><div>{eyebrow&&<span className="eyebrow">{eyebrow}</span>}<h2>{title}</h2></div><button className="icon-button" aria-label="关闭" onClick={onClose}><Icon name="close"/></button></div>{children}</dialog>;
}
