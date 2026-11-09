import {parentPort,workerData} from 'node:worker_threads';
import vtracer from '@visioncortex/vtracer';

// WASM tracing is synchronous. Keep it off the web server's event loop;
// the caller limits input size and terminates workers that exceed the deadline.
try{
  const {pixels,width,height}=workerData;
  const svg=vtracer.convertPixels(new Uint8Array(pixels),width,height,{
    preset:'poster',mode:'spline',hierarchical:'stacked',maxColors:32,
    filterSpeckle:4,colorPrecision:6,layerDifference:16,
    pathPrecision:3,simplify:1,optimize:0,
  });
  parentPort.postMessage({svg});
}catch(error){parentPort.postMessage({error:String(error.message||error)});}
