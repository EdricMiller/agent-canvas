import sharp from 'sharp';

const money=/^(?:[$€£¥￥]\s*)?\d+(?:[.,]\d{1,2})?(?:\s*(?:元|円|美元|USD|CNY|RMB))?$/i;
const clean=s=>String(s??'').trim().replace(/\s+/g,' ');

export function validateMenu(input) {
  const menu=input && typeof input==='object' ? input : {};
  const errors=[], warnings=[];
  if (menu.title !== undefined && typeof menu.title !== 'string') errors.push('title 必须是文本');
  if (!Array.isArray(menu.sections) || menu.sections.length<1) errors.push('至少需要一个 sections 分类');
  const seen=new Set(); let itemCount=0;
  for (const [si,section] of (menu.sections||[]).entries()) {
    if (!section || typeof section!=='object' || typeof section.name!=='string' || !clean(section.name)) { errors.push(`第 ${si+1} 个分类缺少 name`); continue; }
    if (!Array.isArray(section.items) || !section.items.length) { errors.push(`分类“${clean(section.name)}”没有菜品`); continue; }
    for (const [ii,item] of section.items.entries()) {
      itemCount++;
      if (!item || typeof item!=='object' || typeof item.name!=='string' || !clean(item.name)) { errors.push(`“${clean(section.name)}”第 ${ii+1} 项缺少菜名`); continue; }
      const name=clean(item.name).toLocaleLowerCase();
      if (seen.has(name)) warnings.push(`菜品“${clean(item.name)}”重复出现`); seen.add(name);
      if (item.price===undefined || item.price===null || !clean(item.price)) warnings.push(`“${clean(item.name)}”缺少价格`);
      else if (!money.test(clean(item.price))) warnings.push(`“${clean(item.name)}”的价格格式无法确认：${clean(item.price)}`);
      if (item.description!==undefined && typeof item.description!=='string') errors.push(`“${clean(item.name)}”的 description 必须是文本`);
      if (item.badges!==undefined && (!Array.isArray(item.badges)||item.badges.some(v=>typeof v!=='string'))) errors.push(`“${clean(item.name)}”的 badges 必须是文本数组`);
    }
  }
  if (itemCount>36) warnings.push('菜品超过 36 项，单张菜单可能难以保持可读性，建议分成多张');
  return {valid:errors.length===0,errors,warnings,itemCount,normalized:{title:clean(menu.title||''),subtitle:clean(menu.subtitle||''),currency:clean(menu.currency||''),sections:(menu.sections||[]).map(s=>({name:clean(s.name),items:(s.items||[]).map(i=>({name:clean(i.name),price:clean(i.price),description:clean(i.description||''),badges:(i.badges||[]).map(clean).filter(Boolean)}))}))}};
}

const esc=s=>String(s??'').replace(/[<>&"']/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[c]));
export async function renderMenu(menu, size, style='warm editorial') {
  const check=validateMenu(menu); if (!check.valid) throw Object.assign(new Error(`菜单数据无效：${check.errors.join('；')}`),{code:'invalid_menu'});
  const [width,height]=String(size||'1024x1536').split('x').map(Number);
  const compact=check.itemCount>18, columns=compact?2:1;
  const pad=compact?64:82, sectionGap=compact?34:48, itemGap=compact?17:28;
  const colWidth=(width-pad*2-(columns-1)*50)/columns;
  const colors=style.toLowerCase().includes('dark')?{bg:'#25221f',fg:'#fffaf1',muted:'#d1c2aa',accent:'#d7a35d',line:'#62574a'}:style.toLowerCase().includes('green')?{bg:'#f3f0e5',fg:'#28453c',muted:'#637a68',accent:'#b36b42',line:'#cbd1bd'}:{bg:'#f7efe3',fg:'#3f3029',muted:'#8f7560',accent:'#b56e45',line:'#dfcbb5'};
  const title=esc(check.normalized.title||'今日菜单'), subtitle=esc(check.normalized.subtitle), sections=check.normalized.sections;
  const currency=check.normalized.currency;
  const displayPrice=price=>{
    const value=clean(price);
    if (!value || !currency || /[$€£¥￥]|\b(?:USD|CNY|RMB)\b|元|円|美元/i.test(value)) return value;
    return `${currency}${value}`;
  };
  const all=sections.flatMap((section,sectionIndex)=>section.items.map(item=>({...item,section:section.name,sectionIndex})));
  const colItems=Array.from({length:columns},()=>[]); all.forEach((item,i)=>colItems[i%columns].push(item));
  let defs=`<defs><filter id="shadow"><feDropShadow dx="0" dy="8" stdDeviation="12" flood-opacity=".10"/></filter></defs>`;
  let body=`<rect width="${width}" height="${height}" rx="18" fill="${colors.bg}"/><circle cx="${width-100}" cy="100" r="130" fill="${colors.accent}" opacity=".08"/><circle cx="90" cy="${height-80}" r="180" fill="${colors.accent}" opacity=".05"/>`;
  body+=`<text x="${width/2}" y="${pad+28}" text-anchor="middle" font-family="Arial, sans-serif" font-weight="700" font-size="${compact?42:54}" letter-spacing="2" fill="${colors.fg}">${title}</text>`;
  if (subtitle) body+=`<text x="${width/2}" y="${pad+65}" text-anchor="middle" font-family="Arial, sans-serif" font-size="20" fill="${colors.muted}">${subtitle}</text>`;
  body+=`<path d="M${width/2-90} ${pad+88}h180" stroke="${colors.accent}" stroke-width="3"/>`;
  const top=pad+140;
  for (let c=0;c<columns;c++) {
    let y=top, lastSection=-1;
    for(const item of colItems[c]) {
      if(item.sectionIndex!==lastSection){
        if(y!==top)y+=sectionGap-8;
        body+=`<text x="${pad+c*(colWidth+50)}" y="${y}" font-family="Arial, sans-serif" font-weight="700" font-size="${compact?21:26}" letter-spacing="1" fill="${colors.accent}">${esc(item.section)}</text>`;
        y+=compact?28:36; lastSection=item.sectionIndex;
      }
      const x=pad+c*(colWidth+50), price=esc(displayPrice(item.price||'待定'));
      body+=`<text x="${x}" y="${y}" font-family="Arial, sans-serif" font-weight="700" font-size="${compact?19:23}" fill="${colors.fg}">${esc(item.name)}</text><text x="${x+colWidth}" y="${y}" text-anchor="end" font-family="Arial, sans-serif" font-weight="700" font-size="${compact?19:23}" fill="${colors.fg}">${price}</text>`;
      y+=compact?20:25;
      if(item.description) { body+=`<text x="${x}" y="${y}" font-family="Arial, sans-serif" font-size="${compact?13:16}" fill="${colors.muted}">${esc(item.description.slice(0,72))}</text>`; y+=compact?18:22; }
      if(item.badges.length) { body+=`<text x="${x}" y="${y}" font-family="Arial, sans-serif" font-size="${compact?11:13}" fill="${colors.accent}">${esc(item.badges.join(' · '))}</text>`; y+=compact?14:17; }
      body+=`<path d="M${x} ${y+5}h${colWidth}" stroke="${colors.line}" stroke-width="1" opacity=".7"/>`; y+=itemGap;
    }
  }
  body+=`<text x="${width/2}" y="${height-38}" text-anchor="middle" font-family="Arial, sans-serif" font-size="12" letter-spacing="2" fill="${colors.muted}">${esc(check.normalized.currency||'')}</text>`;
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${defs}${body}</svg>`;
  return {bytes:await sharp(Buffer.from(svg)).png().toBuffer(),width,height,check};
}
