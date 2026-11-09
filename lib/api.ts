export class ApiError extends Error{
  constructor(message:string,public status:number){super(message);}
}
export async function request<T>(url:string,token?:string,method='GET',body?:unknown,signal?:AbortSignal):Promise<T>{
  const response=await fetch(url,{method,cache:'no-store',signal,headers:{'Content-Type':'application/json',...(token?{'X-Studio-Token':token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  if(!response.ok){const error=await response.json().catch(()=>({}));throw new ApiError(error.error||`请求失败（${response.status}）`,response.status);}
  return response.json();
}
export async function download(url:string,token:string,body:unknown,filename:string){
  const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','X-Studio-Token':token},body:JSON.stringify(body)});
  if(!response.ok){const error=await response.json().catch(()=>({}));throw new ApiError(error.error||'下载失败',response.status);}
  const blobUrl=URL.createObjectURL(await response.blob());
  const a=document.createElement('a');a.href=blobUrl;
  const encoded=response.headers.get('Content-Disposition')?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  let name=filename;try{if(encoded)name=decodeURIComponent(encoded);}catch{}
  a.download=name.replace(/[\\/]/g,'_');a.click();setTimeout(()=>URL.revokeObjectURL(blobUrl),1000);
}
export function stored(key:string){try{return localStorage.getItem(key);}catch{return null;}}
export function remember(key:string,value:string){try{localStorage.setItem(key,value);}catch{}}
