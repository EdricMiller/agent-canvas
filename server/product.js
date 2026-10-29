import { z } from 'zod';

export const productSizes = ['1080x1440', '1024x1024', '1024x1536', '1536x1024'];
export const campaignPatchSchema = z.object({
  kind: z.string().trim().max(80).optional(),
  productName: z.string().trim().max(80).optional(),
  audience: z.string().trim().max(200).optional(),
  goal: z.string().trim().max(300).optional(),
  theme: z.string().trim().max(80).optional(),
  headline: z.string().trim().max(300).optional(),
  subtitle: z.string().trim().max(2000).optional(),
  sellingPoints: z.array(z.string().trim().min(1).max(300)).max(30).optional(),
  brand: z.string().trim().max(60).optional(),
  offer: z.string().trim().max(500).optional(),
  cta: z.string().trim().max(200).optional(),
  visual: z.string().trim().max(1500).optional(),
}).strict();
export const emptyCampaign = () => ({ kind:'', productName:'', audience:'', goal:'', theme:'', headline:'', subtitle:'', sellingPoints:[], brand:'', offer:'', cta:'', visual:'' });
export const productPatchSchema = z.object({
  brief: z.string().max(2000).optional(),
  facts: z.array(z.object({ text: z.string().trim().min(1).max(300), basis: z.enum(['user', 'observed', 'unknown']) }).strict()).max(30).optional(),
  campaign: campaignPatchSchema.optional(),
}).strict();

export const isProductSkill = skill => skill?.workflow === 'product-promotion';

// The model cannot increase its own budget via a plan, brief or tool prompt.
// Only a direct, explicit count in this turn's user message permits more than
// one attempt. Ambiguous, quoted and negative instructions retain the default.
export function productImageLimit(prompt) {
  let limit=1;
  const digits={一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9};
  const count=value=>{
    if(/^\d+$/.test(value))return Number(value);
    if(value==='一百')return 100;
    if(value.includes('十')){const [tens,ones]=value.split('十');return (tens?digits[tens]:1)*10+(ones?digits[ones]:0);}
    return digits[value];
  };
  const request=prompt.replace(/```[\s\S]*?```|“[^”]*”|"[^"]*"/g,'');
  for(const clause of request.split(/[，,。.;；\n!?！？]/)){
    if(/不要|不用|别|不必|不需要|无需|禁止|最多|至多|上限|\b(?:not|never|only|at most)\b/i.test(clause))continue;
    const match=clause.trim().match(/^(?:(?:请再|请|帮我|麻烦|再|我想要|我想|我要|需要|改为|改成|只|仅)\s*){0,3}(?:生成|制作|设计|做|出|画|给我|来)\s*(?:总共|一共|共)?\s*(\d+|[一二两三四五六七八九十百]+)\s*(?:张|幅|版)/)
      ||clause.trim().match(/^(?:改为|改成|只要|只需|仅需|仅要)\s*(\d+|[一二两三四五六七八九十百]+)\s*(?:张|幅|版)/)
      ||clause.trim().match(/^(?:please\s+)?(?:generate|create|make)\s+(\d+)\s+(?:images?|pictures?|photos?|versions?|variants?)\b/i);
    if(match){const value=count(match[1]);if(Number.isInteger(value)&&value>=1&&value<=100)limit=value;}
  }
  return limit;
}

// Only an uploaded, non-demo image is an original product reference. Walking the
// branch resolves the original across versions without treating a generated image as proof.
export function productSource(session, versionId) {
  const visited = new Set();
  while (versionId && !visited.has(versionId)) {
    visited.add(versionId);
    const version = session.versions.find(v => v.id === versionId);
    if (!version || version.demo) return null;
    if (version.kind === 'upload') return version;
    const original = session.versions.find(v => v.id === version.productSourceId && v.kind === 'upload' && !v.demo);
    if (original) return original;
    versionId = version.parentId;
  }
  return null;
}

export function syncProduct(session, { restoreVersion = false } = {}) {
  const sourceId = productSource(session, session.selectedId)?.id || null;
  if (!session.product || session.product.sourceId !== sourceId) {
    session.product = { sourceId, brief: '', facts: [], campaign: emptyCampaign() };
  }
  const snapshot=restoreVersion&&session.versions.find(v=>v.id===session.selectedId)?.product;
  if(snapshot?.sourceId===sourceId){
    session.product.brief=snapshot.brief;
    session.product.facts=structuredClone(snapshot.facts);
    session.product.campaign=structuredClone(snapshot.campaign);
  }
  return session.product;
}

export function updateProduct(session, patch) {
  const product = syncProduct(session);
  const {campaign,...rest}=productPatchSchema.parse(patch);
  Object.assign(product,rest);
  if(campaign)product.campaign={...product.campaign,...campaign};
  return product;
}

export function campaignCopyIssue(product) {
  const campaign=product.campaign||{},facts=product.facts||[];
  for(const key of ['brand','offer'])if(campaign[key]&&!facts.some(f=>f.basis==='user'&&f.text.includes(campaign[key])))return `${key==='brand'?'品牌':'价格或活动信息'}缺少用户依据，请先记录用户提供的原文或留空。`;
  for(const point of campaign.sellingPoints||[])if(!facts.some(f=>f.basis!=='unknown'&&f.text.includes(point)))return `卖点“${point}”缺少商品资料依据，请使用已知资料中的原文或移除。`;
  return null;
}

export function productRenderPrompt(prompt, product, size) {
  // Historical art direction is available to the agent; only its current design goes to the image provider.
  return `${prompt}\n\n${size?`目标画布：${size} 像素，请按对应宽高比例构图。\n`:''}商品资料：${JSON.stringify(product?.facts||[])}\n资料中 user 是用户提供、observed 是视觉观察、unknown 是未知项，不把未知信息当成事实。实拍商品是依据，应保留其结构、数量、排列、颜色与自带标识；摄影道具不属于商品。`;
}
