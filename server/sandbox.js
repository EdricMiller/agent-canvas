import fs from 'node:fs';
import path from 'node:path';
import { localFile, skills } from '@openai/agents/sandbox';

function filesUnder(root, folder) {
  const base=path.join(root,folder), result={};
  if (!fs.existsSync(base)) return result;
  const walk=(dir,prefix='')=>{
    for (const entry of fs.readdirSync(dir,{withFileTypes:true})) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink() || entry.name==='node_modules') continue;
      const rel=prefix+entry.name, full=path.join(dir,entry.name);
      if (entry.isDirectory()) walk(full,rel+'/');
      else if (entry.isFile()) result[rel]=localFile({src:full});
    }
  };
  walk(base); return result;
}

export function nativeSkillCapability(skill) {
  if (!skill?.dir) return null;
  return skills({skills:[{
    name:skill.name,
    description:skill.description,
    content:localFile({src:path.join(skill.dir,'SKILL.md')}),
    scripts:filesUnder(skill.dir,'scripts'),
    references:filesUnder(skill.dir,'references'),
    assets:filesUnder(skill.dir,'assets'),
  }]});
}
