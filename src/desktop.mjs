import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { alive } from './jobs.mjs';
const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/malyn.mjs',import.meta.url));
const trayScript = fileURLToPath(new URL('../scripts/Malyn-Tray.ps1',import.meta.url));
const startupScript = fileURLToPath(new URL('../scripts/Malyn-Startup.ps1',import.meta.url));
const sessionFile = config => path.join(path.dirname(path.resolve(config)),'admin-session.json');
const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms));

export async function readSession(config) {
  try {
    const session = JSON.parse(await fs.readFile(sessionFile(config),'utf8'));
    if (!alive(session.pid) || session.configPath !== path.resolve(config) || !/^http:\/\/127\.0\.0\.1:\d+$/.test(session.origin) || !/^[0-9a-f]{64}$/.test(session.token)) return null;
    const res = await fetch(`${session.origin}/api/ping`,{headers:{Authorization:`Bearer ${session.token}`},signal:AbortSignal.timeout(1500)});
    if (res.ok && (await res.json()).ok) return session;
  } catch { /* Missing or expired admin instance. */ }
  return null;
}
export async function ensureAdmin(config) {
  const existing = await readSession(config); if (existing) return existing;
  const directory = path.dirname(path.resolve(config));
  const log = await fs.open(path.join(directory,'admin.log'),'a');
  try {
    const child = spawn(process.execPath,[cli,'ui-host','--config',path.resolve(config)],{detached:true,windowsHide:true,stdio:['ignore',log.fd,log.fd]});
    await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);}); child.unref();
  } finally { await log.close(); }
  for (let i=0;i<60;i++) { await sleep(200); const session=await readSession(config); if(session)return session; }
  throw new Error('The admin UI did not start. See admin.log beside your Malyn configuration.');
}
export async function stopAdmin(config) {
  const session = await readSession(config);
  if (session) await fetch(`${session.origin}/api/close`,{method:'POST',headers:{Authorization:`Bearer ${session.token}`,'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(5000)});
  return { stopped:!!session, workerUnaffected:true };
}
export async function openBrowser(url) {
  if (process.platform === 'win32') {
    // Encode a fixed command, never concatenate a URL into shell source.
    const command = `Start-Process -FilePath ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(url).toString('base64')}')))`;
    await exec('powershell.exe',['-NoProfile','-WindowStyle','Hidden','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')],{windowsHide:true});
  } else await exec(process.platform==='darwin'?'open':'xdg-open',[url]);
}
export async function launchTray(config) {
  if(process.platform!=='win32')throw new Error('The tray is available on Windows. Use malyn ui on other platforms.');
  const resolved=path.resolve(config),directory=path.dirname(resolved);
  const readTray=async()=>{
    try {
      const session=JSON.parse(await fs.readFile(path.join(directory,'tray-session.json'),'utf8'));
      if(session.configPath===resolved && session.iconVisible && alive(session.pid)) return session;
    } catch { /* Not ready. */ }
    return null;
  };
  const existing=await readTray();
  if(existing)return {trayRunning:true,pid:existing.pid,reused:true};
  // Start-Process creates the hidden GUI host without Node's detached-console flag,
  // which causes Windows PowerShell to exit before executing a WinForms script.
  const parameters={script:trayScript,node:process.execPath,cli,config:resolved,directory};
  const payload=Buffer.from(JSON.stringify(parameters)).toString('base64');
  const command=`$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json; $arguments='-NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+$p.script+'" -NodePath "'+$p.node+'" -CliPath "'+$p.cli+'" -ConfigPath "'+$p.config+'"'; Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe') -WindowStyle Hidden -ArgumentList $arguments -RedirectStandardOutput (Join-Path $p.directory 'tray.log') -RedirectStandardError (Join-Path $p.directory 'tray-stderr.log') | Out-Null`;
  const launcher=spawn('powershell.exe',['-NoProfile','-WindowStyle','Hidden','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')],{windowsHide:true,stdio:'ignore'});
  await new Promise((resolve,reject)=>{launcher.once('spawn',resolve);launcher.once('error',reject);});launcher.unref();
  for(let i=0;i<100;i++) { const session=await readTray(); if(session)return {trayRunning:true,pid:session.pid,reused:false}; await sleep(100); }
  throw new Error('The tray did not become ready. See tray.log, tray-stderr.log and tray-error.txt beside your configuration.');
}
export async function stopDesktop(config) {
  await stopAdmin(config);
  const file = path.join(path.dirname(path.resolve(config)),'tray-session.json');
  try {
    const session = JSON.parse(await fs.readFile(file,'utf8'));
    if (alive(session.pid)) await fs.writeFile(path.join(path.dirname(file),'tray-stop'),String(session.pid));
  } catch(error) { if(error.code!=='ENOENT')throw error; }
  return { stopRequested:true,workerUnaffected:true };
}
async function startup(config, action) {
  if(process.platform!=='win32')return {supported:false,startWithWindows:false};
  const {stdout} = await exec('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',startupScript,'-Action',action,'-NodePath',process.execPath,'-CliPath',cli,'-ConfigPath',path.resolve(config)],{windowsHide:true,timeout:10000});
  return JSON.parse(stdout);
}
export const startupStatus = config => startup(config,'Status');
export const setStartup = (config,enabled) => startup(config,enabled?'Enable':'Disable');
export const syncStartup = config => startup(config,'Sync');
async function explorer(config,action) {
  if(process.platform!=='win32')return {supported:false,askInExplorer:false};
  const script=fileURLToPath(new URL('../scripts/Malyn-Explorer.ps1',import.meta.url));
  const {stdout}=await exec('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',script,'-Action',action,'-NodePath',process.execPath,'-CliPath',cli,'-ConfigPath',path.resolve(config)],{windowsHide:true,timeout:10000});
  return JSON.parse(stdout);
}
export const explorerStatus = config => explorer(config,'Status');
export const setExplorer = (config,enabled) => explorer(config,enabled?'Enable':'Disable');
export const syncExplorer = config => explorer(config,'Sync');
export const desktopKey = config => createHash('sha256').update(path.resolve(config).toLowerCase()).digest('hex').slice(0,16);
