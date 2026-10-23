import path from 'node:path';
import fs from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { defaultConfigPath, defaults, findLms, readConfig, saveConfig, validateConfig } from './config.mjs';
import { inspect, lms, status } from './runtime.mjs';
import { startServer } from './server.mjs';
import { submitJob, getJob, cancelJob, listJobs } from './jobs.mjs';
import { listLoops, getLoop, installLoop } from './loops.mjs';
import { listModels, configureModel, prepareModel } from './models.mjs';
import { readControl, setPaused, setScreenshotMode } from './control.mjs';
import { ensureAdmin, openBrowser, launchTray, stopAdmin, stopDesktop, setStartup, syncStartup } from './desktop.mjs';
import { listComponents, installComponent } from './components.mjs';
import { askFile } from './ask.mjs';
import { explorerStatus, setExplorer, syncExplorer } from './desktop.mjs';

const help = `Malyn — a local worker for coding agents

  malyn setup [--profile arc-b580|arc-b60|custom] [--model KEY] [--gpu-pattern REGEX]
  malyn doctor                     Check runtime, GPU and local model
  malyn serve                      Run the stdio MCP server
  malyn tray                       Start the Windows tray (no web server)
  malyn ui [--no-open]              Open the local settings and admin UI
  malyn ui-stop | desktop-stop     Close admin UI / tray; jobs keep running
  malyn pause | resume | control   Control admission of new tasks
  malyn startup on|off|sync        Manage Windows sign-in startup
  malyn explorer on|off|status|sync Manage the Ask Malyn right-click action
  malyn ask ABSOLUTE_FILE          Enriched summary in the local job UI
  malyn screenshots on|off|status  Analyse new clipboard images while tray runs
  malyn submit --root ABS [--loop NAME] [--task TEXT] [--file RELATIVE ...]
               [--image RELATIVE ...] [--model KEY] [--return links|summary]
  malyn loops | loop NAME | loop install ABS_FILE.md
  malyn models | configure --model KEY [--context N] | prepare [--loop NAME]
  malyn components [install whisper|embeddings]  Optional local processors
  malyn check JOB_ID | cancel JOB_ID | jobs

All commands accept --config PATH (or MALYN_CONFIG).
Setup: --lms PATH --context N --max-output N --reasoning-budget N
       --allow-root ABS (repeatable) --force --no-probe
Setup uses an existing LM Studio installation and downloaded model.
Windows ZIP: Install-Malyn.cmd also installs prerequisites and registers Codex.
`;
async function localModel(config) {
  const models = JSON.parse(await lms(config, ['ls', '--json']));
  const model = models.find(m => m.deviceIdentifier == null && m.type === 'llm' && m.modelKey === config.modelKey);
  if (!model) throw new Error(`Model ${config.modelKey} is not installed locally. Use lms ls, or the Windows installer.`);
  return model;
}
export async function main(argv) {
  const { values: v, positionals: p } = parseArgs({ args: argv, allowPositionals: true, options: {
    help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
    config: { type: 'string' }, profile: { type: 'string' }, model: { type: 'string' },
    lms: { type: 'string' }, 'gpu-pattern': { type: 'string' }, context: { type: 'string' },
    'max-output': { type: 'string' }, 'reasoning-budget': { type: 'string' },
    'allow-root': { type: 'string', multiple: true }, force: { type: 'boolean' }, 'no-probe': { type: 'boolean' },
    root: { type: 'string' }, task: { type: 'string' }, file: { type: 'string', multiple: true },
    loop: { type: 'string' }, image: { type: 'string', multiple: true }, return: { type: 'string' },
    'no-open': { type: 'boolean' }, section: { type: 'string' },
    job: {type:'string'},
  } });
  const output = value => console.log(JSON.stringify(value, null, 2));
  if (v.version) { console.log(JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8')).version); return; }
  const command = p[0];
  if (v.help || !command || command === 'help') { console.log(help); return; }
  const filename = path.resolve(v.config ?? defaultConfigPath());
  if(command==='ask'){output(await askFile(filename,p[1],{open:!v['no-open']}));return;}
  if(command==='screenshots'){
    if(!['on','off','status'].includes(p[1]))throw new Error('Use screenshots on, off or status.');
    await readConfig(filename);output(p[1]==='status'?await readControl(filename):await setScreenshotMode(filename,p[1]==='on'));return;
  }
  if(command==='explorer'){
    if(!['on','off','status','sync'].includes(p[1]))throw new Error('Use explorer on, off, status or sync.');
    await readConfig(filename);output(p[1]==='status'?await explorerStatus(filename):p[1]==='sync'?await syncExplorer(filename):await setExplorer(filename,p[1]==='on'));return;
  }
  if(command==='components') {
    if(!p[1])output(await listComponents(filename));
    else if(p[1]==='install')output(await installComponent(filename,p[2],{progress:message=>console.error(message)}));
    else throw new Error('Use components or components install whisper|embeddings.');
    return;
  }
  if (command === 'ui-host') {
    const { startAdminServer } = await import('./admin-server.mjs');
    const app = await startAdminServer(filename);
    for (const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>app.close().catch(()=>{}));
    return;
  }
  if (command === 'ui') {
    await readConfig(filename);
    const session = await ensureAdmin(filename);
    const section = ['overview','settings','jobs','loops','advanced'].includes(v.section) ? v.section : 'overview';
    if(v.job)await getJob(filename,v.job);
    if (!v['no-open']) await openBrowser(`${session.origin}/#token=${session.token}&page=${v.job?'jobs':section}${v.job?'&job='+v.job:''}`);
    output({ admin:session.origin, browserOpened:!v['no-open'], loopbackOnly:true }); return;
  }
  if (command === 'tray') { await readConfig(filename); output(await launchTray(filename)); return; }
  if (command === 'ui-stop') { output(await stopAdmin(filename)); return; }
  if (command === 'desktop-stop') { output(await stopDesktop(filename)); return; }
  if (['pause','resume','control'].includes(command)) {
    await readConfig(filename); output(command==='control'?await readControl(filename):await setPaused(filename,command==='pause')); return;
  }
  if (command === 'startup') {
    if(!['on','off','sync'].includes(p[1]))throw new Error('Use startup on, off or sync.');
    await readConfig(filename); output(p[1]==='sync'?await syncStartup(filename):await setStartup(filename,p[1]==='on')); return;
  }
  if (command === 'serve') { await startServer(filename); return; }
  if (command === 'setup') {
    const profile = v.profile ?? 'arc-b580';
    if (!['arc-b580', 'arc-b60', 'custom'].includes(profile)) throw new Error('Unknown profile; use arc-b580, arc-b60 or custom.');
    if (profile === 'custom' && (!v.model || !v['gpu-pattern'])) throw new Error('Custom setup requires --model and --gpu-pattern.');
    const preset = profile === 'custom' ? {contextLength:16384} : JSON.parse(await fs.readFile(new URL(`../profiles/${profile}.json`,import.meta.url),'utf8'));
    const config = validateConfig({ ...defaults, ...preset, profile, lmsPath: v.lms ?? await findLms(),
      modelKey: v.model ?? preset.modelKey, modelIdentifier: 'malyn-worker',
      gpuPattern: v['gpu-pattern'] ?? preset.gpuPattern,
      contextLength: Number(v.context ?? preset.contextLength),
      maxOutputTokens: Number(v['max-output'] ?? defaults.maxOutputTokens),
      reasoningBudget: Number(v['reasoning-budget'] ?? defaults.reasoningBudget),
      allowedRoots: (v['allow-root'] ?? []).map(p => path.resolve(p)),
    });
    if (!v.force) {
      try { await fs.access(filename); throw new Error('Config already exists. Use --force to back it up and replace it.'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (!v['no-probe']) { await inspect(config); await localModel(config); }
    await saveConfig(filename, config, { overwrite: !!v.force });
    output({ config: filename, profile, probed: !v['no-probe'], inferenceVerified: false, next: 'malyn doctor; then run the smoke test or submit a job.' });
    return;
  }
  if (command === 'check') { output(await getJob(filename, p[1])); return; }
  if (command === 'cancel') { output(await cancelJob(filename, p[1])); return; }
  if (command === 'jobs') { output(await listJobs(filename)); return; }
  if (command === 'loops') { output(await listLoops(filename)); return; }
  if (command === 'loop') {
    if (p[1] === 'install') output(await installLoop(filename, path.resolve(p[2] ?? '')));
    else console.log((await getLoop(filename, p[1])).markdown);
    return;
  }
  if (command === 'configure') {
    const changes = {};
    if (v.model) changes.modelKey = v.model;
    for (const [option, key] of [['context','contextLength'],['max-output','maxOutputTokens'],['reasoning-budget','reasoningBudget']]) if (v[option] !== undefined) changes[key] = Number(v[option]);
    output(await configureModel(filename, changes)); return;
  }
  if (command === 'prepare') { output(await prepareModel(filename, v.loop, v.model)); return; }
  if (!['doctor', 'status', 'submit', 'models'].includes(command)) throw new Error(`Unknown command: ${command}. Run malyn --help.`);
  const config = await readConfig(filename);
  if (command === 'models') { output(await listModels(config)); return; }
  if (command === 'submit') { output(await submitJob(filename, config, { root: v.root, task: v.task, files: v.file, images: v.image, loop: v.loop, modelKey: v.model, returnMode: v.return })); return; }
  const health = await status(config);
  if (command === 'doctor') await localModel(config);
  output({ ...health, config: filename, node: process.version, platform: process.platform, inferenceVerified: false });
}
