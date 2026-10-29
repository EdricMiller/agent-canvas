// Explicit opt-in: two image calls and conversation calls incur provider charges.
if(process.env.LIVE_SMOKE!=='1')throw new Error('Set LIVE_SMOKE=1 to authorize paid live verification');
const base=process.env.STUDIO_URL||'http://127.0.0.1:4320';
const config=await(await fetch(base+'/api/config')).json();
if(config.mode!=='live')throw new Error('Expected live mode');
const request=async(url,method='GET',body)=>{const r=await fetch(base+url,{method,headers:{'Content-Type':'application/json','X-Studio-Token':config.token},body:body?JSON.stringify(body):undefined});const d=await r.json();if(!r.ok)throw new Error(d.error);return d;};
const session=process.env.LIVE_SESSION_ID?await request(`/api/sessions/${process.env.LIVE_SESSION_ID}`):await request('/api/sessions','POST');
await request(`/api/sessions/${session.id}`,'PATCH',{skillId:'editorial'});
console.log(JSON.stringify({sessionId:session.id}));
async function turn(text){
 await request(`/api/sessions/${session.id}/turns`,'POST',{text,requestId:crypto.randomUUID()});
 let last=0;
 for(let n=0;n<155;n++){
  await new Promise(r=>setTimeout(r,2000));const s=await request(`/api/sessions/${session.id}`);
  if(s.job.events.length!==last){last=s.job.events.length;console.log(JSON.stringify({status:s.job.status,events:s.job.events.map(e=>e.type),versions:s.versions.length}));}
  if(s.job.status!=='running'){console.log(JSON.stringify({status:s.job.status,reply:s.messages.at(-1).text,versions:s.versions.map(v=>({id:v.id,number:v.number,parentId:v.parentId,width:v.width,height:v.height})),error:s.job.error}));return s;}
 }
 throw new Error('Live test timed out');
}
let s=session.versions.length?session:await turn('请创作一张简洁的陶瓷花瓶杂志风图片：奶油色背景，一束橄榄枝，柔和侧光，大片留白，不要文字。读取当前技能参考资料，公布步骤，只调用一次 render_image，完成后直接交付。');
if(s.job?.status!=='completed'||s.versions.length!==1)throw new Error('Generation not completed');
s=await turn('基于选中的第一版图片，把背景改成淡紫色，保留花瓶和橄榄枝。只调用一次 render_image，完成后直接交付。');
if(s.job.status!=='completed'||s.versions.length!==2||s.versions[1].parentId!==s.versions[0].id)throw new Error('Edit lineage failed');
await request(`/api/sessions/${session.id}`,'PATCH',{title:'橄榄与陶 · 杂志风创作'});
console.log('PASS: real Agents SDK planning, Skill reference, image generation, image edit and persistent lineage.');
