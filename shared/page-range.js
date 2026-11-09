// Resolve user-facing page numbers in document order, independent of version IDs.
export function parsePageRange(value,pageCount){
  if(!Number.isInteger(pageCount)||pageCount<1||pageCount>20)throw new Error('页面数量无效');
  if(typeof value!=='string'||!value.trim()||value.length>200)throw new Error('请输入页码，例如 1-3,5');
  const selected=new Set();
  for(const part of value.replaceAll('，',',').split(',')){
    const match=part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if(!match)throw new Error('页码格式不正确，请使用 1-3,5 这样的格式');
    const first=Number(match[1]),last=Number(match[2]||match[1]);
    if(first<1||last<first||last>pageCount)throw new Error(`页码必须在 1-${pageCount} 范围内，区间需从小到大`);
    for(let n=first;n<=last;n++)selected.add(n-1);
  }
  return [...selected].sort((a,b)=>a-b);
}
