const $ = selector => document.querySelector(selector);
const fragment = new URLSearchParams(location.hash.slice(1));
let token = fragment.get('token') || sessionStorage.getItem('malyn-session');
if (token) sessionStorage.setItem('malyn-session',token);
const initialPage = fragment.get('page') || 'overview';
const initialJob=fragment.get('job');let selectedJob;
history.replaceState(null,'',location.pathname);
let state, models = [], busy = false, offline = false, currentPage = 'overview';
const numeric = new Set(['contextLength','maxOutputTokens','reasoningBudget','ttlSeconds','jobTimeoutSeconds','maxPredictionRounds','maxToolCalls']);
function notice(message,error=false) { const node=$('#notice');node.textContent=message;node.hidden=false;node.classList.toggle('error',error); }
async function api(route,data) {
  const response = await fetch(`/api/${route}`,{method:data===undefined?'GET':'POST',headers:{Authorization:`Bearer ${token}`,...(data===undefined?{}:{'Content-Type':'application/json'})},...(data===undefined?{}:{body:JSON.stringify(data)})});
  const result = await response.json();
  if(!response.ok)throw new Error(result.error || 'The request failed.');
  if(result.status==='busy')throw new Error(result.reason || 'A job is running. Try again after it finishes.');
  return result;
}
function action(fn) { return async event=>{try{await fn(event);}catch(error){notice(error.message,true);}}; }
function element(tag,text,className) { const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node; }
function button(text,fn,className='secondary') { const node=element('button',text,className);node.type='button';node.addEventListener('click',action(fn));return node; }
function date(value) { return value ? new Date(value).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'}) : 'Starting'; }
function fillForm(id,settings) {
  const form=$(id);
  for(const input of form.elements) {
    if(!input.name || settings[input.name]===undefined)continue;
    if(input.type==='checkbox')input.checked=settings[input.name];
    else if(input.name==='allowedRoots')input.value=settings.allowedRoots.join('\n');
    else if(input.name==='modelKey')setModelOptions(settings.modelKey);
    else input.value=settings[input.name];
  }
}
function formValues(form) {
  const result={};
  for(const input of form.elements)if(input.name){
    result[input.name]=input.type==='checkbox'?input.checked:numeric.has(input.name)?Number(input.value):input.name==='allowedRoots'?input.value.split(/\r?\n/).map(x=>x.trim()).filter(Boolean):input.value;
  }
  return result;
}
function setModelOptions(selected=state?.settings.modelKey) {
  const select=$('[name=modelKey]');select.replaceChildren();
  const keys=[...new Set([selected,...models.map(model=>model.modelKey)].filter(Boolean))];
  for(const key of keys){const option=element('option',key);option.value=key;select.append(option);}
  select.value=selected;showCapabilities();
}
function showCapabilities() {
  const model=models.find(item=>item.modelKey===$('[name=modelKey]').value);
  $('#model-capabilities').textContent=model ? `${model.vision?'Vision · ':''}${model.trainedForToolUse?'Tool use · ':''}Advertised maximum context: ${Number(model.maxContextLength).toLocaleString()} tokens` : 'Refresh the catalog to inspect local model capabilities.';
}
async function refreshState(initial=false) {
  state=await api('state');offline=false;
  busy=state.jobs.some(job=>job.status==='running');
  $('#version').textContent=`Malyn ${state.displayVersion??state.version}`;
  $('#model-name').textContent=state.settings.modelKey;
  $('#context-size').textContent=Number(state.settings.contextLength).toLocaleString();
  $('#active-count').textContent=busy?'1 running':'Idle';
  $('#worker-state').textContent=state.control.paused?'New tasks paused':busy?'Working locally':'Accepting tasks';
  $('#worker-state').classList.toggle('paused',state.control.paused);
  $('#pause').textContent=state.control.paused?'Resume new tasks':'Pause new tasks';
  $('#screenshot-mode').checked=state.control.screenshotMode;$('#screenshot-mode').disabled=state.platform!=='win32';
  document.querySelectorAll('.model-change').forEach(node=>node.disabled=busy);
  document.querySelectorAll('.busy-note').forEach(node=>node.hidden=!busy);
  renderJobs($('#recent-jobs'),state.jobs.slice(0,4));renderJobs($('#job-list'),state.jobs);
  if(initial){fillForm('#settings-form',state.settings);fillForm('#advanced-form',state.settings);}
  if(selectedJob && currentPage==='jobs')await showJob(selectedJob,true);
}
function renderJobs(container,jobs) {
  container.replaceChildren();
  if(!jobs.length){container.append(element('div','No local jobs yet. Ask your agent to give Malyn a task.','empty'));return;}
  for(const job of jobs){
    const row=button('',()=>showJob(job.id),'job-row');row.append(element('span',job.status==='completed'?'✓':'◌','job-icon'));
    const name=element('span',`Job ${job.id.slice(0,8)}`,'job-name');name.append(element('small',date(job.startedAt)));row.append(name,element('span',job.status,`job-status ${job.status}`));container.append(row);
  }
}
async function showJob(id,refresh=false) {
  if(!refresh)await navigate('jobs');selectedJob=id;const job=await api(`job?id=${encodeURIComponent(id)}`);
  $('#job-detail').hidden=false;$('#job-title').textContent=job.recipe || job.loop || `Job ${id.slice(0,8)}`;
  const details=[job.status,job.status==='running'?job.phase:null,date(job.startedAt),job.model,job.elapsedSeconds?`${job.elapsedSeconds}s`:null,job.lastDecodeTokensPerSecond?`${job.lastDecodeTokensPerSecond.toFixed(1)} tokens/s (last decode)`:null].filter(Boolean);
  $('#job-info').textContent=details.join(' · ');if(!refresh){$('#report').hidden=true;$('#report').textContent='';}
  const actions=$('#job-actions');actions.replaceChildren();
  if(job.status==='running')actions.append(button('Cancel job',async()=>{await api('cancel',{id});notice('Cancellation requested. The job is stopping.');await refreshState();}));
  for(const artifact of job.artifacts)actions.append(button(`Read ${artifact.name} locally`,async()=>{
    const response=await fetch(`/api/artifact?id=${encodeURIComponent(id)}&name=${encodeURIComponent(artifact.name)}`,{headers:{Authorization:`Bearer ${token}`}});
    if(!response.ok)throw new Error('The local report could not be opened.');$('#report').textContent=await response.text();$('#report').hidden=false;
  }));
  if(!job.artifacts.length)actions.append(element('small',job.status==='running'?'Working locally. The report link will appear here when ready.':'No saved artifacts for this run.'));
  if(!refresh)$('#job-detail').scrollIntoView({behavior:'smooth',block:'nearest'});
}
async function refreshModels() {
  models=(await api('models')).models;setModelOptions();
  const result=await api('components'),container=$('#component-list');container.replaceChildren();
  for(const component of result.components){const item=element('div',undefined,'card');item.append(element('h3',component.label),element('p',component.installed?'Installed · loads when needed':'Optional download'),element('small',component.backend));if(!component.installed)item.append(element('pre',component.installCommand));container.append(item);}
}
async function exportRecipe(name) {
  const response=await fetch(`/api/recipes/export?name=${encodeURIComponent(name)}`,{headers:{Authorization:`Bearer ${token}`}});
  if(!response.ok){const result=await response.json();throw new Error(result.error || 'The recipe could not be exported.');}
  const url=URL.createObjectURL(await response.blob()),link=document.createElement('a');
  link.href=url;link.download=`${name}.md`;document.body.append(link);link.click();link.remove();
  setTimeout(()=>URL.revokeObjectURL(url),30000);
  notice(`Recipe sent to your browser downloads: ${name}.md`);
}
async function refreshRecipes() {
  const result=await api('recipes'),container=$('#recipe-list');container.replaceChildren();
  for(const recipe of result.recipes){
    const card=element('article',undefined,'card');card.append(element('h2',recipe.name),element('p',recipe.description,'muted'));
    const tags=element('div',undefined,'tags');
    for(const tag of [recipe.origin==='bundled'?'Included with Malyn':'Your recipe',...recipe.model.capabilities,...(recipe.model.minContextLength?[`${recipe.model.minContextLength.toLocaleString()}+ context`]:[])])tags.append(element('span',tag,'tag'));
    const actions=element('div',undefined,'actions');
    actions.append(button('Read recipe',async()=>{
      $('#recipe-markdown').textContent=(await api(`recipe?name=${encodeURIComponent(recipe.name)}`)).markdown;
      $('#recipe-title').textContent=recipe.name;$('#recipe-detail').hidden=false;$('#recipe-detail').scrollIntoView({behavior:'smooth'});
    }),button('Export recipe',()=>exportRecipe(recipe.name)));
    card.append(tags,actions);container.append(card);
  }
  if(result.errors.length)notice('Some recipes need attention: '+result.errors.map(item=>item.name).join(', '),true);
}
let selectedRecipe, recipeSelection = 0;
async function selectRecipe() {
  const selection=++recipeSelection;
  selectedRecipe=undefined;$('#import-recipe').disabled=true;$('#recipe-preview').hidden=true;$('#recipe-preview-text').textContent='';
  const file=$('#recipe-file').files[0];
  $('#recipe-selection').textContent=file?file.name:'Choose a .md file up to 64 KiB. You can read it here before adding it.';
  if(!file)return;
  if(!/^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.test(file.name) || file.name.length>67)throw new Error('Use a lowercase filename with hyphens, such as my-recipe.md. It must match the name inside the recipe.');
  if(file.size>65536)throw new Error('Recipes must be 64 KiB or smaller.');
  const markdown=new TextDecoder('utf-8',{fatal:true}).decode(await file.arrayBuffer());
  if(selection!==recipeSelection)return;
  selectedRecipe={filename:file.name,markdown};
  $('#recipe-preview-text').textContent=markdown;$('#recipe-preview').hidden=false;
  $('#recipe-selection').textContent=`${file.name} · ${file.size.toLocaleString()} bytes · ready to review`;
  $('#import-recipe').disabled=false;
}
async function preferences() {
  const explorer=await api('explorer');$('#ask-explorer').checked=explorer.askInExplorer;$('#ask-explorer').disabled=!explorer.supported;
  const prefs=await api('preferences');$('#start-windows').checked=prefs.startWithWindows;$('#start-windows').disabled=!prefs.supported;
  if(!prefs.supported)$('#startup-note').textContent='Windows startup controls are only available on Windows.';
}
async function navigate(page) {
  if(page==='loops')page='kitchen';
  if(!['overview','settings','jobs','kitchen','advanced'].includes(page))page='overview';currentPage=page;
  document.querySelectorAll('.page').forEach(node=>node.hidden=node.id!==page);
  document.querySelectorAll('[data-page]').forEach(node=>{if(node.dataset.page===page)node.setAttribute('aria-current','page');else node.removeAttribute('aria-current');});
  const labels={overview:'Overview',settings:'Models & settings',jobs:'Jobs & reports',kitchen:'Kitchen',advanced:'Advanced'};
  $('#breadcrumb').textContent=`Workspace / ${labels[page]}`;
  if(page==='kitchen')await refreshRecipes();
  if(page==='settings'){if(state)fillForm('#settings-form',state.settings);await preferences();await refreshModels();}
  if(page==='advanced' && state)fillForm('#advanced-form',state.settings);
}
document.querySelectorAll('[data-page],[data-go]').forEach(node=>node.addEventListener('click',action(()=>navigate(node.dataset.page || node.dataset.go))));
$('.brand').addEventListener('click',action(event=>{event.preventDefault();return navigate('overview');}));
$('#pause').addEventListener('click',action(async()=>{await api('control',{paused:!state.control.paused});await refreshState();notice(state.control.paused?'New tasks are paused. An active job can finish.':'Malyn is accepting new tasks.');}));
$('#check-runtime').addEventListener('click',action(async()=>{
  $('#check-runtime').disabled=true;$('#runtime-info').textContent='Checking local runtime…';
  try{const runtime=await api('runtime',{});$('#runtime-info').textContent=`${runtime.gpu} · ${runtime.vramGiB} GiB · ${runtime.runtime}. ${runtime.loaded?'Configured model is loaded.':runtime.loadedModel?`Loaded worker model: ${runtime.loadedModel}.`:'Worker model is not loaded.'}`;}catch(error){$('#runtime-info').textContent=error.message;throw error;}finally{$('#check-runtime').disabled=false;}
}));
$('#refresh-models').addEventListener('click',action(async()=>{await refreshModels();notice('Installed model catalog refreshed.');}));
$('[name=modelKey]').addEventListener('change',showCapabilities);
for(const id of ['settings-form','advanced-form'])$('#'+id).addEventListener('submit',action(async event=>{event.preventDefault();const result=await api('settings',formValues(event.target));await refreshState();fillForm('#'+id,result.settings);notice('Settings saved. They apply to the next model load or job.');}));
for(const [id,route,message] of [['load-model','model/load','Configured model loaded.'],['unload-model','model/unload','The worker model is unloaded.']])$('#'+id).addEventListener('click',action(async()=>{$('#'+id).disabled=true;notice('Applying model action…');try{await api(route,{});notice(message);}finally{await refreshState();}}));
$('#start-windows').addEventListener('change',action(async()=>{try{await api('preferences',{startWithWindows:$('#start-windows').checked});notice('Windows startup preference saved.');}finally{await preferences();}}));
$('#ask-explorer').addEventListener('change',action(async()=>{try{await api('explorer',{askInExplorer:$('#ask-explorer').checked});notice('Ask Malyn Explorer preference saved. On Windows 11, use Show more options.');}finally{await preferences();}}));
$('#screenshot-mode').addEventListener('change',action(async()=>{try{await api('screenshots',{screenshotMode:$('#screenshot-mode').checked});notice($('#screenshot-mode').checked?'Screenshot mode enabled. Keep the Malyn tray running, then copy a new screenshot.':'Screenshot mode disabled. A job already submitted can finish.');}finally{await refreshState();}}));
$('#recipe-file').addEventListener('change',action(selectRecipe));
$('#refresh-recipes').addEventListener('click',action(refreshRecipes));
$('#import-recipe-form').addEventListener('submit',action(async event=>{
  event.preventDefault();if(!selectedRecipe)throw new Error('Choose a recipe first.');
  const selection=recipeSelection, recipe=selectedRecipe;$('#import-recipe').disabled=true;
  try{
    const result=await api('recipes/import',recipe);
    if(selection===recipeSelection){event.target.reset();await selectRecipe();}
    await refreshRecipes();notice(`${result.name} is in your Kitchen. Ask Malyn to use it when you’re ready.`);
  }finally{$('#import-recipe').disabled=!selectedRecipe;}
}));
$('#close-ui').addEventListener('click',action(async()=>{await api('close',{});offline=true;notice('Admin server closed. Reopen it from the tray. MCP and active jobs keep running.');}));
if(!token){offline=true;notice('Open Malyn from the tray or run malyn ui to start a local session.',true);}else{
  refreshState(true).then(async()=>{await navigate(initialPage);if(initialJob)await showJob(initialJob);}).catch(error=>{offline=true;notice(error.message,true);});
}
setInterval(()=>{if(!offline)refreshState().catch(()=>{offline=true;notice('The local admin session has ended. Reopen Malyn from the tray.',true);});},8000);
