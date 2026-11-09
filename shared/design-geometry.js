const clamp=(v,min,max)=>Math.min(Math.max(v,min),Math.max(min,max));
const rounded=v=>Math.round(v*1000000)/1000000;

export function transformBox(page,object,{dx=0,dy=0,handle='move',keepAspect=false,snap=false,tolerance=0}={}){
  const min=page.unit==='mm'?.25:1;
  let {x,y,width,height}=object;const guides=[];
  if(handle==='move'){
    x=clamp(x+dx,0,page.width-width);y=clamp(y+dy,0,page.height-height);
    if(snap){
      const targetsX=[0,page.width/2,page.width],targetsY=[0,page.height/2,page.height];
      for(const o of page.objects)if(o.id!==object.id&&!o.hidden){targetsX.push(o.x,o.x+o.width/2,o.x+o.width);targetsY.push(o.y,o.y+o.height/2,o.y+o.height);}
      const closest=(values,targets)=>{
        let best=null;for(const target of targets)for(const value of values){const distance=target-value;if(Math.abs(distance)<=tolerance&&(!best||Math.abs(distance)<Math.abs(best.distance)))best={target,distance};}return best;
      };
      const sx=closest([x,x+width/2,x+width],targetsX),sy=closest([y,y+height/2,y+height],targetsY);
      if(sx&&x+sx.distance>=0&&x+sx.distance+width<=page.width+.000001){x+=sx.distance;guides.push({axis:'x',value:sx.target});}
      if(sy&&y+sy.distance>=0&&y+sy.distance+height<=page.height+.000001){y+=sy.distance;guides.push({axis:'y',value:sy.target});}
    }
  }else{
    const west=handle.includes('w'),north=handle.includes('n'),right=x+width,bottom=y+height;
    width=clamp(width+(west?-dx:dx),min,west?right:page.width-x);
    height=clamp(height+(north?-dy:dy),min,north?bottom:page.height-y);
    if(keepAspect){
      const ratio=object.width/object.height;
      let h=Math.abs(dx/object.width)>Math.abs(dy/object.height)?width/ratio:height;
      h=clamp(h,Math.max(min,min/ratio),Math.min(north?bottom:page.height-y,(west?right:page.width-x)/ratio));
      height=h;width=h*ratio;
    }
    if(west)x=right-width;if(north)y=bottom-height;
  }
  return {box:Object.fromEntries(Object.entries({x,y,width,height}).map(([k,v])=>[k,rounded(v)])),guides};
}

export function alignBox(page,object,alignment){
  const {x,y,width,height}=object;
  return {x:rounded(Math.max(0,alignment==='left'?0:alignment==='center'?(page.width-width)/2:alignment==='right'?page.width-width:x)),y:rounded(Math.max(0,alignment==='top'?0:alignment==='middle'?(page.height-height)/2:alignment==='bottom'?page.height-height:y)),width,height};
}

export function textSignature(object,unit){
  return JSON.stringify([unit,object.text,object.width,object.height,object.fontSize,object.lineHeight,object.color,object.align]);
}
