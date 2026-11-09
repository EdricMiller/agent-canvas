import {PDFDocument,PDFName,PDFArray,PDFDict,PDFRawStream,decodePDFRawStream} from 'pdf-lib';
import {createHash} from 'node:crypto';
import {designError} from './document.js';
import {pageGeometry} from './export-settings.js';

// Validate the properties this renderer promises. This is not a PDF/X validator.
export async function inspectPrintPdf(bytes,pages,settings,profile){
  const pdf=await PDFDocument.load(bytes),fail=message=>{throw designError(`印刷文件检查失败：${message}`,502);};
  if(pdf.getPageCount()!==pages.length)fail('页数不一致');
  const near=(a,b)=>Math.abs(a-b)<.02;
  for(const [i,expected] of pages.entries()){
    const page=pdf.getPage(i),g=pageGeometry(expected,settings),trim=page.getTrimBox(),bleed=page.getBleedBox(),media=page.getMediaBox();
    if(!near(trim.x,g.offset)||!near(trim.y,g.offset)||!near(trim.width,expected.width)||!near(trim.height,expected.height)||!near(media.width,g.width)||!near(media.height,g.height)||!near(bleed.x,g.marks)||!near(bleed.y,g.marks)||!near(bleed.width,expected.width+2*g.bleed)||!near(bleed.height,expected.height+2*g.bleed))fail(`第 ${i+1} 页成品框或出血框不一致`);
    const fonts=page.node.Resources()?.lookupMaybe(PDFName.of('Font'),PDFDict);
    if(fonts)for(const key of fonts.keys()){
      const top=fonts.lookup(key,PDFDict),cid=top.lookup(PDFName.of('DescendantFonts'),PDFArray).lookup(0,PDFDict),descriptor=cid.lookup(PDFName.of('FontDescriptor'),PDFDict);
      if(!descriptor.has(PDFName.of('FontFile2'))&&!descriptor.has(PDFName.of('FontFile3')))fail('字体未嵌入');
    }
    const contents=page.node.Contents(),streams=contents instanceof PDFArray?contents.asArray().map(ref=>pdf.context.lookup(ref,PDFRawStream)):contents?[contents]:[];
    const operators=streams.map(stream=>Buffer.from(decodePDFRawStream(stream).decode()).toString()).join('\n');
    if(/(?:^|\s)(?:rg|RG)(?:\s|$)/.test(operators))fail('存在 RGB 图形颜色');
  }
  const intent=pdf.catalog.lookup(PDFName.of('OutputIntents'),PDFArray).lookup(0,PDFDict),icc=intent.lookup(PDFName.of('DestOutputProfile'),PDFRawStream),bytesIcc=Buffer.from(decodePDFRawStream(icc).decode());
  if(icc.dict.lookup(PDFName.of('N')).asNumber()!==4||createHash('sha256').update(bytesIcc).digest('hex')!==profile.hash)fail('ICC 输出配置不一致');
  let images=0,masks=0;
  for(const [,value] of pdf.context.enumerateIndirectObjects()){
    if(!(value instanceof PDFRawStream)||value.dict.get(PDFName.of('Subtype'))?.toString()!=='/Image')continue;
    const space=value.dict.lookup(PDFName.of('ColorSpace'));
    if(space?.toString()==='/DeviceGray'){masks++;continue;}
    if(!(space instanceof PDFArray)||space.lookup(0).toString()!=='/ICCBased'||space.lookup(1,PDFRawStream).dict.lookup(PDFName.of('N')).asNumber()!==4)fail('图片未转换为 CMYK');
    images++;
  }
  return {passed:true,pages:pages.length,images,masks,checks:['page_boxes','embedded_fonts','cmyk_vectors','cmyk_images','target_icc'],pdfX:false};
}
