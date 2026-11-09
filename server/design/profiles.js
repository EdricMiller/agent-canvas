import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {designError} from './document.js';

export const MAX_PROFILE_BYTES=4*1024*1024;
const profileId=/^icc-[a-f0-9]{64}$/;

export function inspectIcc(bytes){
  if(bytes.length<132||bytes.length>MAX_PROFILE_BYTES||bytes.readUInt32BE(0)!==bytes.length||bytes.subarray(36,40).toString()!=='acsp')throw designError('ICC 文件无效或超过 4 MB');
  if(bytes.subarray(16,20).toString()!=='CMYK'||bytes.subarray(12,16).toString()!=='prtr'||!['XYZ ','Lab '].includes(bytes.subarray(20,24).toString()))throw designError('请选择印刷输出用的 CMYK ICC 配置');
  const count=bytes.readUInt32BE(128);if(count>1024||132+count*12>bytes.length)throw designError('ICC 标签目录无效');
  let name='CMYK ICC';const tags=new Set();
  for(let i=0;i<count;i++){
    const offset=132+i*12;tags.add(bytes.subarray(offset,offset+4).toString());const start=bytes.readUInt32BE(offset+4),size=bytes.readUInt32BE(offset+8);
    if(size<8||start<132+count*12||start+size>bytes.length)throw designError('ICC 标签数据无效');
    if(bytes.subarray(offset,offset+4).toString()!=='desc')continue;
    const type=bytes.subarray(start,start+4).toString();
    if(type==='desc'&&size>=12){const len=bytes.readUInt32BE(start+8);if(len>0&&12+len<=size)name=bytes.subarray(start+12,start+11+len).toString('ascii');}
    if(type==='mluc'&&size>=28){const records=bytes.readUInt32BE(start+8),recordSize=bytes.readUInt32BE(start+12),len=bytes.readUInt32BE(start+20),at=bytes.readUInt32BE(start+24);if(records&&recordSize>=12&&at+len<=size&&len%2===0)name=Buffer.from(bytes.subarray(start+at,start+at+len)).swap16().toString('utf16le');}
  }
  if(!tags.has('wtpt')||!tags.has('B2A0'))throw designError('ICC 缺少 CMYK 输出转换标签');
  return {name:name.replace(/[\x00-\x1f]/g,'').slice(0,100)||'CMYK ICC',hash:createHash('sha256').update(bytes).digest('hex')};
}

let defaultProfile;
export async function getDefaultPrintProfile(){
  const target=process.env.STUDIO_CMYK_PROFILE||'cmyk';
  if(defaultProfile?.target===target)return defaultProfile;
  try{
    const sample=await sharp({create:{width:1,height:1,channels:3,background:'#ffffff'}}).withIccProfile(target).jpeg().toBuffer();
    const icc=(await sharp(sample).metadata()).icc,info=inspectIcc(icc||Buffer.alloc(0));
    if(process.env.STUDIO_CMYK_PROFILE&&inspectIcc(fs.readFileSync(target)).hash!==info.hash)throw new Error('profile fallback');
    defaultProfile={id:'default',target,icc,...info,custom:Boolean(process.env.STUDIO_CMYK_PROFILE),description:process.env.STUDIO_CMYK_PROFILE?'服务器配置的输出条件':'内置技术验证配置，仅用于测试；可能明显改变颜色，正式印刷请使用印刷方 ICC'};
    return defaultProfile;
  }catch{throw designError('CMYK 配置无法使用，请检查 STUDIO_CMYK_PROFILE 指定的 ICC 文件',503);}
}

export class PrintProfiles{
  constructor(root){this.dir=path.join(root,'print-profiles');fs.mkdirSync(this.dir,{recursive:true});}
  public(profile){const {id,name,description,custom,hash}=profile;return {id,name,description,custom,hash};}
  files(){return fs.readdirSync(this.dir).filter(f=>/^icc-[a-f0-9]{64}\.json$/.test(f));}
  async list(){
    let defaults=[];try{defaults=[this.public(await getDefaultPrintProfile())];}catch{}
    return [...defaults,...this.files().map(file=>JSON.parse(fs.readFileSync(path.join(this.dir,file),'utf8'))).sort((a,b)=>a.name.localeCompare(b.name))];
  }
  async resolve(id='default'){
    if(id==='default')return getDefaultPrintProfile();
    if(!profileId.test(id)||!fs.existsSync(path.join(this.dir,`${id}.json`)))throw designError('所选 ICC 配置不存在，请重新选择',404);
    const icc=fs.readFileSync(path.join(this.dir,`${id}.icc`)),info=inspectIcc(icc);
    if(`icc-${info.hash}`!==id)throw designError('ICC 配置内容校验失败，请重新导入',422);
    return {...JSON.parse(fs.readFileSync(path.join(this.dir,`${id}.json`),'utf8')),target:path.join(this.dir,`${id}.icc`),icc};
  }
  async import(bytes,{name,description}){
    const info=inspectIcc(bytes),id=`icc-${info.hash}`,target=path.join(this.dir,`${id}.icc`);
    if(fs.existsSync(path.join(this.dir,`${id}.json`)))return this.public(await this.resolve(id));
    if(this.files().length>=20)throw designError('最多保留 20 个导入的 ICC 配置');
    const temp=path.join(this.dir,`${id}-${randomUUID()}.tmp.icc`);
    fs.writeFileSync(temp,bytes,{mode:0o600});
    try{
      // Test the actual CMYK transform before making the profile selectable.
      const sampleBytes=await sharp({create:{width:1,height:1,channels:3,background:'#8364ad'}}).withIccProfile(temp).toColourspace('cmyk').jpeg().toBuffer();
      const sample=await sharp(sampleBytes).metadata();
      if(sample.channels!==4||!sample.icc||createHash('sha256').update(sample.icc).digest('hex')!==info.hash)throw new Error('profile fallback');
      if(this.files().length>=20&&!fs.existsSync(path.join(this.dir,`${id}.json`)))throw designError('最多保留 20 个导入的 ICC 配置');
      fs.renameSync(temp,target);
      const metadata={id,name:name||info.name,description:description||'用户导入；请确认与印刷方的输出条件一致',custom:true,hash:info.hash};
      const metadataTemp=path.join(this.dir,`${id}-${randomUUID()}.tmp`);fs.writeFileSync(metadataTemp,JSON.stringify(metadata),{mode:0o600});fs.renameSync(metadataTemp,path.join(this.dir,`${id}.json`));
      return metadata;
    }catch(error){if(error.status)throw error;throw designError('ICC 无法完成 CMYK 颜色转换，请更换印刷配置',422);}
    finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}
  }
}
