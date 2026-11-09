import next from 'next';
import {createApp} from './app.js';

// One local Node process owns long-running Agent jobs, files and the Next UI.
// Keeping a single origin also preserves the existing CSRF token/Origin checks.
export async function createWebApp(config,{dev=false,port=4320,...overrides}={}){
  const frontend=next({dev,dir:config.root,hostname:'127.0.0.1',port,...(dev?{webpack:true}:{})});
  await frontend.prepare();
  const instance=createApp({...config,frontend:'next'},overrides);
  const handle=frontend.getRequestHandler();
  instance.app.use((req,res,nextMiddleware)=>handle(req,res).catch(nextMiddleware));
  return {...instance,async shutdown(){instance.shutdown();await frontend.close();}};
}
