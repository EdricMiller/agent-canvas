import type {LogoPlacement} from '../lib/types';
type ImageSize={width?:number;height?:number}|undefined;
export function fitLogoPlacement(placement:LogoPlacement,base:ImageSize,logo:ImageSize):LogoPlacement;
export function resizeLogoPlacement(placement:LogoPlacement,base:ImageSize,logo:ImageSize,dimension:'width'|'height',value:number):LogoPlacement;
