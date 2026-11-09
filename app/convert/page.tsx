'use client';

import {useEffect,useState} from 'react';
import {request} from '@/lib/api';
import styles from './page.module.css';

const MAX_FILE_BYTES=120*1024*1024;
type Size={width:number;height:number};

export default function ConvertPage(){
  const [file,setFile]=useState<File|null>(null),[size,setSize]=useState<Size|null>(null);
  const [preview,setPreview]=useState(''),[widthMm,setWidthMm]=useState('');
  const [error,setError]=useState(''),[working,setWorking]=useState(false);
  useEffect(()=>{
    if(!file)return;
    const url=URL.createObjectURL(file),image=new window.Image();
    setPreview(url);setSize(null);setWidthMm('');
    image.onload=()=>{
      const width=image.naturalWidth,height=image.naturalHeight;
      if(!width||!height){setError('无法读取图片尺寸');return;}
      const scale=Math.min(1,5000/(Math.max(width,height)*25.4/96));
      setSize({width,height});setWidthMm((width*25.4/96*scale).toFixed(2));
    };
    image.onerror=()=>setError('无法读取图片，请选择 PNG、JPG 或 WebP');
    image.src=url;
    return ()=>{image.onload=null;image.onerror=null;URL.revokeObjectURL(url);};
  },[file]);
  const physicalWidth=Number(widthMm),physicalHeight=size&&physicalWidth>0?physicalWidth*size.height/size.width:0;
  const valid=!!file&&!!size&&Number.isFinite(physicalWidth)&&physicalWidth>0&&physicalWidth<=5000&&physicalHeight>0&&physicalHeight<=5000;
  function choose(next:File|undefined){
    setError('');setFile(null);setPreview('');setSize(null);
    if(!next)return;
    if(next.size>MAX_FILE_BYTES){setError('图片不能超过 120 MB');return;}
    if(!/\.(png|jpe?g|webp)$/i.test(next.name)){setError('请选择 PNG、JPG 或 WebP 图片');return;}
    setFile(next);
  }
  async function convert(){
    if(!valid||!file)return;
    setWorking(true);setError('');
    try{
      const {token}=await request<{token:string}>('/api/config');
      const response=await fetch(`/api/tools/image-to-pdf?widthMm=${encodeURIComponent(widthMm)}`,{method:'POST',headers:{'Content-Type':'application/octet-stream','X-Studio-Token':token},body:file});
      if(!response.ok){const detail=await response.json().catch(()=>({error:'转换失败'}));throw new Error(detail.error||'转换失败');}
      const url=URL.createObjectURL(await response.blob()),link=document.createElement('a');
      link.href=url;link.download=`${file.name.replace(/\.[^.]+$/,'').replace(/[\\/:*?"<>|]/g,'_')}-${Math.round(physicalWidth)}x${Math.round(physicalHeight)}mm.pdf`;
      link.click();setTimeout(()=>URL.revokeObjectURL(url),60_000);
    }catch(cause){setError(cause instanceof Error?cause.message:'转换失败');}
    finally{setWorking(false);}
  }
  return <div className={styles.page}>
    <header className={styles.header}><a className={styles.brand} href="/">画语 <span>Canvas</span></a><a className={styles.back} href="/">返回创作空间</a></header>
    <main className={styles.main}>
      <div className={styles.intro}><span className={styles.eyebrow}>IMAGE TO PDF</span><h1>图片转 PDF</h1><p>上传图片，设置成品宽度，下载保留原始像素的 PDF。整个过程不调用生图模型。</p></div>
      <div className={styles.card}>
        <label className={styles.upload} htmlFor="convertImageInput"><strong>{file?file.name:'选择或拖入图片'}</strong><span>PNG、JPG、WebP · 最大 120 MB</span><input id="convertImageInput" type="file" accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp" disabled={working} onChange={event=>choose(event.target.files?.[0])}/></label>
        {size&&<><div className={styles.preview}>{preview&&<img src={preview} alt="待转换图片预览"/>}</div><div className={styles.info}><span>图片像素</span><strong>{size.width.toLocaleString()} × {size.height.toLocaleString()} px</strong></div><label className={styles.field}>成品宽度（毫米）<input id="convertWidthMm" type="number" min="0.01" max="5000" step="0.01" value={widthMm} disabled={working} onChange={event=>setWidthMm(event.target.value)}/></label><div className={styles.info}><span>成品高度（按原图比例）</span><strong>{physicalHeight>0?`${physicalHeight.toFixed(2)} mm`:'—'}</strong></div><p className={styles.note}>PDF 内嵌原图像素，不裁切、不拉伸。改变成品尺寸会改变打印时的像素密度，不会增加图片细节。</p><button id="convertPdfButton" className={styles.submit} type="button" disabled={!valid||working} onClick={convert}>{working?'正在转换…':'转换并下载 PDF'}</button></>}
        {error&&<p className={styles.error} role="alert">{error}</p>}
      </div>
    </main>
  </div>;
}
