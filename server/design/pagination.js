import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {designCanvasSchema,documentSchema,designError,toPoints} from './document.js';
import {measureDesignText} from './render.js';

export const paginationOptionsSchema=z.object({
  heading:z.string().trim().min(1).max(200),
  rows:z.array(z.object({name:z.string().trim().min(1).max(500),value:z.string().max(200),description:z.string().max(2000),status:z.enum(['confirmed','needs_confirmation']),sourceId:z.string().uuid().optional()}).strict()).min(1).max(250),
  columns:z.number().int().min(1).max(3).default(1),
  fontSize:z.number().min(10).max(36).default(12),
  color:z.string().regex(/^#[\da-f]{6}$/i).default('#292a31'),
  logoId:z.string().uuid().optional(),
}).strict();

// Flow whole rows down each column and then onto a new page. Measuring uses the
// same font, wrapping and line height as preview/PDF; nothing is truncated.
export function paginateDesign(canvasInput,optionsInput,existing){
  const canvas=designCanvasSchema.parse(canvasInput),options=paginationOptionsSchema.parse(optionsInput);
  const document=existing?structuredClone(existing):{schemaVersion:1,title:canvas.title,pages:[],content:[]};
  document.content??=[];
  const firstPage=document.pages.length,unit=toPoints(1,canvas.unit),fromPoints=n=>n/unit;
  const {width,height,background}=canvas,margin=Math.min(width,height)*.07,gap=margin*.65;
  const columnWidth=(width-2*margin-gap*(options.columns-1))/options.columns;
  const font=options.fontSize,small=font*.85,headingSize=font*1.6;
  const logoSize=options.logoId?Math.min(width*.16,height*.13):0;
  const headingWidth=width-margin*2-(logoSize?logoSize+gap:0);
  const headingMetrics=measureDesignText(options.heading,toPoints(headingWidth,canvas.unit),headingSize);
  const top=margin+Math.max(fromPoints(headingMetrics.height),logoSize)+gap;
  const bottom=height-margin;
  if(columnWidth<=0||headingMetrics.width>toPoints(headingWidth,canvas.unit)+.01||top>=bottom)throw designError('画布过小，标题或内容区放不下。请增大尺寸、减少分栏或减小字号');
  const titleField={id:randomUUID(),label:'清单标题',value:options.heading,status:'confirmed'};document.content.push(titleField);
  const text=(field,x,y,w,h,size=font,align='left')=>({id:randomUUID(),type:'text',bindingId:field.id,text:field.value,x,y,width:w,height:h,fontSize:size,lineHeight:1.35,color:options.color,align});
  let page,column=0,y=top;
  const nextPage=()=>{
    if(document.pages.length>=20)throw designError('内容超过 20 页上限，未保存任何部分。请减少条目或调整字号、画布尺寸');
    page={id:randomUUID(),name:options.heading.slice(0,100),width,height,unit:canvas.unit,background,objects:[text(titleField,margin,margin,headingWidth,fromPoints(headingMetrics.height)+.002,headingSize)]};
    if(options.logoId)page.objects.push({id:randomUUID(),type:'image',assetId:options.logoId,x:width-margin-logoSize,y:margin,width:logoSize,height:logoSize,fit:'contain'});
    document.pages.push(page);column=0;y=top;
  };
  const field=(label,value,row)=>({id:randomUUID(),label:label.slice(0,100),value,status:row.status,...(row.sourceId?{sourceId:row.sourceId}:{})});
  nextPage();
  for(const [index,row] of options.rows.entries()){
    const valueWidth=row.value?columnWidth*.27:0,nameWidth=columnWidth-(valueWidth?valueWidth+gap*.3:0);
    const nameMetrics=measureDesignText(row.name,toPoints(nameWidth,canvas.unit),font);
    const valueMetrics=row.value?measureDesignText(row.value,toPoints(valueWidth,canvas.unit),font):{height:0,width:0};
    const descriptionMetrics=row.description?measureDesignText(row.description,toPoints(columnWidth,canvas.unit),small):{height:0,width:0};
    const mainHeight=fromPoints(Math.max(nameMetrics.height,valueMetrics.height))+.002;
    const detailGap=row.description?fromPoints(font*.25):0;
    const detailHeight=row.description?fromPoints(descriptionMetrics.height)+.002:0;
    const rowHeight=mainHeight+detailGap+detailHeight;
    if(rowHeight>bottom-top+.0001||nameMetrics.width>toPoints(nameWidth,canvas.unit)+.01||valueMetrics.width>toPoints(valueWidth,canvas.unit)+.01||descriptionMetrics.width>toPoints(columnWidth,canvas.unit)+.01)throw designError(`第 ${index+1} 条“${row.name.slice(0,30)}”无法完整放入单栏，请增大画布、减少分栏或减小字号`);
    const objectCount=1+Number(Boolean(row.value))+Number(Boolean(row.description));
    if(page.objects.length+objectCount>300)nextPage();
    else if(y+rowHeight>bottom+.0001){column++;y=top;if(column>=options.columns)nextPage();}
    const x=margin+column*(columnWidth+gap),name=field(row.name,row.name,row);document.content.push(name);
    page.objects.push(text(name,x,y,nameWidth,mainHeight));
    if(row.value){const value=field(`${row.name} · 值`,row.value,row);document.content.push(value);page.objects.push(text(value,x+columnWidth-valueWidth,y,valueWidth,mainHeight,font,'right'));}
    if(row.description){const description=field(`${row.name} · 说明`,row.description,row);document.content.push(description);page.objects.push(text(description,x,y+mainHeight+detailGap,columnWidth,detailHeight,small));}
    y+=rowHeight+fromPoints(font*.65);
  }
  if(document.content.length>1000)throw designError('分页后内容超过 1000 项上限，未保存任何部分');
  return {document:documentSchema.parse(document),pageIds:document.pages.slice(firstPage).map(p=>p.id),rowCount:options.rows.length};
}
