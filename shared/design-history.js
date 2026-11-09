// Local edit history is separate from persisted design versions. Snapshots are
// immutable editor states, including page and selection. Bound memory as well as
// count because a document can contain many pages and long content fields.
export class DesignHistory{
  constructor({limit=100,maxBytes=12*1024*1024}={}){this.limit=limit;this.maxBytes=maxBytes;this.clear();}
  clear(){this.past=[];this.future=[];this.group=null;}
  endGroup(){this.group=null;}
  record(before,after,group=null){
    if(JSON.stringify(before.document)===JSON.stringify(after.document))return false;
    if(!group||this.group!==group)this.past.push(structuredClone(before));
    this.group=group;this.future=[];
    while(this.past.length>this.limit)this.past.shift();
    let size=0;
    for(let i=this.past.length-1;i>=0;i--){size+=JSON.stringify(this.past[i]).length*2;if(size>this.maxBytes){this.past.splice(0,i+1);break;}}
    return true;
  }
  undo(current){if(!this.past.length)return null;this.endGroup();this.future.push(structuredClone(current));return this.past.pop();}
  redo(current){if(!this.future.length)return null;this.endGroup();this.past.push(structuredClone(current));return this.future.pop();}
  get canUndo(){return this.past.length>0;}
  get canRedo(){return this.future.length>0;}
}
