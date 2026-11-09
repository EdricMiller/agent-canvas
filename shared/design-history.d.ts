import type {DesignDocument} from '../lib/types';
export type EditorSnapshot={document:DesignDocument;pageId:string|null;selected:string|null};
export class DesignHistory{
  constructor(options?:{limit?:number;maxBytes?:number});
  clear():void;endGroup():void;
  record(before:EditorSnapshot,after:EditorSnapshot,group?:string|null):boolean;
  undo(current:EditorSnapshot):EditorSnapshot|null;redo(current:EditorSnapshot):EditorSnapshot|null;
  readonly canUndo:boolean;readonly canRedo:boolean;
}
