import type {DesignPage,DesignObject,TextObject,Unit} from '../lib/types';
export type ObjectBox=Pick<DesignObject,'x'|'y'|'width'|'height'>;
export type Guide={axis:'x'|'y';value:number};
export type Alignment='left'|'center'|'right'|'top'|'middle'|'bottom';
export function transformBox(page:DesignPage,object:DesignObject,options?:{dx?:number;dy?:number;handle?:string;keepAspect?:boolean;snap?:boolean;tolerance?:number}):{box:ObjectBox;guides:Guide[]};
export function alignBox(page:DesignPage,object:DesignObject,alignment:Alignment):ObjectBox;
export function textSignature(object:TextObject,unit:Unit):string;
