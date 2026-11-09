import sharp from 'sharp';
import {z} from 'zod';

const point=z.object({x:z.number().min(0).max(1),y:z.number().min(0).max(1)}).strict();
export const protectedAreasSchema=z.array(z.array(point).min(3).max(128).refine(points=>Math.abs(points.reduce((sum,p,i)=>{const q=points[(i+1)%points.length];return sum+p.x*q.y-q.x*p.y;},0))>1e-8,'保护区必须围成非零面积')).max(16).default([]);
const bounds=z.object({x:z.number().min(0).max(1),y:z.number().min(0).max(1),width:z.number().positive().max(1),height:z.number().positive().max(1)}).strict()
  .refine(b=>b.x+b.width<=1.000001&&b.y+b.height<=1.000001,'选区不能超出图片');
export const colorRegionsSchema=z.array(z.object({
  seeds:z.array(point).min(1).max(16),
  color:z.string().regex(/^#[\da-f]{6}$/i),
  tolerance:z.number().min(0).max(80).default(24),
  mode:z.enum(['connected','matching']).default('connected'),
  bounds:bounds.nullable().default(null),
}).strict().superRefine((r,ctx)=>{
  if(r.mode==='matching'&&!r.bounds)ctx.addIssue({code:'custom',message:'匹配颜色必须限定选区，不能在整张商品图中全局换色'});
  if(r.bounds&&r.seeds.some(s=>s.x<r.bounds.x||s.x>r.bounds.x+r.bounds.width||s.y<r.bounds.y||s.y>r.bounds.y+r.bounds.height))ctx.addIssue({code:'custom',message:'取色点必须在选区内'});
})).min(1).max(12);

// A color selection, not semantic background extraction: only selected pixels
// change. Sample every region from the original, so replacements cannot cascade.
export async function recolorImage(input,regions,{signal,protect=[]}={}){
  const parsed=colorRegionsSchema.parse(regions);
  const {data,info}=await sharp(input,{limitInputPixels:25000000}).rotate().toColourspace('srgb').ensureAlpha().raw().toBuffer({resolveWithObject:true});
  const {width,height}=info,count=width*height,output=Buffer.from(data),queue=new Uint32Array(count),selected=new Uint8Array(count),visited=new Uint8Array(count);
  const protectedPixels=new Uint8Array(count);
  // Rasterize explicit foreground polygons at pixel centers using even/odd fill.
  // This prevents same-colored product details from leaking into the selection.
  for(const polygon of protectedAreasSchema.parse(protect))for(let y=0;y<height;y++){
    const scan=(y+.5)/height,crossings=[];
    for(let i=0;i<polygon.length;i++){
      const a=polygon[i],b=polygon[(i+1)%polygon.length];
      if((a.y>scan)!==(b.y>scan))crossings.push((a.x+(scan-a.y)*(b.x-a.x)/(b.y-a.y))*width);
    }
    crossings.sort((a,b)=>a-b);
    for(let i=0;i+1<crossings.length;i+=2)for(let x=Math.max(0,Math.ceil(crossings[i]-.5));x<Math.min(width,Math.ceil(crossings[i+1]-.5));x++)protectedPixels[y*width+x]=1;
  }
  const position=s=>[Math.min(width-1,Math.floor(s.x*width)),Math.min(height-1,Math.floor(s.y*height))];
  for(const region of parsed){
    signal?.throwIfAborted();selected.fill(0);
    const b=region.bounds, x0=b?Math.floor(b.x*width):0,y0=b?Math.floor(b.y*height):0,x1=b?Math.min(width,Math.ceil((b.x+b.width)*width)):width,y1=b?Math.min(height,Math.ceil((b.y+b.height)*height)):height;
    const samples=region.seeds.map(position).map(([x,y])=>({x,y,offset:(y*width+x)*4}));
    if(samples.some(s=>s.x<x0||s.x>=x1||s.y<y0||s.y>=y1))throw new Error('取色点必须位于选区内部');
    for(const s of samples){if(protectedPixels[s.offset/4])throw new Error('取色点在商品保护区内，请选择保护区之外的背景');if(data[s.offset+3]===0)throw new Error('取色点在透明区域，请选择可见背景中的点');}
    const matches=(i,s)=>!protectedPixels[i]&&data[i*4+3]>0&&(data[i*4]-data[s.offset])**2+(data[i*4+1]-data[s.offset+1])**2+(data[i*4+2]-data[s.offset+2])**2<=region.tolerance**2;
    if(region.mode==='matching'){
      for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++){
        const i=y*width+x;if(samples.some(s=>matches(i,s)))selected[i]=1;
      }
    }else for(const s of samples){
      const seed=s.y*width+s.x;if(selected[seed])continue;
      visited.fill(0);let head=0,tail=0;
      const visit=i=>{if(!visited[i]){visited[i]=1;if(matches(i,s)){selected[i]=1;queue[tail++]=i;}}};
      visit(seed);
      while(head<tail){
        if((head&32767)===0)signal?.throwIfAborted();
        const i=queue[head++],x=i%width,y=Math.floor(i/width);
        if(x>x0)visit(i-1);if(x+1<x1)visit(i+1);if(y>y0)visit(i-width);if(y+1<y1)visit(i+width);
      }
    }
    const rgb=[1,3,5].map(start=>parseInt(region.color.slice(start,start+2),16));
    for(let i=0;i<count;i++)if(selected[i]){output[i*4]=rgb[0];output[i*4+1]=rgb[1];output[i*4+2]=rgb[2];}
  }
  let changedPixels=0;
  for(let i=0;i<count;i++)if(output[i*4]!==data[i*4]||output[i*4+1]!==data[i*4+1]||output[i*4+2]!==data[i*4+2])changedPixels++;
  if(!changedPixels)throw new Error('选区没有产生颜色变化，请确认取色点、目标颜色与范围');
  return {bytes:await sharp(output,{raw:{width,height,channels:4}}).png().toBuffer(),width,height,changedPixels,preservedPixels:count-changedPixels};
}
