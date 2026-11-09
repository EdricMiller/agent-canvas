import type {ImageTarget,ImageGeneration} from '../lib/types';
export const DEFAULT_IMAGE_GENERATION:Readonly<ImageGeneration>;
export const QUALITY_LABELS:Record<ImageGeneration['quality'],string>;
export function generationSettings(value?:ImageGeneration|null):ImageGeneration;
export function customImageSizes(model?:string,baseURL?:string):boolean;
export function extendedImageQuality(model?:string):boolean;
export function imageGenerationPlan(target:ImageTarget|null|undefined,value:ImageGeneration|undefined,model:string,fallbackSize?:string,baseURL?:string):{size:string;quality:ImageGeneration['quality'];width:number|null;height:number|null;experimental:boolean;adapted:boolean};
