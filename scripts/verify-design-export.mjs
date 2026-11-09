import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {designFixture} from '../tests/fixtures/design.mjs';
import {readAndRenderPdf} from '../tests/helpers/pdf.mjs';
import {layoutDocument,renderPreview,renderPdf} from '../server/design/render.js';

const dir=path.resolve('test-results/design');fs.mkdirSync(dir,{recursive:true});
const fixture=await designFixture(),layout=await layoutDocument(fixture.document,fixture.resolveAsset);
assert.equal(layout.issues.filter(i=>i.severity==='error').length,0);
fs.writeFileSync(path.join(dir,'preview.png'),(await renderPreview(layout)).bytes);
for(const colorSpace of ['rgb','cmyk']){
  const result=await renderPdf(layout,{colorSpace}),rendered=await readAndRenderPdf(result.bytes);
  assert.match(rendered.text,/让好想法，成为好设计/);
  fs.writeFileSync(path.join(dir,`design-${colorSpace}.pdf`),result.bytes);
  fs.writeFileSync(path.join(dir,`design-${colorSpace}.png`),rendered.png);
  console.log(`${colorSpace.toUpperCase()}: Chinese text extracted, rendered ${Math.round(rendered.width)}×${Math.round(rendered.height)}, ${result.bytes.length} bytes${result.profile?`, ICC: ${result.profile}`:''}`);
}
console.log('PDF/X: not certified; no conformance label is emitted. Review PNGs in test-results/design/.');
