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
async function fixture(t,execute){
 const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'canvas-test-'));
 const instance=createApp({root,dataDir,demo:true,maxImages:2,agentModel:'test',imageModel:'test'},{execute});
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
