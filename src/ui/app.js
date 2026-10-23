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
  $('#version').textContent=`Malyn ${state.version}`;
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
  $('#job-detail').hidden=false;$('#job-title').textContent=job.loop || `Job ${id.slice(0,8)}`;
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
async function refreshLoops() {
  const result=await api('loops'),container=$('#loop-list');container.replaceChildren();
  for(const loop of result.loops){
    const card=element('article',undefined,'card');card.append(element('h2',loop.name),element('p',loop.description,'muted'));
    const tags=element('div',undefined,'tags');for(const tag of [loop.origin,...loop.model.capabilities,...(loop.model.minContextLength?[`${loop.model.minContextLength.toLocaleString()}+ context`]:[])])tags.append(element('span',tag,'tag'));
    card.append(tags,button('Read loop',async()=>{$('#loop-markdown').textContent=(await api(`loop?name=${encodeURIComponent(loop.name)}`)).markdown;$('#loop-detail').hidden=false;$('#loop-detail').scrollIntoView({behavior:'smooth'});}));container.append(card);
  }
  if(result.errors.length)notice('Some loop files could not be loaded: '+result.errors.map(item=>item.name).join(', '),true);
}
async function preferences() {
  const explorer=await api('explorer');$('#ask-explorer').checked=explorer.askInExplorer;$('#ask-explorer').disabled=!explorer.supported;
  const prefs=await api('preferences');$('#start-windows').checked=prefs.startWithWindows;$('#start-windows').disabled=!prefs.supported;
  if(!prefs.supported)$('#startup-note').textContent='Windows startup controls are only available on Windows.';
}
async function navigate(page) {
  if(!['overview','settings','jobs','loops','advanced'].includes(page))page='overview';currentPage=page;
  document.querySelectorAll('.page').forEach(node=>node.hidden=node.id!==page);
  document.querySelectorAll('[data-page]').forEach(node=>{if(node.dataset.page===page)node.setAttribute('aria-current','page');else node.removeAttribute('aria-current');});
  const labels={overview:'Overview',settings:'Models & settings',jobs:'Jobs & reports',loops:'Loops',advanced:'Advanced'};
  $('#breadcrumb').textContent=`Workspace / ${labels[page]}`;
  if(page==='loops')await refreshLoops();
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
$('#install-loop-form').addEventListener('submit',action(async event=>{event.preventDefault();await api('loops/install',{path:event.target.elements.path.value});await refreshLoops();notice('Loop installed. No instructions were executed.');event.target.reset();}));
$('#close-ui').addEventListener('click',action(async()=>{await api('close',{});offline=true;notice('Admin server closed. Reopen it from the tray. MCP and active jobs keep running.');}));
if(!token){offline=true;notice('Open Malyn from the tray or run malyn ui to start a local session.',true);}else{
  refreshState(true).then(async()=>{await navigate(initialPage);if(initialJob)await showJob(initialJob);}).catch(error=>{offline=true;notice(error.message,true);});
}
setInterval(()=>{if(!offline)refreshState().catch(()=>{offline=true;notice('The local admin session has ended. Reopen Malyn from the tray.',true);});},8000);
