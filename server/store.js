import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export class Store {
  constructor(root) {
    this.root = root;
    this.sessionsDir = path.join(root, 'sessions');
    this.imagesDir = path.join(root, 'images');
    for (const dir of [this.sessionsDir, this.imagesDir]) fs.mkdirSync(dir, { recursive: true });
    this.cache = new Map();
    for (const name of fs.readdirSync(this.sessionsDir).filter(n => n.endsWith('.json'))) {
      const session = JSON.parse(fs.readFileSync(path.join(this.sessionsDir, name), 'utf8'));
      const interrupted = session.job?.status === 'running';
      if (interrupted) {
        session.job.status = 'interrupted';
        session.job.finishedAt = new Date().toISOString();
        session.job.error = '服务重启，本轮已中断。已生成的图片已保留；不会自动重新计费。';
        for (const call of session.job.usage || []) if (call.status === 'running') call.status = 'interrupted';
        session.messages.push({ id: randomUUID(), role: 'assistant', text: session.job.error, error: true, task: session.job, createdAt: new Date().toISOString() });
      }
      this.cache.set(session.id, session);
      if (interrupted) this.save(session);
    }
  }
  list() { return [...this.cache.values()].sort((a,b) => b.updatedAt.localeCompare(a.updatedAt)).map(({id,title,updatedAt,versions,job}) => ({id,title,updatedAt,thumbnail:versions.at(-1)?.url,status:job?.status})); }
  get(id) { const s = this.cache.get(id); if (!s) throw Object.assign(new Error('会话不存在'), { status: 404 }); return s; }
  create() {
    const session = { id: randomUUID(), title: '未命名创作', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messages: [], versions: [], selectedId: null, skillId: 'product-promotion', size: '1080x1440', product: null, job: null, requests: [] };
    this.cache.set(session.id, session); this.save(session); return session;
  }
  save(session) {
    session.updatedAt = new Date().toISOString();
    const target = path.join(this.sessionsDir, `${session.id}.json`);
    fs.writeFileSync(`${target}.tmp`, JSON.stringify(session, null, 2), { mode: 0o600 });
    fs.renameSync(`${target}.tmp`, target);
  }
  addImage(session, bytes, metadata) {
    const id = randomUUID();
    fs.writeFileSync(path.join(this.imagesDir, `${id}.png`), bytes);
    const version = { id, url: `/images/${id}.png`, number: session.versions.length + 1, createdAt: new Date().toISOString(), ...metadata };
    session.versions.push(version); session.selectedId = id; this.save(session); return version;
  }
  image(session, id) {
    const version = session.versions.find(v => v.id === id);
    if (!version) throw new Error('图片不属于当前会话');
    return { version, bytes: fs.readFileSync(path.join(this.imagesDir, `${version.id}.png`)) };
  }
}
