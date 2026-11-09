import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const source = process.argv[2] || '/Users/edrcijiang/Desktop/菜火生1107/449x153【大门头】.png';
const outputDir = process.argv[3] || '/private/tmp/agent-canvas-gate-output';
const width = 4780;
const height = 1000;

const metadata = await sharp(source).metadata();
if (!metadata.width || !metadata.height) throw new Error(`无法读取源图尺寸: ${source}`);

// The source artwork has a clean red field above the white footer strip.
// Cropping that field to 4.78:1 avoids stretching the original lettering.
const cropHeight = Math.round(metadata.width / (width / height));
const cropTop = Math.max(0, Math.min(metadata.height - cropHeight, 2050));
const crop = {left: 0, top: cropTop, width: metadata.width, height: cropHeight};
const background = '#e70d17';

const maskLeft = 1200;
const maskTop = 2200 - cropTop;
const maskWidth = 9500;
const maskHeight = 2400;

const textSvg = Buffer.from(`
<svg xmlns="http://www.w3.org/2000/svg" width="${crop.width}" height="${crop.height}">
  <rect x="${maskLeft}" y="${maskTop}" width="${maskWidth}" height="${maskHeight}" fill="${background}"/>
  <text x="1550" y="${4200 - cropTop}"
        fill="#fff" stroke="#fff" stroke-width="55" paint-order="stroke" font-family="STHeiti, Hiragino Sans GB, Arial Unicode MS, sans-serif"
        font-size="1800" font-weight="900"
        letter-spacing="140">菜火生</text>
</svg>`);

const composited = await sharp(source).extract(crop).composite([{input: textSvg}]).png().toBuffer();
const rendered = await sharp(composited).resize(width, height, {fit: 'fill', kernel: 'lanczos3'}).png().toBuffer();

await fs.mkdir(outputDir, {recursive: true});
const stem = '4780x1000【大门头】-菜火生';
await fs.writeFile(path.join(outputDir, `${stem}.png`), rendered);
await sharp(rendered).jpeg({quality: 95, chromaSubsampling: '4:4:4'}).toFile(path.join(outputDir, `${stem}.jpg`));
await sharp(rendered).webp({quality: 95, effort: 6}).toFile(path.join(outputDir, `${stem}.webp`));

const result = await sharp(rendered).metadata();
console.log(JSON.stringify({source, crop, outputDir, width: result.width, height: result.height}, null, 2));
