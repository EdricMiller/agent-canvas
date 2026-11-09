import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const source = process.argv[2] || '/Users/edrcijiang/Desktop/菜火生1107/449x153【大门头】.png';
const editedPath = process.argv[3] || '/private/tmp/agent-canvas-gate-model/work/edited.png';
const outputDir = process.argv[4] || '/private/tmp/agent-canvas-gate-model/final';
const sourceMeta = await sharp(source).metadata();
const crop = {left: 0, top: 2050, width: sourceMeta.width, height: Math.round(sourceMeta.width / 4.78)};
const logoCrop = {left: 800, top: 1900, width: 9000, height: 3000};
const edited = await sharp(editedPath).resize(logoCrop.width, logoCrop.height, {fit: 'fill', kernel: 'lanczos3'}).removeAlpha().raw().toBuffer({resolveWithObject: true});
const rgba = Buffer.alloc(edited.info.width * edited.info.height * 4);
for (let i = 0, j = 0; i < edited.data.length; i += edited.info.channels, j += 4) {
  const r = edited.data[i], g = edited.data[i + 1], b = edited.data[i + 2];
  const white = Math.min(r, g, b) > 145 && Math.max(r, g, b) - Math.min(r, g, b) < 60;
  if (!white) continue;
  const alpha = Math.max(0, Math.min(255, Math.round((Math.min(r, g, b) - 125) * 2.1)));
  rgba[j] = 255; rgba[j + 1] = 255; rgba[j + 2] = 255; rgba[j + 3] = alpha;
}
const logoLayer = await sharp(rgba, {raw: {width: edited.info.width, height: edited.info.height, channels: 4}}).png().toBuffer();
const maskSvg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${sourceMeta.width}" height="${sourceMeta.height}"><rect x="1200" y="2200" width="9500" height="2400" fill="#e70d17"/></svg>`);
const fullComposite = await sharp(source).composite([
  {input: maskSvg},
  {input: logoLayer, left: logoCrop.left, top: logoCrop.top},
]).png().toBuffer();
const composited = await sharp(fullComposite).extract(crop).png().toBuffer();
const rendered = await sharp(composited).resize(4780, 1000, {fit: 'fill', kernel: 'lanczos3'}).png().toBuffer();
await fs.mkdir(outputDir, {recursive: true});
const stem = '4780x1000【大门头】-菜火生-原笔刷风格';
await fs.writeFile(path.join(outputDir, `${stem}.png`), rendered);
await sharp(rendered).jpeg({quality: 95, chromaSubsampling: '4:4:4'}).toFile(path.join(outputDir, `${stem}.jpg`));
await sharp(rendered).webp({quality: 95, effort: 6}).toFile(path.join(outputDir, `${stem}.webp`));
console.log(JSON.stringify({outputDir, crop, width: 4780, height: 1000}, null, 2));
