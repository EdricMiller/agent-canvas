const gcd=(a,b)=>b?gcd(b,a%b):a;
export function targetGeometry(target,generation){
  const d=gcd(target.width,target.height),aspectWidth=target.width/d,aspectHeight=target.height/d;
  const edge=generation?.resolution==='4k'?3840:generation?.resolution==='2k'?2048:1536;
  const limit=Math.min(edge/Math.max(aspectWidth,aspectHeight),Math.sqrt(8294400/(aspectWidth*aspectHeight)));
  const scale=target.mode==='ratio'?generation?.resolution&&generation.resolution!=='auto'?Math.max(1,Math.floor(limit/16)*16):Math.max(1,Math.floor(limit)):d;
  return {width:aspectWidth*scale,height:aspectHeight*scale,aspectWidth,aspectHeight};
}
