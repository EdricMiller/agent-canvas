import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {DEFAULT_IMAGE_GENERATION} from '../shared/image-generation.js';

export const MAX_REFERENCE_IMAGES = 8;

export class Store {
  constructor(root) {
    this.root = root;
    this.sessionsDir = path.join(root, 'sessions');
    this.imagesDir = path.join(root, 'images');
    for (const dir of [this.sessionsDir, this.imagesDir]) fs.mkdirSync(dir, { recursive: true });
    this.cache = new Map();
    for (const name of fs.readdirSync(this.sessionsDir).filter(n => n.endsWith('.json'))) {
      const session = JSON.parse(fs.readFileSync(path.join(this.sessionsDir, name), 'utf8'));
      session.imageGeneration??={...DEFAULT_IMAGE_GENERATION};
      // Older sessions kept uploads only in version history. Restore them as
      // references unless the user had explicitly cleared the image selection.
      if (!Array.isArray(session.referenceIds)) {
        session.referenceIds = session.selectedId ? session.versions.filter(v => v.kind === 'upload' && !v.demo).slice(-MAX_REFERENCE_IMAGES).map(v => v.id) : [];
      }
      if (session.referenceScope !== 'turn') {
        for (const message of session.messages.filter(m => m.role === 'user')) {
          if (!Array.isArray(message.referenceIds)) message.referenceIds = session.versions.some(v => v.id === message.sourceId && v.kind === 'upload') ? [message.sourceId] : [];
        }
        const sent = new Set(session.messages.filter(m => m.role === 'user').flatMap(m => m.referenceIds));
        session.referenceIds = session.referenceIds.filter(id => !sent.has(id));
        session.referenceScope = 'turn';
      }
      const interrupted = session.job?.status === 'running';
      if (interrupted) {
        session.job.status = 'interrupted';
        session.job.finishedAt = new Date().toISOString();
        session.job.error = session.job.outputMode==='design'?'服务重启，本轮已中断。已有设计稿和设计版本保留；不会自动重新发起 AI 请求。':'服务重启，本轮已中断。已生成的图片已保留；不会自动重新计费。';
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
    const session = { id: randomUUID(), title: '未命名创作', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messages: [], versions: [], selectedId: null, referenceIds: [], referenceScope: 'turn', skillId: 'product-promotion', size: '1080x1440', imageTarget:null, imageGeneration:{...DEFAULT_IMAGE_GENERATION}, product: null, job: null, requests: [] };
    this.cache.set(session.id, session); this.save(session); return session;
  }
  save(session) {
    session.updatedAt = new Date().toISOString();
    const target = path.join(this.sessionsDir, `${session.id}.json`);
    fs.writeFileSync(`${target}.tmp`, JSON.stringify(session, null, 2), { mode: 0o600 });
    fs.renameSync(`${target}.tmp`, target);
  }
  addImage(session, bytes, metadata, {reference=true,originalBytes}={}) {
    if (metadata.kind === 'upload' && reference && session.referenceIds.length >= MAX_REFERENCE_IMAGES) throw new Error(`最多参考 ${MAX_REFERENCE_IMAGES} 张图片，请先移除不需要的参考图`);
    const id = randomUUID();
    fs.writeFileSync(path.join(this.imagesDir, `${id}.png`), bytes);
    if(originalBytes)fs.writeFileSync(path.join(this.imagesDir,`${id}-source.png`),originalBytes);
    const number = metadata.kind === 'upload' ? session.versions.length + 1 : Math.max(0, ...session.versions.filter(v => v.kind !== 'upload').map(v => v.number)) + 1;
    const version = { id, url: `/images/${id}.png`, number, createdAt: new Date().toISOString(), ...metadata,...(originalBytes?{sourceUrl:`/images/${id}-source.png`}:{}) };
    session.versions.push(version);
    if(metadata.kind!=='upload'||reference)session.selectedId = id;
    if (metadata.kind === 'upload' && reference) session.referenceIds.push(id);
    this.save(session); return version;
  }
  references(session, ids = session.referenceIds) { return ids.map(id => this.image(session, id)); }
  image(session, id, {original=false}={}) {
    const version = session.versions.find(v => v.id === id);
    if (!version) throw new Error('图片不属于当前会话');
    return { version, bytes: fs.readFileSync(path.join(this.imagesDir, `${version.id}${original&&version.sourceUrl?'-source':''}.png`)) };
  }
}
