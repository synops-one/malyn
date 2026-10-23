import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { startAdminServer, sessionPath } from '../src/admin-server.mjs';
import { validateConfig, readConfig } from '../src/config.mjs';
import { submitJob } from '../src/jobs.mjs';
import { readControl } from '../src/control.mjs';
import { cleanup } from './helpers.mjs';
import { exportRecipe } from '../src/recipes.mjs';

test('Kitchen import/export is authenticated, round-trips Markdown and never starts a job',async t=>{
  const {directory,config,app,request}=await fixture(t);
  const recipe=await exportRecipe(config,'describe-my-image');
  const input={filename:'shared-image.md',markdown:recipe.markdown.replaceAll('describe-my-image','shared-image')};
  assert.equal((await fetch(app.origin+'/api/recipes/export?name=describe-my-image')).status,401);
  assert.equal((await request('/api/recipes/import',input,{Origin:'https://malicious.example'})).status,403);
  const imported=await request('/api/recipes/import',input);
  assert.equal(imported.status,200);assert.equal((await imported.json()).executed,false);
  const downloaded=await request('/api/recipes/export?name=shared-image');
  assert.equal(downloaded.status,200);
  assert.equal(downloaded.headers.get('content-disposition'),'attachment; filename="shared-image.md"');
  assert.equal(await downloaded.text(),input.markdown);
  assert.equal((await (await request('/api/recipes')).json()).recipes.length,6);
  assert.equal((await request('/api/recipes/import',input)).status,400);
  assert.equal((await request('/api/recipes/export?name=..%2Fconfig')).status,400);
  assert.equal((await request('/api/recipes/import',{...input,filename:'../outside.md'})).status,400);
  assert.deepEqual((await (await request('/api/state')).json()).jobs,[]);
  assert.equal(await fs.readFile(path.join(directory,'recipes',input.filename),'utf8'),input.markdown);
});
test('Kitchen supports the full recipe size limit even when JSON escaping expands the request',async t=>{
  const {config,request}=await fixture(t);
  const recipe=await exportRecipe(config,'describe-my-image');
  const prefix=recipe.markdown.replaceAll('describe-my-image','large-recipe')+'\n## Notes\n';
  const markdown=prefix+'\x01'.repeat(65536-Buffer.byteLength(prefix));
  const input={filename:'large-recipe.md',markdown};
  assert.equal((await request('/api/recipes/import',input)).status,200);
  assert.equal(await (await request('/api/recipes/export?name=large-recipe')).text(),markdown);
  assert.equal((await request('/api/recipes/import',{...input,markdown:markdown+'x'})).status,400);
  assert.equal((await request('/api/recipes/import',{...input,markdown:'x'.repeat(400000)})).status,413);
  assert.equal((await request('/api/settings',{notes:'x'.repeat(40000)})).status,413);
});

async function fixture(t, options={}) {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'malyn-admin-'));
  const config=path.join(directory,'config.json');
  await fs.writeFile(config,JSON.stringify(validateConfig({lmsPath:'unused',modelKey:'test-model',contextLength:32768})));
  const app=await startAdminServer(config,{downloadedModels:async()=>[{modelKey:'test-model',maxContextLength:131072}],...options});
  t.after(async()=>{await app.close();await cleanup(directory);});
  const request=async(route,body,headers={})=>fetch(`${app.origin}${route}`,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${app.token}`,...(body===undefined?{}:{'Content-Type':'application/json'}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {directory,config,app,request};
}
test('admin rejects unauthenticated, cross-origin and rebound-host API access',async t=>{
  const {app,request}=await fixture(t);
  assert.equal((await fetch(app.origin+'/api/state')).status,401);
  assert.equal((await request('/api/state',undefined,{Origin:'https://malicious.example'})).status,403);
  assert.equal((await request('/api/control',{paused:true},{Origin:'https://malicious.example'})).status,403);
  assert.equal((await request('/api/state',undefined,{'Sec-Fetch-Site':'cross-site'})).status,403);
  const hostStatus=await new Promise((resolve,reject)=>{const req=http.get(app.origin+'/api/state',{headers:{Host:'attacker.example',Authorization:`Bearer ${app.token}`}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);});
  assert.equal(hostStatus,403);
  const ok=await request('/api/state');assert.equal(ok.status,200);
  assert.match(ok.headers.get('content-security-policy'),/frame-ancestors 'none'/);
  assert.equal(ok.headers.get('access-control-allow-origin'),null);
  assert.equal((await request('/api/control',{paused:true},{'Content-Type':'text/plain'})).status,415);
});
test('external top-level navigation opens only the public shell, never APIs or frames',async t=>{
  const {app}=await fixture(t);
  const external={'Sec-Fetch-Site':'cross-site','Sec-Fetch-Mode':'navigate','Sec-Fetch-Dest':'document'};
  const raw=async(route,headers,method='GET')=>new Promise((resolve,reject)=>{
    const req=http.request(app.origin+route,{method,headers},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));
      res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString()}));
    });req.on('error',reject);req.end();
  });
  const shell=await raw('/',external);
  assert.equal(shell.status,200);assert.match(shell.headers['content-type'],/^text\/html/);
  assert.equal(shell.body.includes(app.token),false);
  assert.match(shell.headers['content-security-policy'],/frame-ancestors 'none'/);
  for(const route of ['/api/state','/api/artifact','/app.js'])
    assert.equal((await raw(route,{...external,Authorization:`Bearer ${app.token}`})).status,403);
  assert.equal((await raw('/',{...external,'Sec-Fetch-Dest':'iframe'})).status,403);
  assert.equal((await raw('/',{...external,'Sec-Fetch-Mode':'cors'})).status,403);
  assert.equal((await raw('/',{...external,Origin:'https://malicious.example'})).status,403);
  assert.equal((await raw('/',external,'POST')).status,403);
});

test('pause gates submissions and can be toggled while an existing job runs',async t=>{
  const {config,directory,request}=await fixture(t);
  await fs.writeFile(path.join(directory,'jobs','worker.lock'),JSON.stringify({id:randomUUID(),pid:process.pid}));
  const paused=await (await request('/api/control',{paused:true})).json();
  assert.equal(paused.paused,true,JSON.stringify(paused));
  assert.equal((await submitJob(config,{}, {root:directory,task:'Must not run'})).status,'paused');
  assert.equal((await (await request('/api/settings',{contextLength:65536})).json()).status,'busy');
  assert.equal((await readConfig(config)).contextLength,32768);
  await request('/api/control',{paused:false});
  assert.equal((await readControl(config)).paused,false);
  assert.equal(JSON.parse(await fs.readFile(path.join(directory,'jobs','worker.lock'))).pid,process.pid);
});

test('screenshot mode is opt-in, strictly validated and preserved across pause changes',async t=>{
  const {config,request}=await fixture(t);
  assert.equal((await readControl(config)).screenshotMode,false);
  assert.equal((await request('/api/screenshots',{screenshotMode:'yes'})).status,400);
  assert.equal((await request('/api/screenshots',{screenshotMode:true,unrecognised:true})).status,400);
  assert.equal((await request('/api/screenshots',{screenshotMode:true})).status,200);
  await request('/api/control',{paused:true});assert.deepEqual(await readControl(config),{paused:true,screenshotMode:true});
  await request('/api/screenshots',{screenshotMode:false});assert.deepEqual(await readControl(config),{paused:true,screenshotMode:false});
});
test('admin settings validate capabilities, allowed roots and immutable executable fields',async t=>{
  const {config,directory,request}=await fixture(t);
  const original=await fs.readFile(config,'utf8');
  assert.equal((await request('/api/settings',{lmsPath:'untrusted.exe'})).status,400);
  assert.equal((await request('/api/settings',{allowedRoots:[path.join(directory,'missing')]})).status,400);
  assert.equal((await request('/api/settings',{reasoningBudget:9999,maxOutputTokens:100})).status,400);
  assert.equal((await request('/api/settings',{contextLength:262144})).status,400);
  assert.equal(await fs.readFile(config,'utf8'),original);
  assert.equal((await (await request('/api/settings',{allowedRoots:[directory],contextLength:65536})).json()).configured,true);
  assert.equal((await readConfig(config)).contextLength,65536);
  assert.equal(await fs.readFile(config+'.previous','utf8'),original);
});
test('job metadata omits generated details and report access is explicitly scoped and plain text',async t=>{
  const {directory,request}=await fixture(t);
  const id=randomUUID(),jobDir=path.join(directory,'jobs',id);await fs.mkdir(jobDir);
  const filename=path.join(jobDir,'report.md');
  await fs.writeFile(filename,'<script>private report content</script>');
  await fs.writeFile(path.join(directory,'private.txt'),'outside');
  await fs.writeFile(path.join(jobDir,'status.json'),JSON.stringify({id,status:'completed',returnMode:'summary',summary:'PRIVATE SUMMARY',error:'PRIVATE ERROR',artifacts:[{path:filename,bytes:38}]}));
  const meta=await (await request(`/api/job?id=${id}`)).json();
  assert.equal(meta.summary,undefined);assert.equal(meta.error,undefined);assert.equal(meta.artifacts[0].name,'report.md');
  const report=await request(`/api/artifact?id=${id}&name=report.md`);assert.equal(report.status,200);assert.match(report.headers.get('content-type'),/^text\/plain/);assert.equal(report.headers.get('content-disposition'),'attachment');
  assert.equal((await request(`/api/artifact?id=${id}&name=..%2Fprivate.txt`)).status,400);
  assert.equal((await request(`/api/artifact?id=${id}&name=status.json`)).status,404);
  assert.equal((await request('/api/job?id=..')).status,400);
});
test('only one admin instance owns a configuration and idle shutdown removes session credentials',async t=>{
  const {app,config}=await fixture(t,{idleTimeoutMs:80});
  await assert.rejects(()=>startAdminServer(config),/already starting or running/);
  await new Promise(resolve=>setTimeout(resolve,250));
  assert.equal(app.server.listening,false);
  await assert.rejects(()=>fs.access(sessionPath(config)),{code:'ENOENT'});
  await assert.rejects(()=>fs.access(path.join(path.dirname(config),'admin.lock')),{code:'ENOENT'});
});
