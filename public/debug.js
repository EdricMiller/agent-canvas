const $=id=>document.getElementById(id);
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const roles={conversation:{name:'对话模型',description:'负责理解需求、多轮对话、规划和工具调用',symbol:'✳'},image:{name:'生图模型',description:'负责图片生成与编辑',symbol:'◇'}};

export function initDebugPanel({api,onConfig,toast}) {
  let data,tab='routes',providerId=null,modelId=null,pending=false,notice='';
  const dialog=$('debugDialog');
  const options=(items,selected)=>items.map(item=>`<option value="${esc(item.id)}" ${item.id===selected?'selected':''}>${esc(item.name)}</option>`).join('');
  const providerOptions=selected=>options(data.providers,selected);
  const provider=id=>data.providers.find(item=>item.id===id);
  const adapterName=id=>data.adapters.find(item=>item.id===id)?.name||id;
  function error(message=''){$('debugError').textContent=message;$('debugError').hidden=!message;}
  function lock() {
    dialog.querySelectorAll('[data-debug-write]').forEach(el=>el.disabled=pending||data?.busy);
    dialog.querySelectorAll('[data-debug-tab],#debugRefresh,[data-edit-provider],[data-edit-model],#debugNewProvider,#debugNewModel').forEach(el=>el.disabled=pending);
    const save=$('debugSaveRoutes');if(save)save.disabled=pending||data.busy||!$('debugConversationModel').value||!$('debugImageModel').value;
  }
  async function load() {
    if(pending)return;
    pending=true;notice='';lock();error();
    try{data=await api('/api/debug');render();}
    catch(e){error(e.message);}
    finally{pending=false;lock();}
  }
  async function mutate(url,method,body,after) {
    if(pending)return;
    pending=true;lock();error();
    try {
      data=await api(url,{method,body:JSON.stringify(body)});after?.(data);
      onConfig(await api('/api/config'));notice=data.mode==='demo'?'配置已保存。当前仍为演示模式，重启服务并使用 auto 或 live 模式即可启用真实 API。':'设置已保存，后续任务使用新的配置。';render();toast(notice);
    } catch(e){error(e.message);}
    finally{pending=false;lock();}
  }
  function routeCard(role) {
    const info=roles[role],model=data.models.find(item=>item.id===data.routes[role]);
    const prefix=role==='conversation'?'debugConversation':'debugImage';
    return `<section class="debug-route-card"><div class="debug-card-heading"><span class="debug-symbol">${info.symbol}</span><div><h3>${info.name}</h3><p>${info.description}</p></div></div><label class="debug-field" for="${prefix}Provider">中转站<select id="${prefix}Provider" data-debug-write>${providerOptions(model.providerId)}</select></label><label class="debug-field" for="${prefix}Model">模型<select id="${prefix}Model" data-debug-write></select></label><div class="debug-route-detail" id="${prefix}Detail"></div></section>`;
  }
  function fillRoute(role,selected) {
    const prefix=role==='conversation'?'debugConversation':'debugImage';
    const station=provider($(prefix+'Provider').value),models=data.models.filter(item=>item.providerId===station.id&&item.kind===role);
    $(prefix+'Model').innerHTML=models.length?options(models,selected):'<option value="">请先在模型库添加模型</option>';
    $(prefix+'Detail').innerHTML=`<span class="debug-key-status ${station.configured?'configured':''}">${station.configured?'● 密钥已配置':'○ 未配置密钥'}</span><span>${esc(adapterName(station.adapter))}</span><code>${esc(station.baseURL)}</code>`;
    lock();
  }
  function renderRoutes() {
    return `<div id="debugRoutes" role="tabpanel" aria-labelledby="debugRoutesTab"><div class="debug-route-grid">${routeCard('conversation')}${routeCard('image')}</div><div class="debug-footer"><p>保存后立即生效，历史会话与图片继续保留。<br>对话模型需支持工具调用；理解参考图片需支持图片输入。<br>生成后直接交付，可通过后续对话继续修改。</p><button class="button dark" id="debugSaveRoutes" data-debug-write>保存调用配置</button></div></div>`;
  }
  function renderProviders() {
    const station=provider(providerId),draft=station||{name:'',baseURL:'',adapter:'openai-responses'};
    return `<div id="debugProviders" role="tabpanel" aria-labelledby="debugProvidersTab" class="debug-management"><aside class="debug-catalog"><div class="debug-list-title">已接入 ${data.providers.length} 个中转站</div>${data.providers.map(item=>`<button type="button" class="debug-catalog-item ${item.id===providerId?'selected':''}" data-edit-provider="${esc(item.id)}"><strong>${esc(item.name)}</strong><small>${esc(item.baseURL)}</small><span>${item.configured?'密钥已配置':'未配置密钥'}</span></button>`).join('')}<button class="button outlined" id="debugNewProvider">＋ 添加中转站</button></aside><form id="debugProviderForm" class="debug-editor"><h3>${station?'编辑中转站':'添加中转站'}</h3><label class="debug-field" for="debugProviderName">显示名称<input id="debugProviderName" value="${esc(draft.name)}" placeholder="例如 APIYI" maxlength="200" required data-debug-write></label><label class="debug-field" for="debugProviderURL">接口地址<input id="debugProviderURL" type="url" value="${esc(draft.baseURL)}" placeholder="https://example.com/v1" maxlength="2000" required data-debug-write><small>填写 API 基础地址，通常以 /v1 结尾。</small></label><label class="debug-field" for="debugProviderAdapter">接口适配器<select id="debugProviderAdapter" data-debug-write>${options(data.adapters,draft.adapter)}</select><small>按该站点支持的对话协议选择；生图使用 Images 接口。</small></label><label class="debug-field" for="debugProviderKey">API Key<input id="debugProviderKey" type="password" autocomplete="new-password" spellcheck="false" placeholder="${station?.configured?'已配置 · 留空保留原密钥':'输入该中转站的密钥'}" maxlength="2000" ${station?'':'required'} data-debug-write><small>密钥仅保存在本机服务端，编辑时不回填。更换地址时须重新输入。</small></label><button class="button dark" data-debug-write>保存中转站</button></form></div>`;
  }
  function renderModels() {
    const model=data.models.find(item=>item.id===modelId),draft=model||{providerId:providerId||data.providers[0].id,kind:'conversation',name:'',model:''};
    return `<div id="debugModels" role="tabpanel" aria-labelledby="debugModelsTab" class="debug-management"><aside class="debug-catalog"><div class="debug-list-title">已登记 ${data.models.length} 个模型</div>${data.models.map(item=>`<button type="button" class="debug-catalog-item ${item.id===modelId?'selected':''}" data-edit-model="${esc(item.id)}"><strong>${esc(item.name)}</strong><small>${esc(provider(item.providerId).name)} · ${roles[item.kind].name}</small><code>${esc(item.model)}</code>${Object.values(data.routes).includes(item.id)?'<span class="debug-in-use">当前使用</span>':''}</button>`).join('')}<button class="button outlined" id="debugNewModel">＋ 添加模型</button></aside><form id="debugModelForm" class="debug-editor"><h3>${model?'编辑模型':'添加模型'}</h3><div class="debug-field-pair"><label class="debug-field" for="debugModelProvider">所属中转站<select id="debugModelProvider" data-debug-write>${providerOptions(draft.providerId)}</select></label><label class="debug-field" for="debugModelKind">模型用途<select id="debugModelKind" data-debug-write><option value="conversation" ${draft.kind==='conversation'?'selected':''}>对话模型</option><option value="image" ${draft.kind==='image'?'selected':''}>生图模型</option></select></label></div><label class="debug-field" for="debugModelID">模型 ID<div class="debug-discovery"><input id="debugModelID" value="${esc(draft.model)}" list="debugDiscoveredModels" placeholder="填写中转站实际支持的模型 ID" maxlength="200" required data-debug-write><button class="button outlined small" type="button" id="debugDiscoverModels" data-debug-write>读取列表</button></div><datalist id="debugDiscoveredModels"></datalist><small id="debugDiscoveryNote">可直接手动填写，或从中转站读取可用模型。</small></label><label class="debug-field" for="debugModelName">显示名称 <span class="debug-optional">可选</span><input id="debugModelName" value="${esc(draft.name)}" placeholder="留空使用模型 ID" maxlength="200" data-debug-write></label><p class="debug-editor-note">模型按中转站分别管理。同一个模型 ID 可以接入多个中转站；添加后到「调用路由」选择使用。</p><button class="button dark" data-debug-write>保存模型</button></form></div>`;
  }
  function render() {
    if(!data)return;
    document.querySelectorAll('[data-debug-tab]').forEach(button=>{const active=button.dataset.debugTab===tab;button.setAttribute('aria-selected',String(active));button.tabIndex=active?0:-1;});
    $('debugNotice').textContent=data.busy?'当前有任务正在执行。完成或停止后，点击「刷新状态」即可修改。':notice||(data.mode==='demo'?'当前为演示模式，不调用真实 API。配置密钥后，重启服务并使用 auto 或 live 模式即可启用。':'');
    $('debugNotice').hidden=!$('debugNotice').textContent;$('debugNotice').classList.toggle('debug-success',Boolean(notice)&&!data.busy);
    $('debugContent').innerHTML=(tab==='routes'?renderRoutes():tab==='providers'?renderProviders():renderModels())+'<div class="debug-bottom"><span>配置保存在本机 · 密钥不会随配置返回浏览器</span><button class="button subtle small" id="debugRefresh">刷新状态</button></div>';
    $('debugRefresh').onclick=load;
    if(tab==='routes') {
      for(const role of Object.keys(roles)) {
        const prefix=role==='conversation'?'debugConversation':'debugImage';
        fillRoute(role,data.routes[role]);$(prefix+'Provider').onchange=()=>fillRoute(role);$(prefix+'Model').onchange=lock;
      }
      $('debugSaveRoutes').onclick=()=>mutate('/api/debug/routes','PATCH',{conversation:$('debugConversationModel').value,image:$('debugImageModel').value});
    } else if(tab==='providers') {
      dialog.querySelectorAll('[data-edit-provider]').forEach(button=>button.onclick=()=>{providerId=button.dataset.editProvider;error();render();});
      $('debugNewProvider').onclick=()=>{providerId=null;error();render();$('debugProviderName').focus();};
      $('debugProviderForm').onsubmit=e=>{e.preventDefault();mutate(`/api/debug/providers${providerId?'/'+encodeURIComponent(providerId):''}`,providerId?'PATCH':'POST',{name:$('debugProviderName').value,baseURL:$('debugProviderURL').value,adapter:$('debugProviderAdapter').value,apiKey:$('debugProviderKey').value},result=>providerId=result.savedProviderId);};
    } else {
      dialog.querySelectorAll('[data-edit-model]').forEach(button=>button.onclick=()=>{modelId=button.dataset.editModel;error();render();});
      $('debugNewModel').onclick=()=>{modelId=null;error();render();$('debugModelID').focus();};
      $('debugModelProvider').onchange=()=>{$('debugDiscoveredModels').innerHTML='';$('debugDiscoveryNote').textContent='可直接手动填写，或从中转站读取可用模型。';};
      $('debugDiscoverModels').onclick=async()=>{
        if(pending)return;pending=true;lock();error();$('debugDiscoveryNote').textContent='正在读取该站点的模型列表…';
        try{const result=await api(`/api/debug/providers/${encodeURIComponent($('debugModelProvider').value)}/models`,{method:'POST'});$('debugDiscoveredModels').innerHTML=result.models.map(id=>`<option value="${esc(id)}"></option>`).join('');$('debugDiscoveryNote').textContent=result.models.length?`已读取 ${result.models.length} 个模型，输入 ID 可查看建议。用途需按模型能力选择。`:'接口返回空列表，可手动填写模型 ID。';}
        catch(e){error(e.message);$('debugDiscoveryNote').textContent='读取失败，仍可手动填写模型 ID。';}
        finally{pending=false;lock();}
      };
      $('debugModelForm').onsubmit=e=>{e.preventDefault();mutate(`/api/debug/models${modelId?'/'+encodeURIComponent(modelId):''}`,modelId?'PATCH':'POST',{providerId:$('debugModelProvider').value,kind:$('debugModelKind').value,model:$('debugModelID').value,name:$('debugModelName').value},result=>modelId=result.savedModelId);};
    }
    lock();
  }
  const tabs=[...dialog.querySelectorAll('[data-debug-tab]')];
  tabs.forEach((button,index)=>{
    button.onclick=()=>{tab=button.dataset.debugTab;if(tab==='providers'&&providerId===null)providerId=data?.providers[0]?.id;error();render();};
    button.onkeydown=e=>{let next;if(e.key==='ArrowRight')next=(index+1)%tabs.length;else if(e.key==='ArrowLeft')next=(index+tabs.length-1)%tabs.length;else if(e.key==='Home')next=0;else if(e.key==='End')next=tabs.length-1;if(next!==undefined){e.preventDefault();tabs[next].click();tabs[next].focus();}};
  });
  async function open(){document.querySelectorAll('dialog[open]').forEach(item=>{if(item!==dialog)item.close();});if(!dialog.open)dialog.showModal();await load();}
  $('debugNav').onclick=open;$('debugButton').onclick=open;
  dialog.addEventListener('close',()=>{$('debugProviderKey')&&($('debugProviderKey').value='');});
  return {open};
}
