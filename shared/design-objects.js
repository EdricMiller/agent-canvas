// Object arrays are painted bottom to top. Keep editing operations independent
// of rendering and storage so history and autosave receive one complete change.
export function lockedBinding(document,bindingId){
  return !!bindingId&&document.pages.some(p=>p.objects.some(o=>o.type==='text'&&o.bindingId===bindingId&&o.locked));
}

export function changeObject(input,pageId,objectId,operation,newId=()=>crypto.randomUUID()){
  const document=structuredClone(input),page=document.pages.find(p=>p.id===pageId);
  const index=page?.objects.findIndex(o=>o.id===objectId)??-1;
  if(index<0)throw new Error('设计对象不存在');
  const object=page.objects[index];let selectedId=object.id;
  if(operation.type==='lock')object.locked=operation.value;
  else if(operation.type==='visibility')object.hidden=operation.value;
  else if(operation.type==='duplicate'){
    if(page.objects.length>=300)throw new Error('每页最多 300 个对象');
    const field=object.type==='text'&&document.content?.find(f=>f.id===object.bindingId);
    if(field&&document.content.length>=1000)throw new Error('整册最多 1000 项内容');
    const copy=structuredClone(object),offset=page.unit==='mm'?2:12;
    copy.id=newId();delete copy.locked;delete copy.hidden;
    copy.x=Math.max(0,Math.min(page.width-copy.width,copy.x+offset));
    copy.y=Math.max(0,Math.min(page.height-copy.height,copy.y+offset));
    if(field){const cloned={...field,id:newId()};document.content.push(cloned);copy.bindingId=cloned.id;}
    page.objects.splice(index+1,0,copy);selectedId=copy.id;
  }else{
    if(object.locked)throw new Error('对象已锁定，请先解锁');
    if(operation.type==='replace'){
      if(object.type!=='image')throw new Error('只能替换图片对象');
      object.assetId=operation.assetId;
    }else if(operation.type==='order'){
      const target=operation.direction==='front'?page.objects.length-1:operation.direction==='back'?0:operation.direction==='forward'?Math.min(index+1,page.objects.length-1):Math.max(0,index-1);
      page.objects.splice(index,1);page.objects.splice(target,0,object);
    }else throw new Error('不支持的对象操作');
  }
  return {document,selectedId};
}

export function assertLockedObjectsUnchanged(before,after){
  for(const page of before.pages)for(const object of page.objects)if(object.locked){
    const next=after.pages.find(p=>p.id===page.id)?.objects.find(o=>o.id===object.id);
    // Compare keys independently of property order in a tool's JSON output.
    if(!next||new Set([...Object.keys(object),...Object.keys(next)]).size!==Object.keys(object).length||Object.keys(object).some(key=>object[key]!==next[key]))throw new Error('对象已锁定，不能由 AI 修改或删除；请用户先在对象面板解锁');
  }
}
