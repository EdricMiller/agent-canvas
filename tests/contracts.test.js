import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {createApp} from '../server/app.js';
import {Store} from '../server/store.js';
import {Skills} from '../server/skills.js';
import {loadCredentials} from '../server/config.js';
import {DockerSandboxClient, UnixLocalSandboxClient} from '@openai/agents/sandbox/local';
import {runSkillScript} from '../server/skill-runner.js';
import {syncProduct} from '../server/product.js';
const root=path.resolve(import.meta.dirname,'..');
async function fixture(t,execute,extra={}){
 const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'canvas-test-'));
 const instance=createApp({root,dataDir,demo:true,maxImages:2,agentModel:'test',imageModel:'test',...extra},{execute});
 const server=await new Promise((resolve,reject)=>{const s=instance.app.listen(0,'127.0.0.1');s.once('listening',()=>resolve(s));s.once('error',reject);});
 t.after(()=>{instance.shutdown();server.closeAllConnections();server.close();fs.rmSync(dataDir,{recursive:true,force:true});});
 const base=`http://127.0.0.1:${server.address().port}`;
 const config=await(await fetch(base+'/api/config')).json();
 const req=async(url,method='GET',body,headers={})=>{const response=await fetch(base+url,{method,headers:{'Content-Type':'application/json','X-Studio-Token':config.token,...headers},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,data:await response.json()};};
 const wait=async(id)=>{for(let i=0;i<80;i++){const {data}=await req(`/api/sessions/${id}`);if(data.job?.status!=='running')return data;await new Promise(r=>setTimeout(r,30));}throw new Error('job did not finish');};
 return {...instance,req,wait,base,dataDir};
}
test('turns persist skill, image lineage, dedupe and restored conversations',async t=>{
 const f=await fixture(t),{data:s}=await f.req('/api/sessions','POST');
 assert.equal((await f.req(`/api/sessions/${s.id}`,'PATCH',{skillId:'watercolor'})).status,200);
 const id=randomUUID();assert.equal((await f.req(`/api/sessions/${s.id}/turns`,'POST',{text:'画一幅水彩',requestId:id})).status,202);
 assert.equal((await f.req(`/api/sessions/${s.id}/turns`,'POST',{text:'another',requestId:randomUUID()})).status,409);
 assert.equal((await f.req(`/api/sessions/${s.id}`,'PATCH',{skillId:null})).status,409);
 let done=await f.wait(s.id);assert.equal(done.job.status,'completed');assert.equal(done.versions[0].skillId,'watercolor');assert.equal(done.versions[0].demo,true);assert.equal(done.messages.length,2);
 assert.equal((await f.req(`/api/sessions/${s.id}/turns`,'POST',{text:'画一幅水彩',requestId:id})).data.duplicate,true);
 const source=done.selectedId;
 await f.req(`/api/sessions/${s.id}/turns`,'POST',{text:'再修改',requestId:randomUUID()});done=await f.wait(s.id);assert.equal(done.versions[1].parentId,source);
 await f.req(`/api/sessions/${s.id}`,'PATCH',{selectedId:source});
 await f.req(`/api/sessions/${s.id}/turns`,'POST',{text:'从第一版分支',requestId:randomUUID()});done=await f.wait(s.id);assert.equal(done.versions[2].parentId,source);
 const restored=new Store(f.dataDir).get(s.id);assert.equal(restored.messages.length,6);assert.equal(restored.versions.length,3);
});
test('cancellation does not silently create another image',async t=>{
 const f=await fixture(t),{data:s}=await f.req('/api/sessions','POST');
 await f.req(`/api/sessions/${s.id}/turns`,'POST',{text:'create',requestId:randomUUID()});
 await f.req(`/api/sessions/${s.id}/cancel`,'POST');
 const done=await f.wait(s.id);assert.equal(done.job.status,'cancelled');assert.equal(done.versions.length,0);
});
test('upload is decoded; sessions cannot select each other’s images',async t=>{
 const f=await fixture(t),{data:s}=await f.req('/api/sessions','POST'),{data:other}=await f.req('/api/sessions','POST');
 const bytes=await sharp({create:{width:40,height:30,channels:3,background:'#abc'}}).png().toBuffer();
 const {data:upload,status}=await f.req(`/api/sessions/${s.id}/upload`,'POST',{name:'test.png',data:'data:image/png;base64,'+bytes.toString('base64')});
 assert.equal(status,201);assert.equal(upload.version.width,40);
 assert.equal((await f.req(`/api/sessions/${other.id}`,'PATCH',{selectedId:upload.version.id})).status,400);
 assert.equal((await f.req(`/api/sessions/${s.id}/upload`,'POST',{name:'bad.png',data:'data:image/png;base64,SGVsbG8='})).status,400);
 assert.equal((await f.req(`/api/sessions/${s.id}/upload`,'POST',{name:'x.svg',data:'data:image/svg+xml;base64,AAAA'})).status,400);
});
test('references become message attachments after submission and preserve history across restart',async t=>{
 let executedIds;
 const f=await fixture(t,async({session,job})=>{executedIds=[...job.referenceIds];assert.deepEqual(session.referenceIds,[]);return '已同时读取参考图。';}),{data:s}=await f.req('/api/sessions','POST');
 const url=`/api/sessions/${s.id}`;
 await f.req(url,'PATCH',{skillId:'menu-design'});
 const bytes=await sharp({create:{width:40,height:30,channels:3,background:'#abc'}}).png().toBuffer();
 const upload=async name=>(await f.req(url+'/upload','POST',{name,data:'data:image/png;base64,'+bytes.toString('base64')})).data;
 const first=await upload('菜单明细.png'),second=await upload('Logo.png');
 const ids=[first.version.id,second.version.id];
 assert.deepEqual(second.session.referenceIds,ids);
 assert.deepEqual((await f.req(url,'PATCH',{selectedId:ids[0]})).data.referenceIds,ids,'previewing a reference preserves the others');
 const generated=f.store.addImage(f.store.get(s.id),bytes,{kind:'generated',demo:false,parentId:ids[0]});
 assert.equal(generated.number,1,'references do not consume generated version numbers');
 assert.deepEqual(f.store.get(s.id).referenceIds,ids,'generated output does not replace references');
 assert.deepEqual(new Store(f.dataDir).get(s.id).referenceIds,ids);
 const turn=await f.req(url+'/turns','POST',{text:'第一张是菜单，第二张是 Logo',requestId:randomUUID()});
 assert.equal(turn.status,202);
 assert.deepEqual(turn.data.session.referenceIds,[],'accepted submission clears draft references immediately');
 const done=await f.wait(s.id);
 assert.deepEqual(executedIds,ids,'the running task uses the attachment snapshot');
 assert.deepEqual(done.messages.find(m=>m.role==='user').referenceIds,ids);
 assert.deepEqual(done.job.referenceIds,ids);
 const restored=new Store(f.dataDir).get(s.id);
 assert.deepEqual(restored.referenceIds,[]);assert.deepEqual(restored.messages.find(m=>m.role==='user').referenceIds,ids);
 assert.deepEqual((await f.req(url,'PATCH',{referenceIds:[ids[1]]})).data.referenceIds,[ids[1]]);
 assert.equal((await f.req(url)).data.selectedId,generated.id,'removing a reference keeps a selected design');
 await f.req(url,'PATCH',{selectedId:ids[1]});
 const removed=await f.req(url,'PATCH',{referenceIds:[]});
 assert.equal(removed.data.selectedId,null);assert.equal(removed.data.versions.length,3,'removing references keeps version history');
 assert.deepEqual(removed.data.messages.find(m=>m.role==='user').referenceIds,ids,'past turns retain their reference snapshot');
 await f.req(url,'PATCH',{selectedId:ids[0]});
 assert.deepEqual((await f.req(url)).data.referenceIds,[ids[0]],'selecting an old upload can reattach it');
 const cleared=await f.req(url,'PATCH',{selectedId:null});
 assert.deepEqual(cleared.data.referenceIds,[]);
 assert.deepEqual(new Store(f.dataDir).get(s.id).referenceIds,[],'explicitly cleared references stay cleared after restart');
});
test('rejected submissions keep draft images; following turns do not attach them again',async t=>{
 const f=await fixture(t,async()=> '已收到。'),s=f.store.create();
 const bytes=await sharp({create:{width:10,height:10,channels:3,background:'#abc'}}).png().toBuffer();
 const image=f.store.addImage(s,bytes,{kind:'upload',demo:false}),url=`/api/sessions/${s.id}/turns`;
 assert.equal((await f.req(url,'POST',{text:' ',requestId:randomUUID()})).status,400);
 assert.deepEqual(s.referenceIds,[image.id]);assert.equal(s.messages.length,0);
 const requestId=randomUUID();
 assert.equal((await f.req(url,'POST',{text:'先看这张图片',requestId})).status,202);await f.wait(s.id);
 assert.deepEqual(s.referenceIds,[]);
 const duplicate=await f.req(url,'POST',{text:'先看这张图片',requestId});
 assert.equal(duplicate.data.duplicate,true);assert.equal(s.messages.filter(m=>m.role==='user').length,1);
 await f.req(url,'POST',{text:'继续讨论',requestId:randomUUID()});await f.wait(s.id);
 assert.deepEqual(s.messages.filter(m=>m.role==='user').map(m=>m.referenceIds),[[image.id],[]]);
});
test('generated image references retain their version identity and become turn attachments',async t=>{
 let executedIds;
 const f=await fixture(t,async({job})=>{executedIds=[...job.referenceIds];return '已参考指定版本。';}),s=f.store.create();
 const bytes=await sharp({create:{width:10,height:10,channels:3,background:'#abc'}}).png().toBuffer();
 const first=f.store.addImage(s,bytes,{kind:'generated',demo:false,label:'指定旧版本'});
 const latest=f.store.addImage(s,bytes,{kind:'generated',demo:false,parentId:first.id,label:'最新版本'});
 const url=`/api/sessions/${s.id}`;
 const added=await f.req(url,'PATCH',{referenceIds:[first.id]});
 assert.equal(added.status,200);assert.deepEqual(added.data.referenceIds,[first.id]);
 assert.equal(added.data.selectedId,latest.id,'adding a reference does not replace the current editing source');
 assert.equal(added.data.versions.length,2,'referencing a version does not copy it or renumber history');
 assert.deepEqual(new Store(f.dataDir).get(s.id).referenceIds,[first.id]);
 assert.equal((await f.req(url,'PATCH',{referenceIds:[]})).status,200);
 assert.equal(s.selectedId,latest.id,'removing a generated reference preserves the selected output');
 await f.req(url,'PATCH',{referenceIds:[first.id,latest.id]});
 const sent=await f.req(url+'/turns','POST',{text:'参考第一张的版式和第二张的配色',requestId:randomUUID()});
 assert.equal(sent.status,202);assert.deepEqual(sent.data.session.referenceIds,[]);
 const done=await f.wait(s.id);
 assert.deepEqual(executedIds,[first.id,latest.id]);
 assert.deepEqual(done.messages.find(m=>m.role==='user').referenceIds,[first.id,latest.id]);
 assert.equal(done.versions.length,2);
 assert.deepEqual(new Store(f.dataDir).get(s.id).messages[0].referenceIds,[first.id,latest.id]);
});
test('reference updates reject foreign, demo and duplicate images; concurrent uploads respect the limit',async t=>{
 const f=await fixture(t),s=f.store.create(),other=f.store.create();
 const bytes=await sharp({create:{width:10,height:10,channels:3,background:'#abc'}}).png().toBuffer();
 const foreign=f.store.addImage(other,bytes,{kind:'upload',demo:false});
 const demo=f.store.addImage(s,bytes,{kind:'generated',demo:true});
 const local=f.store.addImage(s,bytes,{kind:'upload',demo:false});
 const url=`/api/sessions/${s.id}`;
 for(const referenceIds of [[foreign.id],[demo.id],[local.id,local.id]])assert.equal((await f.req(url,'PATCH',{referenceIds})).status,400);
 assert.deepEqual(f.store.get(s.id).referenceIds,[local.id]);
 for(let i=0;i<6;i++)f.store.addImage(s,bytes,{kind:'upload',demo:false});
 const payload={name:'reference.png',data:'data:image/png;base64,'+bytes.toString('base64')};
 const results=await Promise.all([f.req(url+'/upload','POST',payload),f.req(url+'/upload','POST',payload)]);
 assert.deepEqual(results.map(r=>r.status).sort(),[201,400]);
 assert.equal(f.store.get(s.id).referenceIds.length,8);assert.equal(f.store.get(s.id).versions.length,9);
 assert.match(results.find(r=>r.status===400).data.error,/最多参考 8 张/);
});
test('legacy sessions restore both uploaded references while preserving cleared selection',async t=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'canvas-legacy-references-'));t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
 const store=new Store(temp),session=store.create(),cleared=store.create();
 const bytes=await sharp({create:{width:10,height:10,channels:3,background:'#abc'}}).png().toBuffer();
 for(const s of [session,cleared]){
  store.addImage(s,bytes,{kind:'upload',demo:false,label:'菜单明细'});store.addImage(s,bytes,{kind:'upload',demo:false,label:'Logo'});
  delete s.referenceIds;delete s.referenceScope;if(s===cleared)s.selectedId=null;store.save(s);
 }
 const restored=new Store(temp);
 assert.deepEqual(restored.get(session.id).referenceIds,session.versions.map(v=>v.id));
 assert.deepEqual(restored.get(cleared.id).referenceIds,[]);
});
test('migration moves previously sent references into messages while retaining unsent drafts',async t=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'canvas-message-attachments-'));t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
 const store=new Store(temp),session=store.create();
 const bytes=await sharp({create:{width:10,height:10,channels:3,background:'#abc'}}).png().toBuffer();
 const sent=store.addImage(session,bytes,{kind:'upload',demo:false}),draft=store.addImage(session,bytes,{kind:'upload',demo:false});
 session.messages.push({id:'legacy-user',role:'user',text:'参考这张图片',sourceId:sent.id,referenceIds:[sent.id]});
 delete session.referenceScope;store.save(session);
 const restoredStore=new Store(temp),restored=restoredStore.get(session.id);
 assert.deepEqual(restored.referenceIds,[draft.id]);assert.deepEqual(restored.messages[0].referenceIds,[sent.id]);
 restored.referenceIds.push(sent.id);restoredStore.save(restored);
 assert.deepEqual(new Store(temp).get(session.id).referenceIds,[draft.id,sent.id],'explicitly reattached images survive later restarts');
});
test('rejects cross-origin writes, missing token and unknown skill',async t=>{
 const f=await fixture(t);
 assert.equal((await f.req('/api/sessions','POST',undefined,{'X-Studio-Token':''})).status,403);
 assert.equal((await f.req('/api/sessions','POST',undefined,{Origin:'https://untrusted.example'})).status,403);
 const {data:s}=await f.req('/api/sessions','POST');
 assert.equal((await f.req(`/api/sessions/${s.id}`,'PATCH',{skillId:'../../private'})).status,400);
 const config=(await f.req('/api/config')).data;assert.equal('apiKey' in config,false);
});
test('skill import, reference access, unsupported dependencies and symlink boundary',t=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'canvas-skill-'));t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
 const skills=new Skills([path.join(root,'skills')],temp);
 const skill=skills.get('editorial');assert.match(skills.reference(skill,'references/art-direction.md'),/艺术指导/);
 assert.throws(()=>skills.reference(skill,'../../.env'));
 const imported=skills.import('---\nname: 自定义\ndescription: 我的技能\n---\n保持背景浅色。');assert.equal(skills.get(imported.id).name,'自定义');
 assert.throws(()=>skills.import('missing frontmatter'));
 const dependent=skills.import('---\nname: Shell\ndescription: Requires shell\nallowed-tools: Bash\n---\nrun script');assert.equal(dependent.unsupported,false);assert.equal(skills.get(dependent.id).canRunScripts,false);
 const symlinkDir=path.join(temp,'outside');fs.mkdirSync(symlinkDir);fs.writeFileSync(path.join(symlinkDir,'SKILL.md'),'---\nname: Link\ndescription: Link\n---\nread');fs.symlinkSync(path.join(root,'.env'),path.join(symlinkDir,'secret.txt'));
 const linked=skills.all().find(s=>s.name==='Link');assert.equal(linked.files.includes('secret.txt'),false);
});
test('GitHub skill importer validates repository URLs before cloning',async t=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'canvas-github-'));t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
 const skills=new Skills([path.join(root,'skills')],temp);
 await assert.rejects(()=>skills.importGitHub('http://github.com/org/repo'),/https/);
 await assert.rejects(()=>skills.importGitHub('https://example.com/org/repo'),/github.com/);
 await assert.rejects(()=>skills.importGitHub('https://github.com/org/repo/tree/main/skill'),/仓库地址/);
});
test('restart marks an interrupted turn without replaying it',t=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'canvas-restart-'));t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
 const store=new Store(temp),s=store.create();s.job={status:'running',usage:[{kind:'image',status:'running',usage:null}]};store.save(s);
 const resumed=new Store(temp).get(s.id);assert.equal(resumed.job.status,'interrupted');assert.match(resumed.messages[0].text,/不会自动/);
 assert.equal(resumed.product,null);assert.equal(resumed.job.usage[0].status,'interrupted');assert.equal(resumed.messages[0].task.usage[0].usage,null);assert.ok(resumed.job.finishedAt);
});

test('product API records free direction without scene presets and resets facts for new uploads',async t=>{
 const f=await fixture(t),{data:s}=await f.req('/api/sessions','POST');
 assert.equal(s.skillId,'product-promotion');
 const {data:config}=await f.req('/api/config');
 for(const field of ['productSizes','productShots','productPurposes'])assert.equal(field in config,false);
 assert.equal((await f.req(`/api/sessions/${s.id}`,'PATCH',{skillId:'editorial',product:{brief:'商品方案'}})).status,400);
 assert.equal((await f.req(`/api/sessions/${s.id}`,'PATCH',{skillId:'product-photo'})).status,400,'no old skill alias');
 const bytes=await sharp({create:{width:30,height:30,channels:3,background:'#abc'}}).png().toBuffer();
 const upload=()=>f.req(`/api/sessions/${s.id}/upload`,'POST',{name:'product.png',data:'data:image/png;base64,'+bytes.toString('base64')});
 const {data:first}=await upload();assert.equal(first.session.product.sourceId,first.version.id);assert.equal(first.session.product.campaign.kind,'');
 const {data:brief}=await f.req(`/api/sessions/${s.id}`,'PATCH',{product:{facts:[{basis:'user',text:'手链'}],brief:'保留商品，森林苔藓场景',campaign:{kind:'用户自定义用途',headline:'把微光戴在手边',visual:'文字环绕主体'}}});
 assert.equal(brief.product.facts[0].basis,'user');assert.equal(brief.product.campaign.kind,'用户自定义用途');
 for(const product of [{sourceId:'foreign'},{shot:'coastal'},{purpose:'awareness'},{campaign:{mode:'layout'}},{campaign:{layout:'split'}}]){
  assert.equal((await f.req(`/api/sessions/${s.id}`,'PATCH',{product})).status,400);
 }
 const {data:second}=await upload();assert.equal(second.session.product.sourceId,second.version.id);assert.deepEqual(second.session.product.facts,[]);assert.equal(second.session.product.campaign.headline,'');assert.equal(second.session.product.brief,'');
 const session=f.store.get(s.id);
 const generated=f.store.addImage(session,bytes,{kind:'generated',demo:false,parentId:first.version.id,productSourceId:first.version.id});
 const {data:branch}=await f.req(`/api/sessions/${s.id}`,'PATCH',{selectedId:generated.id});assert.equal(branch.product.sourceId,first.version.id);
 const {data:cleared}=await f.req(`/api/sessions/${s.id}`,'PATCH',{selectedId:null});assert.equal(cleared.product,null);
 await f.req(`/api/sessions/${s.id}/turns`,'POST',{text:'概念商品',requestId:randomUUID()});
 assert.equal((await f.req(`/api/sessions/${s.id}`,'PATCH',{product:{brief:'并发修改'}})).status,409);
 const done=await f.wait(s.id);assert.equal(done.job.productSourceId,null);assert.deepEqual(done.job.models,{agent:'test',image:'test'});
 assert.equal(done.messages.at(-1).task.status,'completed');assert.ok(done.messages.at(-1).task.finishedAt);
 assert.equal(new Store(f.dataDir).get(s.id).messages.at(-1).task.models.image,'test');
});

test('product design snapshots restore independently across generated versions and restart',async t=>{
 const f=await fixture(t),session=f.store.create();
 const bytes=await sharp({create:{width:100,height:100,channels:3,background:'#abc'}}).png().toBuffer();
 const original=f.store.addImage(session,bytes,{kind:'upload',demo:false});syncProduct(session);
 const path=`/api/sessions/${session.id}`;
 assert.equal((await f.req(path,'PATCH',{product:{brief:'苔藓背景，自由排布',campaign:{headline:'原标题',theme:'原主题'}}})).status,200);
 const firstSnapshot=structuredClone(session.product);
 const first=f.store.addImage(session,bytes,{kind:'generated',productSourceId:original.id,parentId:original.id,product:firstSnapshot});
 await f.req(path,'PATCH',{product:{campaign:{headline:'用户新标题',visual:'文字穿插画面'}}});
 const second=f.store.addImage(session,bytes,{kind:'generated',productSourceId:original.id,parentId:first.id,product:structuredClone(session.product)});
 assert.equal(first.product.campaign.headline,'原标题');assert.equal(second.product.campaign.headline,'用户新标题');
 const {data:restored}=await f.req(path,'PATCH',{selectedId:first.id});
 assert.equal(restored.product.campaign.headline,'原标题');assert.equal(restored.product.brief,'苔藓背景，自由排布');
 assert.equal(restored.product.sourceId,original.id);
 await f.req(path,'PATCH',{selectedId:second.id});
 const persisted=new Store(f.dataDir).get(session.id);
 assert.equal(persisted.selectedId,second.id);assert.equal(persisted.product.campaign.headline,'用户新标题');
 assert.equal(persisted.versions.length,3);assert.equal(persisted.job,null);
 assert.equal((await fetch(f.base+path+'/poster',{method:'POST',headers:{'X-Studio-Token':(await f.req('/api/config')).data.token,'Content-Type':'application/json'},body:JSON.stringify({sourceId:first.id})})).status,404,'there is no specialized poster API');
});
test('credential parser reads only whitelisted assignments without executing shell',t=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'canvas-creds-'));t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
 const file=path.join(temp,'keys.env');fs.writeFileSync(file,'export OPENAI_API_KEY="dummy-test"\nexport OPENAI_BASE_URL=https://example.invalid/v1\nOTHER=ignored\n');
 assert.deepEqual(loadCredentials({STUDIO_CREDENTIALS_FILE:file}),{apiKey:'dummy-test',baseURL:'https://example.invalid/v1',imageApiKey:'dummy-test',imageBaseURL:'https://example.invalid/v1'});
 assert.equal(loadCredentials({STUDIO_CREDENTIALS_FILE:file,OPENAI_API_KEY:'override'}).apiKey,'override');
});
test('image provider uses separate credentials and rejects incomplete overrides',t=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'canvas-split-creds-'));t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
 const file=path.join(temp,'keys.env');fs.writeFileSync(file,'OPENAI_API_KEY=chat-test-key\nOPENAI_BASE_URL=https://chat.example.invalid/v1\n');
 assert.deepEqual(loadCredentials({STUDIO_CREDENTIALS_FILE:file,IMAGE_API_KEY:'image-test-key',IMAGE_BASE_URL:'https://images.example.invalid/v1'}),{
  apiKey:'chat-test-key',baseURL:'https://chat.example.invalid/v1',imageApiKey:'image-test-key',imageBaseURL:'https://images.example.invalid/v1',
 });
 assert.throws(()=>loadCredentials({STUDIO_CREDENTIALS_FILE:file,IMAGE_BASE_URL:'https://images.example.invalid/v1'}),/必须同时设置/);
 assert.throws(()=>loadCredentials({STUDIO_CREDENTIALS_FILE:file,IMAGE_API_KEY:'image-test-key'}),/必须同时设置/);
});

test('Agents SDK sandbox clients expose local and Docker providers',t=>{
 const docker=new DockerSandboxClient({image:'python:3.12-slim',networkMode:'none'});
 assert.equal(docker.backendId,'docker');
 assert.equal(new UnixLocalSandboxClient({}).backendId,'unix_local');
});
test('skill script runner validates declared scripts before Docker execution',async t=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'canvas-script-'));t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
 const skillDir=path.join(temp,'script');fs.mkdirSync(path.join(skillDir,'scripts'),{recursive:true});fs.writeFileSync(path.join(skillDir,'SKILL.md'),'---\nname: Script\ndescription: Runs a script\nallowed-tools: Bash\n---\nrun it');fs.writeFileSync(path.join(skillDir,'scripts','hello.py'),'print("hello")');
 const skills=new Skills([temp],path.join(temp,'imports')),skill=skills.get('script');
 await assert.rejects(()=>runSkillScript({skill,script:'references/no.py',config:{sandboxMode:'docker',sandboxImage:'python:3.12-slim'},signal:new AbortController().signal}),/scripts/);
});
test('a turn that exceeds the deadline reports a timeout instead of a manual stop',async t=>{
 const f=await fixture(t,({signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true})),{turnTimeoutMs:150,settleGraceMs:60});
 const {data:s}=await f.req('/api/sessions','POST');
 assert.equal((await f.req(`/api/sessions/${s.id}/turns`,'POST',{text:'生图',requestId:randomUUID()})).status,202);
 const done=await f.wait(s.id);
 assert.equal(done.job.status,'cancelled');
 assert.match(done.job.error,/本轮执行超时（\d+ 毫秒）/);
 assert.equal(done.messages.at(-1).error,true);
 assert.match(done.messages.at(-1).text,/本轮执行超时/);
});
test('manual stop keeps the stopped wording',async t=>{
 const f=await fixture(t,()=>new Promise(()=>{}),{turnTimeoutMs:30000,settleGraceMs:60});
 const {data:s}=await f.req('/api/sessions','POST');
 await f.req(`/api/sessions/${s.id}/turns`,'POST',{text:'生图',requestId:randomUUID()});
 await f.req(`/api/sessions/${s.id}/cancel`,'POST');
 const done=await f.wait(s.id);
 assert.equal(done.job.status,'cancelled');
 assert.match(done.job.error,/^本轮已停止。/);
});
test('a task that ignores the abort signal is force-closed so the session stays usable',async t=>{
 const f=await fixture(t,()=>new Promise(()=>{}),{turnTimeoutMs:120,settleGraceMs:80});
 const {data:s}=await f.req('/api/sessions','POST');
 assert.equal((await f.req(`/api/sessions/${s.id}/turns`,'POST',{text:'生图',requestId:randomUUID()})).status,202);
 const done=await f.wait(s.id);
 assert.equal(done.job.status,'cancelled','the watchdog ends the turn even when the provider promise never settles');
 assert.match(done.messages.at(-1).text,/本轮执行超时/);
 const next=await f.req(`/api/sessions/${s.id}/turns`,'POST',{text:'再来一次',requestId:randomUUID()});
 assert.equal(next.status,202,'a stuck turn must not leave the session busy forever');
 await f.req(`/api/sessions/${s.id}/cancel`,'POST');
 await f.wait(s.id);
});
