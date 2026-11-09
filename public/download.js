const $=id=>document.getElementById(id);

export function initDownloadPanel({api,toast,context,token}){
  let current,capabilities,capabilityRequest,busy=false,unit='px';
  const fields=()=>({width:Number($('downloadWidth').value),height:Number($('downloadHeight').value),unit:$('downloadUnit').value});
  function options(){
    const pdf=$('downloadFormat').value==='pdf',cmyk=$('downloadColor').value==='cmyk';
    for(const option of $('downloadFormat').options)option.disabled=Boolean(current?.image.demo)&&option.value!=='png';
    $('downloadPage').hidden=!pdf;$('downloadScaleField').hidden=pdf;
    $('downloadColor').disabled=busy||!pdf;
    $('downloadColor').querySelector('[value="cmyk"]').disabled=!capabilities?.cmyk;
    if(!pdf)$('downloadColor').value='rgb';
    $('downloadProfile').hidden=!pdf||!cmyk;
    const profile=capabilities?.profile;
    $('downloadProfile').textContent=profile?`色彩配置：${profile.name}${profile.custom?'':'（内置验证配置）'}。请按印刷方要求使用对应色彩配置；当前文件不含出血和裁切标记。`:'CMYK 色彩配置暂不可用。';
    if(!current)return;
    const {image}=current,{width,height,unit}=fields(),scale=Number($('downloadScale').value);
    const valid=Number.isFinite(width)&&width>0&&Number.isFinite(height)&&height>0;
    const ppi=valid?(unit==='mm'?25.4:96)/Math.min(width/image.width,height/image.height):0;
    $('downloadQuality').classList.toggle('quality-warning',pdf&&ppi>0&&ppi<300);
    $('downloadQuality').textContent=image.demo?'演示图片仅提供原始 PNG 预览。真实作品可使用 JPG、PDF 和 CMYK 下载。':pdf?`${ppi?`当前图片有效分辨率约 ${Math.round(ppi)} PPI${ppi<300?'，低于 300 PPI 印刷检查预设':''}。`:''}转换为 PDF 会保留原图细节，原图中的文字仍是图片。`:`输出 ${Math.round(image.width*scale)} × ${Math.round(image.height*scale)} 像素。${scale===1?'保留原始图片尺寸。':'放大尺寸不会补充原图细节。'}`;
    if(image.demo)$('downloadScaleField').hidden=true;
    $('downloadSubmit').disabled=busy||(pdf&&(!valid||!capabilities?.pdf))||(pdf&&cmyk&&!capabilities?.cmyk);
  }
  for(const id of ['downloadFormat','downloadColor','downloadScale','downloadWidth','downloadHeight'])$(id).oninput=options;
  $('downloadUnit').onchange=()=>{
    const next=$('downloadUnit').value,factor=unit===next?1:unit==='px'?25.4/96:96/25.4;
    for(const id of ['downloadWidth','downloadHeight'])$(id).value=Number((Number($(id).value)*factor).toFixed(6));
    unit=next;options();
  };
  $('downloadForm').onsubmit=async event=>{
    event.preventDefault();if(busy||!current)return;
    const target=current,format=$('downloadFormat').value,colorSpace=format==='pdf'?$('downloadColor').value:'rgb';
    busy=true;$('downloadError').hidden=true;
    for(const element of $('downloadForm').elements)element.disabled=true;
    $('downloadSubmit').textContent='正在生成…';
    try{
      // Demo artwork already has a static PNG; it is never labelled as a real print file.
      if(target.image.demo){
        if(format!=='png')throw new Error('演示图片仅提供 PNG 预览下载，请选择真实作品使用 PDF 导出。');
        const a=document.createElement('a');a.href=target.image.url;a.download=`canvas-v${target.image.number}.png`;a.click();
      }else{
        const response=await fetch(`/api/sessions/${target.session.id}/design/export-image`,{method:'POST',headers:{'Content-Type':'application/json','X-Studio-Token':token()},body:JSON.stringify({imageId:target.image.id,format,colorSpace,scale:Number($('downloadScale').value),...(format==='pdf'?fields():{})})});
        if(!response.ok){const error=await response.json().catch(()=>({}));throw new Error(error.error||'文件生成失败');}
        const url=URL.createObjectURL(await response.blob()),a=document.createElement('a');a.href=url;a.download=`${target.session.title}-${colorSpace}.${format==='jpeg'?'jpg':format}`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
      }
      $('downloadDialog').close();toast('下载文件已生成。');
    }catch(error){$('downloadError').textContent=error.message;$('downloadError').hidden=false;}
    finally{busy=false;for(const element of $('downloadForm').elements)element.disabled=false;$('downloadSubmit').textContent='下载文件';options();}
  };
  return async function open(){
    if(busy)return;
    const {session,image}=context();if(!session||!image)return;
    current=structuredClone({session:{id:session.id,title:session.title},image});
    $('downloadThumbnail').src=image.url;$('downloadSourceName').textContent=image.kind==='upload'?`参考图 · ${image.label}`:`V${image.number} · ${session.title}`;
    $('downloadSourceSize').textContent=`原图 ${image.width} × ${image.height} 像素${image.demo?' · 演示图片':''}`;
    $('downloadFormat').value='png';$('downloadColor').value='rgb';$('downloadScale').value='1';
    $('downloadWidth').value=image.width;$('downloadHeight').value=image.height;$('downloadUnit').value=unit='px';
    $('downloadError').hidden=true;options();$('downloadDialog').showModal();
    try{capabilityRequest||=api('/api/design/capabilities');capabilities=await capabilityRequest;options();}
    catch(error){capabilityRequest=null;$('downloadError').textContent=error.message;$('downloadError').hidden=false;}
  };
}
