import type {DesignDocument} from '../lib/types';
export type ObjectOperation={type:'duplicate'}|{type:'lock'|'visibility';value:boolean}|{type:'replace';assetId:string}|{type:'order';direction:'front'|'back'|'forward'|'backward'};
export function changeObject(document:DesignDocument,pageId:string,objectId:string,operation:ObjectOperation,newId?:()=>string):{document:DesignDocument;selectedId:string};
export function lockedBinding(document:DesignDocument,bindingId?:string):boolean;
export function assertLockedObjectsUnchanged(before:DesignDocument,after:DesignDocument):void;
