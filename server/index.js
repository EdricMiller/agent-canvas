import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { loadCredentials } from './config.js';
import { ModelSettings } from './model-settings.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const {apiKey,baseURL,imageApiKey,imageBaseURL}=loadCredentials();
const mode=process.env.STUDIO_MODE||'auto';
if(!['auto','demo','live'].includes(mode))throw new Error('STUDIO_MODE must be auto, demo or live');
const sandboxMode=process.env.SANDBOX_MODE||'local';
if(!['off','local','docker'].includes(sandboxMode))throw new Error('SANDBOX_MODE 必须是 off、local 或 docker');
const sandboxImage=process.env.SANDBOX_IMAGE||'python:3.12-slim';
const sandboxNetwork=process.env.SANDBOX_NETWORK||'none';
if(sandboxMode==='docker'&&sandboxNetwork!=='none')throw new Error('为防止社区 Skill 外联，SANDBOX_NETWORK 当前只能是 none');
const imageSize=process.env.IMAGE_SIZE||'auto';
if(imageSize!=='auto'&&!/^\d+x\d+$/.test(imageSize))throw new Error('IMAGE_SIZE 必须是 auto 或 WIDTHxHEIGHT');
const imageLimitValue=String(process.env.MAX_IMAGES_PER_TURN||'unlimited').toLowerCase();
const maxImages=['unlimited','infinite','0'].includes(imageLimitValue)?Infinity:Math.min(100,Math.max(1,Number(imageLimitValue)||2));
const turnLimitValue=String(process.env.AGENT_MAX_TURNS||'unlimited').toLowerCase();
const maxTurns=['unlimited','infinite','0'].includes(turnLimitValue)?null:Math.min(200,Math.max(1,Number(turnLimitValue)||24));
const config={root,dataDir:process.env.STUDIO_DATA_DIR||path.join(root,'.data'),skillsDir:process.env.SKILLS_DIR,apiKey,baseURL,imageApiKey,imageBaseURL,agentModel:process.env.AGENT_MODEL||'gpt-6.1-sol',imageModel:process.env.IMAGE_MODEL||'gpt-image-2.5-sunburst',imageSize,maxImages,maxTurns,sandboxMode,sandboxImage,sandboxNetwork,sandboxWorkspace:process.env.SANDBOX_WORKSPACE||undefined,demo:true};
// The saved registry takes precedence over environment defaults, including on first live startup.
Object.assign(config,new ModelSettings(config).runtimeConfig());
config.demo=mode==='demo'||!config.apiKey;
if(mode==='live'&&!config.apiKey)throw new Error('STUDIO_MODE=live 需要在调试面板或 OPENAI_API_KEY 中配置密钥');
if(sandboxMode==='docker'&&!config.demo) {
  try {
    execFileSync('docker',['info','--format','{{.ServerVersion}}'],{stdio:['ignore','pipe','pipe'],encoding:'utf8',timeout:5000});
  } catch(error) {
    const detail=String(error.stderr||error.message||'未知 Docker 错误').trim().split('\n').at(-1);
    throw new Error(`SANDBOX_MODE=docker 需要可用的 Docker daemon。请启动 Docker Desktop 后重试。${detail?` (${detail})`:''}`);
  }
}
const {app,shutdown}=createApp(config);
const port=Number(process.env.PORT)||4320;
const server=app.listen(port,'127.0.0.1',()=>console.log(`画语 Canvas → http://127.0.0.1:${port} (${config.demo?'DEMO — no AI calls':'LIVE'})`));
server.on('error',error=>{console.error(`无法启动：${error.code}`);process.exitCode=1;});
for(const sig of ['SIGINT','SIGTERM'])process.on(sig,()=>{shutdown();server.close(()=>process.exit(0));});
