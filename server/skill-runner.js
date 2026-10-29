import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const interpreters = new Map([
  ['.py', ['python']],
  ['.sh', ['/bin/sh']],
]);

function fail(message, status = 400) {
  throw Object.assign(new Error(message), {status});
}

export async function runSkillScript({skill, script, args = [], config, signal}) {
  if (!skill?.dir || !skill.canRunScripts) fail('当前 Skill 没有声明可执行脚本权限');
  if (config.sandboxMode !== 'docker') fail('执行 Skill 脚本需要 SANDBOX_MODE=docker');
  if (!skill.files.includes(script) || !script.startsWith('scripts/') || script.includes('..') || path.isAbsolute(script)) fail('只能执行当前 Skill scripts/ 目录中的已登记脚本');
  if (!Array.isArray(args) || args.length > 8 || args.some(arg => typeof arg !== 'string' || arg.length > 500)) fail('脚本参数最多 8 个，每个参数最多 500 个字符');
  const extension = path.extname(script).toLowerCase();
  const interpreter = interpreters.get(extension);
  if (!interpreter) fail(`当前 Docker 镜像不支持 ${extension || '此类'}脚本，仅支持 Python 和 Shell`);
  const root = fs.realpathSync(skill.dir);
  const full = fs.realpathSync(path.resolve(root, script));
  if (!full.startsWith(`${root}${path.sep}`) || !fs.statSync(full).isFile()) fail('脚本路径无效');

  const dockerArgs = [
    'run', '--rm', '--network', config.sandboxNetwork || 'none',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--pids-limit', '64', '--memory', '256m', '--cpus', '1',
    '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
    '--user', '65532:65532', '--mount', `type=bind,src=${root},dst=/skill,readonly`,
    '--workdir', '/skill', config.sandboxImage || 'python:3.12-slim',
    ...interpreter, `/skill/${script}`, ...args,
  ];
  return await new Promise((resolve, reject) => {
    const child = spawn('docker', dockerArgs, {stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '', stderr = '', settled = false;
    const finish = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); fn(value); };
    const abort = () => { child.kill('SIGKILL'); finish(reject, Object.assign(new Error('脚本执行已取消'), {name:'AbortError'})); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(reject, Object.assign(new Error('脚本执行超过 30 秒限制'), {status:504})); }, 30000);
    signal?.addEventListener('abort', abort, {once:true});
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(0, 64000); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8000); });
    child.on('error', error => finish(reject, Object.assign(new Error(`无法启动 Docker：${error.message}`), {status:502})));
    child.on('close', code => code === 0
      ? finish(resolve, {ok:true, stdout:stdout.trim(), stderr:stderr.trim(), exitCode:0})
      : finish(reject, Object.assign(new Error(`脚本退出码为 ${code}：${stderr.trim() || stdout.trim() || '无输出'}`), {status:422, exitCode:code, stdout:stdout.trim(), stderr:stderr.trim()})));
  });
}
