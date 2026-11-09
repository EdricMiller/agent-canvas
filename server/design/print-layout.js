import {toPoints} from './document.js';

// Coordinates are in points, with a top-left origin. Stored object frames stay
// inside the trim area; print extensions are derived without changing the draft.
export function edgeSides(object,page){
  return {left:object.x<.01,top:object.y<.01,right:object.x+object.width>=page.width-.01,bottom:object.y+object.height>=page.height-.01};
}

export function printObject(object,page,settings,asset){
  if(!settings?.bleedMm||settings.bleedMode!=='objects'||!object.bleed||object.type==='text')return object;
  if(object.type==='image'&&(!asset||object.fit!=='cover'))return object;
  const sides=edgeSides(object,page),b=toPoints(settings.bleedMm,'mm');
  if(!Object.values(sides).some(Boolean))return object;
  const x=object.x-(sides.left?b:0),y=object.y-(sides.top?b:0);
  const width=object.width+(sides.left?b:0)+(sides.right?b:0),height=object.height+(sides.top?b:0)+(sides.bottom?b:0);
  const extended={...object,x,y,width,height,bleedApplied:true};
  if(object.type==='image'){
    // Re-crop the original image proportionally. Never stretch or repeat edge pixels.
    const scale=Math.max(width/asset.width,height/asset.height);
    const imageWidth=asset.width*scale,imageHeight=asset.height*scale;
    extended.draw={x:x+(width-imageWidth)/2,y:y+(height-imageHeight)/2,width:imageWidth,height:imageHeight};
    extended.ppi=72/scale;
  }
  return extended;
}

export function printObjects(page,settings,assets){
  return page.objects.map(o=>printObject(o,page,settings,o.type==='image'?assets.get(o.assetId):null));
}

export function cropSegments(page,g){
  const gap=toPoints(2,'mm'),length=toPoints(5,'mm'),left=g.offset,right=g.offset+page.width,top=g.offset,bottom=g.offset+page.height;
  const lines=[];
  for(const y of [top,bottom])lines.push([left-g.bleed-gap-length,y,left-g.bleed-gap,y],[right+g.bleed+gap,y,right+g.bleed+gap+length,y]);
  for(const x of [left,right])lines.push([x,top-g.bleed-gap-length,x,top-g.bleed-gap],[x,bottom+g.bleed+gap,x,bottom+g.bleed+gap+length]);
  return lines;
}
