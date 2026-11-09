export const MAX_PAGES=20;

export function findPage(document,pageId){
  const page=pageId?document.pages.find(p=>p.id===pageId):document.pages[0];
  if(!page)throw new Error('页面不存在，请重新选择');
  return page;
}

// These pure operations are shared by the browser and server. They never mutate
// the input and keep object/content IDs unique across the complete document.
export function changePages(input,operation,newId=()=>crypto.randomUUID()){
  const document=structuredClone(input),page=findPage(document,operation.pageId);
  const index=document.pages.indexOf(page);
  if(['add','duplicate'].includes(operation.type)&&document.pages.length>=MAX_PAGES)throw new Error(`最多支持 ${MAX_PAGES} 页`);
  let selectedId=page.id;
  if(operation.type==='add'){
    const next={...page,id:newId(),name:'新页面',objects:[]};
    document.pages.splice(index+1,0,next);selectedId=next.id;
  }else if(operation.type==='duplicate'){
    const next=structuredClone(page);next.id=newId();next.name=`${page.name.slice(0,95)} 副本`;
    const fields=new Map();
    for(const object of next.objects){
      object.id=newId();
      if(object.type==='text'&&object.bindingId){
        if(!fields.has(object.bindingId)){
          const original=document.content?.find(f=>f.id===object.bindingId);
          if(!original)throw new Error('文字绑定的内容不存在');
          const copied={...original,id:newId()};fields.set(original.id,copied);
        }
        object.bindingId=fields.get(object.bindingId).id;
      }
    }
    if(fields.size)document.content.push(...fields.values());
    document.pages.splice(index+1,0,next);selectedId=next.id;
  }else if(operation.type==='delete'){
    if(document.pages.length===1)throw new Error('至少保留一页');
    document.pages.splice(index,1);
    // Remove only fields owned exclusively by the deleted page. Unplaced
    // source content and fields shared with other pages remain available.
    const deleted=new Set(page.objects.filter(o=>o.type==='text').map(o=>o.bindingId).filter(Boolean));
    const remaining=new Set(document.pages.flatMap(p=>p.objects.filter(o=>o.type==='text').map(o=>o.bindingId)));
    if(document.content)document.content=document.content.filter(f=>!deleted.has(f.id)||remaining.has(f.id));
    selectedId=document.pages[Math.min(index,document.pages.length-1)].id;
  }else if(operation.type==='move'){
    if(!Number.isInteger(operation.toIndex)||operation.toIndex<0||operation.toIndex>=document.pages.length)throw new Error('页面目标位置无效');
    document.pages.splice(index,1);document.pages.splice(operation.toIndex,0,page);
  }else throw new Error('不支持的页面操作');
  return {document,selectedId};
}
