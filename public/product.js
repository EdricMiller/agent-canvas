const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const basisLabels = { user: '用户提供', observed: '视觉观察', unknown: '待确认' };
const usageLabels = { agent: '规划与对话', image: '图片生成/编辑' };
const callLabels = { completed: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断', running: '进行中' };

export function originalFor(session, version) {
  const seen = new Set();
  while (version && !seen.has(version.id)) {
    seen.add(version.id);
    if (version.demo) return null;
    if (version.kind === 'upload') return version;
    const original = session.versions.find(v => v.id === version.productSourceId && v.kind === 'upload' && !v.demo);
    if (original) return original;
    version = session.versions.find(v => v.id === version.parentId);
  }
  return null;
}

export function productPanelMarkup(session) {
  const product=session.product,campaign=product?.campaign||{};
  const original=session.versions.find(v=>v.id===product?.sourceId);
  const hasDetails=product?.facts?.length||product?.brief||campaign.goal||campaign.audience||campaign.visual||campaign.sellingPoints?.length;
  if(!original&&!hasDetails&&!campaign.headline&&!campaign.theme)return '';
  return `<div class="product-heading">${original?`<img src="${esc(original.url)}" alt="商品原图"><div><strong>商品原图 · V${original.number}</strong><small>实拍作为商品依据，方案随版本保存</small></div>`:'<strong>商品推广方案</strong>'}</div>
    ${campaign.headline||campaign.theme?`<div class="campaign-preview">${campaign.theme?`<small>${esc(campaign.theme)}</small>`:''}<strong>${esc(campaign.headline||campaign.theme)}</strong>${campaign.subtitle?`<p>${esc(campaign.subtitle)}</p>`:''}</div>`:''}
    ${hasDetails?`<details class="product-facts"><summary>商品资料与推广方案</summary>${campaign.goal?`<p>推广目标：${esc(campaign.goal)}</p>`:''}${campaign.audience?`<p>受众：${esc(campaign.audience)}</p>`:''}${campaign.visual?`<p>视觉方向：${esc(campaign.visual)}</p>`:''}${product.brief?`<p>${esc(product.brief)}</p>`:''}${campaign.sellingPoints?.length?`<p>卖点：${campaign.sellingPoints.map(esc).join(' · ')}</p>`:''}<ul>${(product.facts||[]).map(f=>`<li><span>${basisLabels[f.basis]||'待确认'}</span>${esc(f.text)}</li>`).join('')}</ul></details>`:''}`;
}

export function usageSummary(task) {
  const calls = task?.usage || [];
  const entries = calls.flatMap(call => call.kind === 'agent' && call.responses?.length ? call.responses : [call]);
  const sum = key => {
    const values = entries.map(entry => entry.usage?.[key]).filter(value => typeof value === 'number' && Number.isFinite(value));
    return values.length ? values.reduce((a, b) => a + b, 0) : null;
  };
  const complete = entries.length > 0 && calls.every(call => call.status === 'completed') && entries.every(entry => ['inputTokens', 'outputTokens', 'totalTokens'].every(key => typeof entry.usage?.[key] === 'number'));
  return { inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'), totalTokens: sum('totalTokens'), complete, requests: entries.length };
}

export function taskMarkup(task) {
  if (!task?.models && !task?.usage?.length) return '';
  const usage = usageSummary(task);
  const format = value => value === null ? '未知' : value.toLocaleString('zh-CN');
  const duration = task.finishedAt ? Math.max(0, (Date.parse(task.finishedAt) - Date.parse(task.createdAt)) / 1000) : null;
  const breakdown=(task.usage || []).map(call=>{const subtotal=usageSummary({usage:[call]});return `<tr><td>${usageLabels[call.kind] || '模型请求'}</td><td>${format(subtotal.totalTokens)}${subtotal.totalTokens!==null&&!subtotal.complete?'（部分）':''}</td><td>${callLabels[call.status] || '未知'}</td></tr>`;}).join('');
  return `<details class="task-details"><summary>本轮用量 · ${format(usage.totalTokens)} tokens${usage.complete ? '' : '（记录不完整）'}${duration === null ? '' : ` · ${duration.toFixed(1)} 秒`}</summary><div class="task-body"><p>请求的对话模型：${esc(task.models?.agent || '未知')}<br>请求的图片模型：${esc(task.models?.image || '未知')}<br>图片调用：${task.imageCalls || 0} 次</p>${breakdown?`<table class="usage-table"><thead><tr><th>用途</th><th>已知 tokens</th><th>状态</th></tr></thead><tbody>${breakdown}</tbody></table>`:''}<p>已记录输入：${format(usage.inputTokens)} tokens<br>已记录输出：${format(usage.outputTokens)} tokens<br>已记录合计：${format(usage.totalTokens)} tokens</p>${usage.complete ? '' : '<p>部分请求未返回完整用量，以上数字不是本轮完整消耗。</p>'}<p>估算费用：未配置费率<br>实际扣费：未知，需以接口商账单为准</p></div></details>`;
}
