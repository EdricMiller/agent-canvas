import fs from 'node:fs/promises';
import path from 'node:path';
import OpenAI, {toFile} from 'openai';
import sharp from 'sharp';

const source = process.argv[2] || '/Users/edrcijiang/Desktop/菜火生1107/449x153【大门头】.png';
const outputDir = process.argv[3] || '/private/tmp/agent-canvas-gate-model';
const workDir = '/private/tmp/agent-canvas-gate-model/work';
const crop = {left: 800, top: 1900, width: 9000, height: 3000};
const modelWidth = 3840;
const modelHeight = 1280;

if (!process.env.IMAGE_API_KEY) throw new Error('缺少 IMAGE_API_KEY');
const client = new OpenAI({apiKey: process.env.IMAGE_API_KEY, baseURL: process.env.IMAGE_BASE_URL || undefined, maxRetries: 0, timeout: 600000});
await fs.mkdir(workDir, {recursive: true});

const logoCrop = await sharp(source).extract(crop).resize(modelWidth, modelHeight, {fit: 'fill', kernel: 'lanczos3'}).png().toBuffer();
const maskSvg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${modelWidth}" height="${modelHeight}"><rect width="100%" height="100%" fill="white"/><rect x="180" y="160" width="3480" height="930" rx="20" fill="black"/></svg>`);
const mask = await sharp(maskSvg).png().toBuffer();
await fs.writeFile(path.join(workDir, 'input.png'), logoCrop);
await fs.writeFile(path.join(workDir, 'mask.png'), mask);

const response = await client.images.edit({
  model: process.env.IMAGE_MODEL || 'gpt-image-2.5-sunburst',
  image: await toFile(logoCrop, 'brand-source.png', {type: 'image/png'}),
  mask: await toFile(mask, 'brand-mask.png', {type: 'image/png'}),
  prompt: '只修改被黑色遮罩标出的左侧品牌字样。把原图中的“孙四金”替换为“菜火生”，严格保持原图的白色毛笔刷字、粗细、破笔边缘、大小、位置、间距和视觉风格。红色背景、构图、空白区域和未遮罩区域全部保持不变。不要添加其他文字，不要改变任何颜色或版式。',
  size: `${modelWidth}x${modelHeight}`,
  quality: 'high',
});

const data = response.data?.[0]?.b64_json;
if (!data) throw new Error('图片编辑接口没有返回图像');
const edited = Buffer.from(data, 'base64');
await fs.writeFile(path.join(workDir, 'edited.png'), edited);
console.log(JSON.stringify({outputDir, modelWidth, modelHeight, crop}, null, 2));
