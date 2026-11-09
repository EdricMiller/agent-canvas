const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
const logoRatio=(base,logo)=>base?.width>0&&base?.height>0&&logo?.width>0&&logo?.height>0?base.width*logo.height/(base.height*logo.width):null;
const inside=placement=>({...placement,x:clamp(placement.x,0,1-placement.width),y:clamp(placement.y,0,1-placement.height)});

// Use the image's actual fitted box, so transparent letterboxing cannot block dragging.
export function fitLogoPlacement(placement,base,logo){
  const ratio=logoRatio(base,logo);
  if(placement.fit!=='contain'||!ratio)return placement;
  const width=Math.min(placement.width,placement.height/ratio),height=width*ratio;
  return inside({...placement,x:placement.x+(placement.width-width)/2,y:placement.y+(placement.height-height)/2,width,height});
}

export function resizeLogoPlacement(placement,base,logo,dimension,value){
  const next={...fitLogoPlacement(placement,base,logo),[dimension]:clamp(value,.0001,1)};
  const ratio=logoRatio(base,logo);
  if(next.fit==='contain'&&ratio){
    next.width=Math.min(dimension==='width'?next.width:next.height/ratio,1,1/ratio);
    next.height=next.width*ratio;
  }
  return inside(next);
}
