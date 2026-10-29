import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Skills} from '../server/skills.js';
import {productSource,syncProduct,updateProduct,productRenderPrompt,productImageLimit,campaignCopyIssue} from '../server/product.js';
import {originalFor,productPanelMarkup} from '../public/product.js';

test('product image budget defaults to one; only a direct user count permits more',()=>{
 for(const prompt of ['做个商品宣传图','把背景改浅一点','用这2张参考图做一张成品','生成一张，不满意就再生成两张','生成一张，说明生成两张时的费用','不要生成两张，只做一张','最多生成三张','解释“生成两张”是什么意思','```生成三张```','生成1000张','generate 1 image; if it fails generate 2 images'])assert.equal(productImageLimit(prompt),1,prompt);
 for(const [prompt,count] of [['生成两张商品图',2],['请做3张不同风格',3],['请帮我生成两张',2],['帮我做两张',2],['海边主题，生成二十张',20],['再生成十一张',11],['生成两张，改为生成一张',1],['生成两张，只要一张',1],['生成两张，做一张就好',1],['Please generate 2 images',2]])assert.equal(productImageLimit(prompt),count,prompt);
});


test('image prompts carry current direction and product facts without reintroducing the previous design',()=>{
 const session={versions:[],selectedId:null},product=syncProduct(session);
 assert.equal(product.campaign.kind,'');assert.equal(product.campaign.headline,'');
 updateProduct(session,{brief:'暖白背景，左上大字',campaign:{kind:'新品发布',headline:'温润有光',visual:'米色布面和干花'},facts:[{basis:'observed',text:'可见浅色珠子'}]});
 const prompt=productRenderPrompt('无文案的运动配件宣传图，雨夜街头，蓝紫霓虹与运动节奏',product,'1536x1024');
 assert.match(prompt,/无文案的运动配件/);assert.match(prompt,/雨夜街头/);assert.match(prompt,/1536x1024/);assert.match(prompt,/可见浅色珠子/);assert.match(prompt,/observed/);
 assert.doesNotMatch(prompt,/暖白背景|左上大字|温润有光|米色布面|干花|新品发布/);
 assert.doesNotMatch(prompt,/上文下图|粗黑体|衬线字|奶油色|暖白细沙|服务端准确排版/);
 for(const patch of [{shot:'coastal'},{purpose:'awareness'},{campaign:{mode:'layout'}},{campaign:{layout:'top'}},{campaign:{palette:'warm'}}])assert.throws(()=>updateProduct(session,patch));
});

test('original stays on its upload across edits and branches; switching products clears the previous plan',()=>{
 const original={id:'a',kind:'upload'},other={id:'b',kind:'upload'};
 const session={selectedId:'v3',versions:[original,other,{id:'v2',parentId:'a'},{id:'v3',parentId:'v2'}]};
 assert.equal(productSource(session,'v3'),original);
 updateProduct(session,{brief:'保持主体',facts:[{basis:'user',text:'手链'}],campaign:{headline:'本轮主题',brand:'用户品牌'}});
 session.versions.push({id:'v4',parentId:'v2',productSourceId:'a'});session.selectedId='v4';
 assert.equal(syncProduct(session).sourceId,'a');assert.equal(session.product.facts.length,1);
 assert.equal(originalFor(session,session.versions.at(-1)),original);
 session.selectedId='b';syncProduct(session);
 assert.equal(session.product.sourceId,'b');assert.equal(session.product.brief,'');assert.deepEqual(session.product.facts,[]);
 assert.equal(session.product.campaign.headline,'');assert.equal(session.product.campaign.brand,'');
 session.selectedId=null;syncProduct(session);assert.equal(session.product.sourceId,null);
});

test('campaign patches and version selection preserve each version’s own plan',()=>{
 const session={selectedId:'a',versions:[{id:'a',kind:'upload'}]};syncProduct(session);
 updateProduct(session,{brief:'第一版方案',campaign:{headline:'腕间微光',subtitle:'点缀日常',brand:'用户品牌'}});
 const snapshot=structuredClone(session.product);
 session.versions.push({id:'v2',parentId:'a',productSourceId:'a',product:snapshot});
 updateProduct(session,{campaign:{headline:'新标题'}});
 assert.equal(session.product.campaign.subtitle,'点缀日常');assert.equal(snapshot.campaign.headline,'腕间微光');
 session.selectedId='v2';syncProduct(session,{restoreVersion:true});
 assert.equal(session.product.campaign.headline,'腕间微光');assert.equal(session.product.brief,'第一版方案');
 updateProduct(session,{campaign:{headline:'分支标题'}});assert.equal(snapshot.campaign.headline,'腕间微光');
});

test('factual selling copy requires known facts while creative copy is not forced into a template',()=>{
 const session={versions:[],selectedId:null},product=syncProduct(session);
 product.campaign.headline='把微光，戴进日常';assert.equal(campaignCopyIssue(product),null);
 product.campaign.brand='虚构品牌';assert.match(campaignCopyIssue(product),/品牌/);product.campaign.brand='';
 product.campaign.offer='¥99';assert.match(campaignCopyIssue(product),/活动信息/);product.campaign.offer='';
 product.facts=[{basis:'unknown',text:'天然贝母'}];product.campaign.sellingPoints=['天然贝母'];assert.match(campaignCopyIssue(product),/卖点/);
 updateProduct(session,{facts:[{basis:'user',text:'用户品牌，价格 ¥99'},...Array.from({length:6},(_,i)=>({basis:'observed',text:'可见特征'+i}))],campaign:{brand:'用户品牌',offer:'¥99',sellingPoints:Array.from({length:6},(_,i)=>'可见特征'+i)}});
 assert.equal(campaignCopyIssue(product),null,'the user may request more than three grounded points');
});

test('generated images, demo images, broken branches and cycles cannot prove product identity',()=>{
 const session={versions:[{id:'generated',kind:'generated'},{id:'demo',kind:'upload',demo:true},{id:'cycle1',parentId:'cycle2'},{id:'cycle2',parentId:'cycle1'},{id:'missing',productSourceId:'foreign'},{id:'fake',productSourceId:'generated'}]};
 for(const version of session.versions){assert.equal(productSource(session,version.id),null);assert.equal(originalFor(session,version),null);}
});

test('product brief cannot override the original or invent provenance categories',()=>{
 const session={versions:[],selectedId:null};
 assert.throws(()=>updateProduct(session,{sourceId:'foreign'}));
 assert.throws(()=>updateProduct(session,{facts:[{basis:'confirmed',text:'宝石'}]}));
 const product=updateProduct(session,{facts:[{basis:'unknown',text:'材质未知'}]});
 assert.match(productRenderPrompt('不要道具',product),/不要道具/);
});

test('product UI escapes user and model text and offers no fixed design controls',()=>{
 const unsafe='<img src=x onerror=alert(1)>';
 const panel=productPanelMarkup({versions:[],product:{facts:[{basis:'observed',text:unsafe}],brief:unsafe}});
 assert.ok(!panel.includes(unsafe));assert.match(panel,/视觉观察/);
 assert.doesNotMatch(panel,/productShot|productPurpose|productSize|参考尺寸|<select|editPosterCopy/);
});

test('product Skill exposes design methods and references through the application parser',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'canvas-product-skill-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const skills=new Skills([path.resolve(import.meta.dirname,'../skills')],dir),skill=skills.get('product-promotion');
 assert.equal(skill.workflow,'product-promotion');assert.equal(skill.unsupported,false);
 for(const reference of ['product-fidelity.md','photography.md','art-direction.md','promotion-design.md'])assert.ok(skills.reference(skill,'references/'+reference).length>100);
 assert.match(skill.body,/由 Agent 根据用户本轮/);assert.doesNotMatch(skill.body,/campaign.mode|compose_product_poster|默认.*字体/);
 assert.equal(skills.list().find(s=>s.id==='product-promotion').workflow,'product-promotion');
 assert.equal(skills.get('editorial').workflow,null);
});
