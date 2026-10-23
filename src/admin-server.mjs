import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readConfig } from './config.mjs';
import { alive, listJobs, getJob, cancelJob, jobsDirectory, withSubmissionLock, releaseLock } from './jobs.mjs';
import { readControl, setPaused, setScreenshotMode } from './control.mjs';
import { configureAdmin, visibleSettings } from './admin-settings.mjs';
import { listModels, prepareModel, unloadModel } from './models.mjs';
import { listLoops, getLoop, installLoop } from './loops.mjs';
import { listRecipes, getRecipe, importRecipe, exportRecipe, maxRecipeBytes } from './recipes.mjs';
import { status } from './runtime.mjs';
import { inside } from './files.mjs';
import { startupStatus, setStartup, explorerStatus, setExplorer } from './desktop.mjs';
import { listComponents } from './components.mjs';

export const sessionPath = config => path.join(path.dirname(path.resolve(config)), 'admin-session.json');
const uiRoot = fileURLToPath(new URL('./ui/', import.meta.url));
const assets = new Map([['/', ['index.html','text/html; charset=utf-8']], ['/app.js',['app.js','text/javascript; charset=utf-8']], ['/style.css',['style.css','text/css; charset=utf-8']], ['/logo.png',['logo.png','image/png']], ['/tray.png',['tray.png','image/png']]]);
const cleanJob = job => Object.fromEntries(['id','status','phase','startedAt','finishedAt','recipe','loop','model','gpu','contextLength','elapsedSeconds','localPromptTokens','localGeneratedTokens','lastDecodeTokensPerSecond'].filter(key => job[key] !== undefined).map(key => [key,job[key]]));
function reject(statusCode, message) { throw Object.assign(new Error(message), { statusCode }); }
async function body(req, limit = 32768) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) reject(415, 'Send application/json.');
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > limit) reject(413, 'Request too large.'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { reject(400,'Invalid JSON.'); }
}
export async function readArtifact(config, id, name) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(name ?? '')) reject(400,'Invalid artifact name.');
  const job = await getJob(config, id);
  const entry = job.artifacts?.find(item => path.basename(item.path) === name);
  if (!entry) reject(404,'Artifact not found.');
  const directory = path.join(jobsDirectory(config), id), filename = path.join(directory, name);
  const stat = await fs.lstat(filename);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 250000 || !inside(await fs.realpath(directory), await fs.realpath(filename))) reject(403,'Artifact is outside the permitted report directory.');
  return fs.readFile(filename);
}
export async function startAdminServer(configPath, options = {}) {
  configPath = path.resolve(configPath);
  await readConfig(configPath);
  const directory = path.dirname(configPath), lockFile = path.join(directory,'admin.lock'), id = randomUUID();
  const claim = await withSubmissionLock(configPath, async () => {
    try {
      const owner = JSON.parse(await fs.readFile(lockFile,'utf8'));
      if (alive(owner.pid)) return { status:'busy' };
      await fs.rm(lockFile);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await fs.writeFile(lockFile,JSON.stringify({id,pid:process.pid}),{flag:'wx',mode:0o600});
    return { claimed:true };
  });
  if (!claim.claimed) throw new Error('Malyn admin is already starting or running.');
  const token = randomBytes(32).toString('hex');
  let origin, timer, lastActivity = Date.now(), pending = 0, closed = false;
  const json = (res, data, code = 200) => { res.writeHead(code,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify(data)); };
  const server = http.createServer(async (req,res) => {
    for (const [key,value] of Object.entries({
      'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',
      'Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      'Cross-Origin-Resource-Policy':'same-origin',
    })) res.setHeader(key,value);
    try {
      if (req.headers.host !== new URL(origin).host) reject(403,'Invalid local host.');
      if (req.headers.origin && req.headers.origin !== origin) reject(403,'Cross-origin requests are not permitted.');
      const url = new URL(req.url,origin);
      // A browser or extension may open the public shell as a cross-site navigation.
      // Only the top-level document is public; API and subresource checks stay strict.
      const openingShell = req.method === 'GET' && url.pathname === '/' &&
        req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document';
      if (req.headers['sec-fetch-site'] === 'cross-site' && !openingShell) reject(403,'Cross-site requests are not permitted.');
      if (req.method === 'GET' && assets.has(url.pathname)) {
        const [name,type] = assets.get(url.pathname);
        res.writeHead(200,{'Content-Type':type}); res.end(await fs.readFile(path.join(uiRoot,name))); return;
      }
      const supplied = Buffer.from(req.headers.authorization ?? ''), expected = Buffer.from(`Bearer ${token}`);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied,expected)) reject(401,'Open Malyn from the tray or run malyn ui to reconnect.');
      lastActivity = Date.now(); pending++;
      try {
        if (req.method === 'GET' && url.pathname === '/api/ping') return json(res,{ok:true});
        if (req.method === 'GET' && url.pathname === '/api/state') {
          const [config,control,jobs,version] = await Promise.all([readConfig(configPath),readControl(configPath),listJobs(configPath,50),fs.readFile(new URL('../package.json',import.meta.url),'utf8')]);
          const metadata=JSON.parse(version);
          return json(res,{version:metadata.version,displayVersion:metadata.displayVersion??metadata.version,settings:visibleSettings(config),control,jobs,platform:process.platform});
        }
        if (req.method === 'GET' && url.pathname === '/api/models') return json(res,await (options.listModels ?? listModels)(await readConfig(configPath)));
        if (req.method === 'GET' && url.pathname === '/api/components') return json(res,await listComponents(configPath));
        if (req.method === 'GET' && url.pathname === '/api/recipes') return json(res,await listRecipes(configPath));
        if (req.method === 'GET' && url.pathname === '/api/recipe') return json(res,{markdown:(await getRecipe(configPath,url.searchParams.get('name'))).markdown});
        if (req.method === 'GET' && url.pathname === '/api/recipes/export') {
          const recipe = await exportRecipe(configPath,url.searchParams.get('name'));
          res.writeHead(200,{'Content-Type':'text/markdown; charset=utf-8','Content-Disposition':`attachment; filename="${recipe.filename}"`});
          res.end(recipe.markdown); return;
        }
        if (req.method === 'GET' && url.pathname === '/api/loops') return json(res,await listLoops(configPath));
        if (req.method === 'GET' && url.pathname === '/api/loop') return json(res,{markdown:(await getLoop(configPath,url.searchParams.get('name'))).markdown});
        if (req.method === 'GET' && url.pathname === '/api/preferences') return json(res,await (options.startupStatus ?? startupStatus)(configPath));
        if (req.method === 'GET' && url.pathname === '/api/explorer') return json(res,await (options.explorerStatus ?? explorerStatus)(configPath));
        if (req.method === 'GET' && url.pathname === '/api/job') {
          const job = await getJob(configPath,url.searchParams.get('id'));
          return json(res,{...cleanJob(job),artifacts:(job.artifacts ?? []).map(item=>({name:path.basename(item.path),bytes:item.bytes}))});
        }
        if (req.method === 'GET' && url.pathname === '/api/artifact') {
          const bytes = await readArtifact(configPath,url.searchParams.get('id'),url.searchParams.get('name'));
          res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8','Content-Disposition':'attachment'}); res.end(bytes); return;
        }
        if (req.method !== 'POST') reject(404,'Not found.');
        const input = await body(req, url.pathname === '/api/recipes/import' ? maxRecipeBytes * 6 + 1024 : 32768);
        if (url.pathname === '/api/control') return json(res,await setPaused(configPath,input.paused));
        if(url.pathname==='/api/screenshots'){
          if(typeof input.screenshotMode!=='boolean'||Object.keys(input).length!==1)reject(400,'Expected screenshotMode.');
          return json(res,await setScreenshotMode(configPath,input.screenshotMode));
        }
        if (url.pathname === '/api/settings') return json(res,await configureAdmin(configPath,input,options));
        if (url.pathname === '/api/cancel') return json(res,await cancelJob(configPath,input.id));
        if (url.pathname === '/api/recipes/import') return json(res,await importRecipe(configPath,input));
        if (url.pathname === '/api/loops/install') return json(res,await installLoop(configPath,input.path));
        if (url.pathname === '/api/runtime') return json(res,await (options.runtimeStatus ?? status)(await readConfig(configPath)));
        if (url.pathname === '/api/model/load') return json(res,await prepareModel(configPath));
        if (url.pathname === '/api/model/unload') return json(res,await unloadModel(configPath));
        if (url.pathname === '/api/preferences') {
          if (typeof input.startWithWindows !== 'boolean' || Object.keys(input).length !== 1) reject(400,'Expected startWithWindows.');
          return json(res,await (options.setStartup ?? setStartup)(configPath,input.startWithWindows));
        }
        if(url.pathname==='/api/explorer'){
          if(typeof input.askInExplorer!=='boolean'||Object.keys(input).length!==1)reject(400,'Expected askInExplorer.');
          return json(res,await (options.setExplorer ?? setExplorer)(configPath,input.askInExplorer));
        }
        if (url.pathname === '/api/close') { json(res,{closed:true}); setImmediate(()=>close()); return; }
        reject(404,'Not found.');
      } finally { pending--; }
    } catch (error) {
      if (!res.headersSent) json(res,{error:error.code === 'ENOENT' ? 'The requested local file is unavailable.' : error.message},error.statusCode ?? 400);
      else res.end();
    }
  });
  server.requestTimeout = 30000; server.headersTimeout = 10000;
  async function close() {
    if (closed) return; closed=true; clearInterval(timer);
    await new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); });
    try { if (JSON.parse(await fs.readFile(sessionPath(configPath),'utf8')).id === id) await fs.rm(sessionPath(configPath)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await releaseLock(lockFile,id);
  }
  try {
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    origin = `http://127.0.0.1:${server.address().port}`;
    await fs.writeFile(sessionPath(configPath),JSON.stringify({id,pid:process.pid,origin,token,configPath}),{mode:0o600});
    const idle = options.idleTimeoutMs ?? 120000;
    timer = setInterval(()=>{if (!pending && Date.now()-lastActivity>idle) close().catch(()=>{});},Math.min(idle,10000)); timer.unref();
    return {server,origin,token,close};
  } catch(error) { server.close(); await releaseLock(lockFile,id); throw error; }
}
