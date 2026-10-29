import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Only read these two values; never execute/source a credentials file.
export function loadCredentials(env=process.env) {
  const file=env.STUDIO_CREDENTIALS_FILE;
  const values={};
  if(file) {
    const expanded=file.startsWith('~/')?path.join(os.homedir(),file.slice(2)):file;
    for(const line of fs.readFileSync(expanded,'utf8').split(/\r?\n/)) {
      const m=line.match(/^\s*(?:export\s+)?(OPENAI_API_KEY|OPENAI_BASE_URL)\s*=\s*(.*?)\s*$/);
      if(m)values[m[1]]=m[2].replace(/^(['"])(.*)\1$/,'$2');
    }
  }
  const apiKey=env.OPENAI_API_KEY||values.OPENAI_API_KEY||'';
  const baseURL=env.OPENAI_BASE_URL||values.OPENAI_BASE_URL;
  if(Boolean(env.IMAGE_API_KEY)!==Boolean(env.IMAGE_BASE_URL)) {
    throw new Error('IMAGE_API_KEY 和 IMAGE_BASE_URL 必须同时设置');
  }
  return {apiKey,baseURL,imageApiKey:env.IMAGE_API_KEY||apiKey,imageBaseURL:env.IMAGE_BASE_URL||baseURL};
}
