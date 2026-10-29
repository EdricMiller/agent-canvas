import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { parse } from 'yaml';
import { connectors as connectorRegistry } from './connectors.js';

function parseSkill(text, id, dir) {
  if (text.length > 64000) throw new Error('SKILL.md 最大 64 KB');
  const match = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n([\s\S]*)$/);
  if (!match) throw new Error('SKILL.md 需要 YAML frontmatter（name、description）');
  const meta = parse(match[1], { maxAliasCount: 20 });
  if (!meta || typeof meta.name !== 'string' || typeof meta.description !== 'string') throw new Error('name 和 description 必须是文本');
  const files = [];
  const walk = (folder, prefix = '', depth = 0) => {
    if (depth > 5) return;
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.isSymbolicLink()) continue;
      const relative = prefix + entry.name;
      if (entry.isDirectory()) walk(path.join(folder, entry.name), relative + '/', depth + 1);
      else if (entry.isFile() && entry.name !== 'SKILL.md') files.push(relative);
    }
  };
  if (dir) walk(dir);
  const list = value => Array.isArray(value) ? value.filter(item => typeof item === 'string').map(item => item.trim()).filter(Boolean) : typeof value === 'string' ? value.split(/[\s,]+/).map(item => item.trim()).filter(Boolean) : [];
  const allowedTools = list(meta['allowed-tools'] || meta.allowedTools);
  const requires = list(meta.requires);
  const connectors = list(meta.connectors);
  const normalized = allowedTools.map(item => item.toLowerCase().replaceAll('_','-'));
  const canRunScripts = files.some(file => file.startsWith('scripts/')) && normalized.some(item => ['bash','shell','python','run-script','run-skill-script'].includes(item));
  const unsupportedReasons = [];
  if (meta.mcp) unsupportedReasons.push('MCP 连接器尚未注册');
  const unknownConnectors = connectors.filter(connector => !Object.hasOwn(connectorRegistry, connector));
  if (unknownConnectors.length) unsupportedReasons.push(`未注册连接器：${unknownConnectors.join('、')}`);
  const unsupported = unsupportedReasons.length > 0;
  return { id, name: meta.name.slice(0,80), description: meta.description.slice(0,300), icon: meta.icon || 'sparkles', color: meta.color || 'violet', workflow: meta.metadata?.workflow === 'product-promotion' ? 'product-promotion' : null, body: match[2], version: createHash('sha256').update(text).digest('hex').slice(0,12), files, dir, allowedTools, requires, connectors, canRunScripts, unsupported, unsupportedReason: unsupportedReasons.join('；') };
}
export class Skills {
  constructor(roots, importDir) { this.roots = [...roots, importDir]; this.importDir = importDir; fs.mkdirSync(importDir, {recursive:true}); }
  all() {
    const results = [];
    for (const [index, root] of this.roots.entries()) {
      if (!fs.existsSync(root)) continue;
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
        const dir = path.join(root, entry.name), file = path.join(dir, 'SKILL.md');
        if (!fs.existsSync(file) || fs.lstatSync(file).isSymbolicLink()) continue;
        const id = index === 0 ? entry.name : `${index}-${entry.name}`;
        try { results.push(parseSkill(fs.readFileSync(file,'utf8'), id, dir)); }
        catch { results.push({id, name:entry.name, description:'技能格式无效，请检查 SKILL.md', unsupported:true, invalid:true, files:[]}); }
      }
    }
    return results;
  }
  list() { return this.all().map(({body,dir,...rest})=>rest); }
  get(id) {
    if (!id) return null;
    const skill = this.all().find(s=>s.id===id);
    if (!skill) throw Object.assign(new Error('所选 Skill 不存在'), {status:400});
    if (skill.unsupported) throw Object.assign(new Error(`此技能暂不可用：${skill.unsupportedReason}`), {status:400});
    return skill;
  }
  reference(skill, relative) {
    if (!skill || !skill.files.includes(relative) || !/\.(md|txt|json|ya?ml|csv)$/i.test(relative)) throw new Error('只能读取所选 Skill 中列出的文本参考文件');
    const root = fs.realpathSync(skill.dir), full = fs.realpathSync(path.resolve(root,relative));
    if (!full.startsWith(root + path.sep)) throw new Error('参考文件超出技能目录');
    if (fs.statSync(full).size > 64000) throw new Error('参考文件超过 64 KB');
    return fs.readFileSync(full,'utf8');
  }
  import(text) {
    const hash = createHash('sha256').update(text).digest('hex').slice(0,12);
    parseSkill(text,hash,null);
    const dir = path.join(this.importDir, hash); fs.mkdirSync(dir,{recursive:true});
    fs.writeFileSync(path.join(dir,'SKILL.md'),text);
    return this.list().find(s=>s.id.endsWith(hash));
  }
  async importGitHub(url) {
    let parsed;
    try { parsed=new URL(url); } catch { throw Object.assign(new Error('请输入有效的 GitHub HTTPS 地址'),{status:400}); }
    if (parsed.protocol!=='https:' || !['github.com','www.github.com'].includes(parsed.hostname.toLowerCase())) throw Object.assign(new Error('只允许 https://github.com/... 仓库地址'),{status:400});
    const match=parsed.pathname.match(/^\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
    if (!match) throw Object.assign(new Error('请输入 GitHub 仓库地址，例如 https://github.com/org/repo'),{status:400});
    const repo=`${match[1]}/${match[2]}`;
    const temp=path.join(this.importDir,`.download-${createHash('sha256').update(url).digest('hex').slice(0,16)}`);
    fs.rmSync(temp,{recursive:true,force:true}); fs.mkdirSync(path.dirname(temp),{recursive:true});
    try {
      await new Promise((resolve,reject)=>{
        const child=spawn('git',['clone','--depth','1','--filter=blob:none','--no-tags',`https://github.com/${repo}.git`,temp],{stdio:['ignore','pipe','pipe']});
        let stderr=''; const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Object.assign(new Error('GitHub 仓库下载超时（90 秒）'),{status:504}));},90000);
        child.stderr.on('data',b=>{stderr=(stderr+b).slice(-1200);});
        child.on('error',error=>{clearTimeout(timer);reject(Object.assign(new Error(`无法运行 git：${error.message}`),{status:502}));});
        child.on('close',code=>{clearTimeout(timer);code===0?resolve():reject(Object.assign(new Error(`GitHub 仓库下载失败：${stderr.trim()||'git clone 返回错误'}`),{status:502}));});
      });
      const candidates=[];
      const walk=(dir,depth=0)=>{
        if(depth>4)return;
        if(fs.existsSync(path.join(dir,'SKILL.md'))) candidates.push(dir);
        for(const entry of fs.readdirSync(dir,{withFileTypes:true})) if(entry.isDirectory()&&!entry.name.startsWith('.')&&!entry.isSymbolicLink()&&entry.name!=='node_modules') walk(path.join(dir,entry.name),depth+1);
      };
      walk(temp);
      if(!candidates.length) throw Object.assign(new Error('仓库中没有找到 SKILL.md'),{status:400});
      const imported=[];
      for(const source of candidates){
        let text=fs.readFileSync(path.join(source,'SKILL.md'),'utf8');
        const hash=createHash('sha256').update(`${repo}\n${path.relative(temp,source)}\n${text}`).digest('hex').slice(0,16);
        parseSkill(text,hash,source);
        const target=path.join(this.importDir,`github-${hash}`); fs.rmSync(target,{recursive:true,force:true}); fs.mkdirSync(target,{recursive:true});
        const copy=(from,to,depth=0)=>{if(depth>6)return;for(const entry of fs.readdirSync(from,{withFileTypes:true})){if(entry.name.startsWith('.')||entry.isSymbolicLink()||entry.name==='node_modules')continue;const src=path.join(from,entry.name),dst=path.join(to,entry.name);if(entry.isDirectory()){fs.mkdirSync(dst,{recursive:true});copy(src,dst,depth+1);}else if(entry.isFile()){fs.copyFileSync(src,dst);}}};
        copy(source,target); imported.push({id:`1-github-${hash}`,relativePath:path.relative(temp,source)});
      }
      return {source:`https://github.com/${repo}`,imported:this.list().filter(skill=>imported.some(item=>item.id===skill.id)).map(skill=>({...skill,source:`https://github.com/${repo}`}))};
    } finally { fs.rmSync(temp,{recursive:true,force:true}); }
  }
}
