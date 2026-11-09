import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createDocument,documentSchema,designError} from './document.js';

// Documents are stored separately from conversations and legacy PNG versions.
// Writes are atomic. A revision guards each draft write against stale tabs.
export class DocumentStore {
  constructor(root){this.dir=path.join(root,'documents');fs.mkdirSync(this.dir,{recursive:true});}
  file(sessionId){if(!/^[a-f\d-]{36}$/i.test(sessionId))throw designError('无效的会话 ID');return path.join(this.dir,`${sessionId}.json`);}
  get(sessionId){const file=this.file(sessionId);return fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null;}
  persist(sessionId,record){const file=this.file(sessionId);fs.writeFileSync(`${file}.tmp`,JSON.stringify(record),{mode:0o600});fs.renameSync(`${file}.tmp`,file);return record;}
  require(sessionId){const record=this.get(sessionId);if(!record)throw designError('请先创建设计稿',404);return record;}
  check(record,revision){if(record.revision!==revision)throw designError('设计稿已在其他窗口更新，请刷新后再编辑',409);}
  create(sessionId,options){
    return this.createFromDocument(sessionId,createDocument(options));
  }
  createFromDocument(sessionId,input){
    if(this.get(sessionId))throw designError('该会话已有设计稿，请打开后继续编辑',409);
    const document=documentSchema.parse(input);
    const now=new Date().toISOString();
    return this.persist(sessionId,{id:randomUUID(),revision:1,createdAt:now,updatedAt:now,document,versions:[]});
  }
  update(sessionId,input,revision){
    const document=documentSchema.parse(input),record=this.require(sessionId);this.check(record,revision);
    record.document=document;record.revision++;record.updatedAt=new Date().toISOString();return this.persist(sessionId,record);
  }
  commit(sessionId,input,revision,label){
    const document=documentSchema.parse(input),previous=this.get(sessionId);
    if((previous?.revision??null)!==revision)throw designError('设计稿已在其他窗口更新，请刷新后再编辑',409);
    const now=new Date().toISOString(),record=previous||{id:randomUUID(),revision:0,createdAt:now,versions:[]};
    const snapshot=(value,name)=>({id:randomUUID(),number:record.versions.length+1,label:name,createdAt:now,document:structuredClone(value)});
    const backup=previous&&JSON.stringify(record.versions.at(-1)?.document)!==JSON.stringify(previous.document);
    if(record.versions.length+(backup?2:1)>100)throw designError('设计稿保存版本已达上限，请保留当前稿后再继续');
    if(backup)record.versions.push(snapshot(previous.document,'AI 修改前'));
    record.document=document;record.revision++;record.updatedAt=now;
    record.versions.push(snapshot(document,label));
    return this.persist(sessionId,record);
  }
  snapshot(sessionId,revision,label='保存设计版本'){
    const record=this.require(sessionId);this.check(record,revision);
    if(record.versions.length>=100)throw designError('该设计稿已达到 100 个保存版本');
    const now=new Date().toISOString();
    record.versions.push({id:randomUUID(),number:record.versions.length+1,label,createdAt:now,document:structuredClone(record.document)});
    record.revision++;record.updatedAt=now;return this.persist(sessionId,record);
  }
  restore(sessionId,revision,versionId){
    const record=this.require(sessionId);this.check(record,revision);
    const version=record.versions.find(v=>v.id===versionId);if(!version)throw designError('设计版本不存在',404);
    record.document=structuredClone(version.document);record.revision++;record.updatedAt=new Date().toISOString();return this.persist(sessionId,record);
  }
  view(record){return record?{...record,versions:record.versions.map(({document,...version})=>version)}:null;}
}
