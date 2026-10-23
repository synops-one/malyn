import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { withIdleWorker } from './jobs.mjs';
import { readConfig } from './config.mjs';
import { inside } from './files.mjs';

const exec = promisify(execFile);
export const componentCatalog = JSON.parse(await fs.readFile(new URL('../profiles/components.json',import.meta.url),'utf8'));
export const componentsDirectory = configPath => path.join(path.dirname(path.resolve(configPath)),'components');
export async function sha256(file) {
  const hash=createHash('sha256'); for await(const chunk of createReadStream(file))hash.update(chunk); return hash.digest('hex');
}
export function componentSpec(name) {
  if(!Object.hasOwn(componentCatalog,name))throw new Error('Choose whisper or embeddings.');
  return componentCatalog[name];
}
async function regularInside(root,file) {
  if(!inside(root,path.resolve(file)))throw new Error('Component path leaves its installation.');
  let current=root;
  for(const part of path.relative(root,file).split(path.sep).filter(Boolean)) {
    current=path.join(current,part);
    if((await fs.lstat(current)).isSymbolicLink())throw new Error('Linked component files are excluded.');
  }
  if(!(await fs.stat(file)).isFile())throw new Error('Component file is missing.');
}
export async function getComponent(configPath,name,{verify=false}={}) {
  const spec=componentSpec(name), root=componentsDirectory(configPath), directory=path.join(root,name);
  if((await fs.lstat(root)).isSymbolicLink())throw new Error('Linked component directories are excluded.');
  const manifest=path.join(directory,'installation.json'); await regularInside(root,manifest);
  const installed=JSON.parse(await fs.readFile(manifest,'utf8'));
  if(installed.modelKey!==spec.modelKey || installed.runtime!==spec.runtime.name)throw new Error('Reinstall this component for the current release.');
  if(typeof installed.executable!=='string' || typeof installed.executableSha256!=='string')throw new Error('Invalid component installation.');
  const executable=path.resolve(directory,installed.executable);
  if(path.basename(executable)!==spec.executable)throw new Error('Unexpected component executable.');
  await regularInside(directory,executable);
  if(verify && await sha256(executable)!==installed.executableSha256)throw new Error('Component executable checksum changed; reinstall it.');
  const files={};
  for(const file of spec.files) {
    const filename=path.join(directory,file.name); await regularInside(root,filename);
    if(verify && await sha256(filename)!==file.sha256)throw new Error('Component model checksum mismatch.');
    files[file.role]=filename;
  }
  return {...spec,executable,...files};
}
export async function listComponents(configPath) {
  return {components:await Promise.all(Object.entries(componentCatalog).map(async([name,spec])=>{
    let installed=false; try{await getComponent(configPath,name);installed=true;}catch{}
    return {name,label:spec.label,modelKey:spec.modelKey,capabilities:spec.capabilities,backend:spec.backend,installed,loadedOnDemand:true,installCommand:`malyn components install ${name}`};
  }))};
}
async function download(pin,target,progress) {
  try { if(await sha256(target)===pin.sha256)return; throw new Error(`Existing download failed verification: ${path.basename(target)}`); }
  catch(error){if(error.code!=='ENOENT')throw error;}
  progress(`Downloading ${path.basename(target)}`);
  const partial=`${target}.${randomUUID()}.part`;
  try {
    const response=await fetch(pin.url,{signal:AbortSignal.timeout(1800000)});
    if(!response.ok)throw new Error(`Download returned HTTP ${response.status}.`);
    await pipeline(Readable.fromWeb(response.body),createWriteStream(partial,{flags:'wx'}));
    if(await sha256(partial)!==pin.sha256)throw new Error('Download checksum mismatch.');
    await fs.rename(partial,target);
  } finally {await fs.rm(partial,{force:true});}
}
async function findExecutable(directory,name) {
  for(const item of await fs.readdir(directory,{withFileTypes:true})) {
    const file=path.join(directory,item.name);
    if(item.isFile()&&item.name===name)return file;
    if(item.isDirectory()){const match=await findExecutable(file,name);if(match)return match;}
  }
  return null;
}
export async function installComponent(configPath,name,{progress=()=>{}}={}) {
  const spec=componentSpec(name);
  if(process.platform!=='win32'||process.arch!=='x64')throw new Error('Bundled component setup currently supports Windows x64.');
  await readConfig(configPath);
  return withIdleWorker(configPath,async()=>{
    try {await getComponent(configPath,name,{verify:true});return {installed:true,name,alreadyInstalled:true};}
    catch(error){if(error.code!=='ENOENT')throw error;}
    const root=componentsDirectory(configPath),directory=path.join(root,name);
    await fs.mkdir(root,{recursive:true});
    if((await fs.lstat(root)).isSymbolicLink())throw new Error('Linked component directories are excluded.');
    try {await fs.lstat(directory);throw new Error('An incomplete component directory exists. Rename it before reinstalling.');}catch(error){if(error.code!=='ENOENT')throw error;}
    const stage=await fs.mkdtemp(path.join(root,`.install-${name}-`));
    // Failed staging remains local for diagnosis; it is never treated as installed.
    const archive=path.join(stage,'runtime.zip');
    await download(spec.runtime,archive,progress);
    const quote=value=>`'${value.replaceAll("'","''")}'`;
    const unpack=path.join(stage,'runtime');
    const command=`$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath ${quote(archive)} -DestinationPath ${quote(unpack)}`;
    await exec('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')],{windowsHide:true,timeout:120000});
    const executable=await findExecutable(unpack,spec.executable);
    if(!executable)throw new Error('Runtime archive did not contain the expected executable.');
    for(const file of spec.files)await download(file,path.join(stage,file.name),progress);
    await fs.writeFile(path.join(stage,'installation.json'),JSON.stringify({modelKey:spec.modelKey,runtime:spec.runtime.name,executable:path.relative(stage,executable),executableSha256:await sha256(executable)},null,2),{flag:'wx'});
    await fs.rename(stage,directory);
    return {installed:true,name,modelKey:spec.modelKey,backend:spec.backend,loaded:false};
  });
}
