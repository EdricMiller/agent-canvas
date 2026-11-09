import type {DesignDocument,DesignPage} from '../lib/types';
export const MAX_PAGES:20;
export type PageOperation={type:'add'|'duplicate'|'delete';pageId:string}|{type:'move';pageId:string;toIndex:number};
export function findPage(document:DesignDocument,pageId?:string|null):DesignPage;
export function changePages(document:DesignDocument,operation:PageOperation,newId?:()=>string):{document:DesignDocument;selectedId:string};
