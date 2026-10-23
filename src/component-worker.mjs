import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { scopedPath, writeArtifact } from './files.mjs';
import { readImage } from './images.mjs';
import { getComponent, componentSpec } from './components.mjs';
import { inspect, lms } from './runtime.mjs';

const exec=promisify(execFile);
export function validateWav(bytes) {
  if(bytes.length>20*1024*1024 || bytes.toString('ascii',0,4)!=='RIFF' || bytes.toString('ascii',8,12)!=='WAVE')throw new Error('Expected a WAV file of at most 20 MiB.');
  let format, data;
  for(let offset=12;offset+8<=bytes.length;) {
    const name=bytes.toString('ascii',offset,offset+4),size=bytes.readUInt32LE(offset+4),start=offset+8;
    if(start+size>bytes.length)throw new Error('Truncated WAV chunk.');
    if(name==='fmt '&&size>=16)format={pcm:bytes.readUInt16LE(start),channels:bytes.readUInt16LE(start+2),rate:bytes.readUInt32LE(start+4),bits:bytes.readUInt16LE(start+14)};
    if(name==='data')data=size;
    offset=start+size+(size%2);
  }
  if(!format || format.pcm!==1 || format.channels!==1 || format.rate!==16000 || format.bits!==16 || !data || data%2)throw new Error('Audio must be 16 kHz, mono, 16-bit PCM WAV. Convert other formats locally first.');
  if(data/32000>600)throw new Error('Audio is limited to ten minutes per job.');
  return {durationSeconds:data/32000};
}
export async function componentInputs(root,request) {
  const name=request.loopSpec?.processor;
  if(name==='whisper') {
    if(request.files.length!==1 || request.images.length)throw new Error('Transcription requires exactly one WAV file and no images.');
    const filename=await scopedPath(root,request.files[0]);
    if(path.extname(filename).toLowerCase()!=='.wav' || !(await fs.stat(filename)).isFile() || (await fs.stat(filename)).size>20*1024*1024)throw new Error('Expected one WAV file of at most 20 MiB.');
    const bytes=await fs.readFile(filename); return {bytes,...validateWav(bytes)};
  }
  if(name==='embeddings') {
    if(request.files.length+request.images.length<1 || request.files.length+request.images.length>4)throw new Error('Embedding jobs accept one to four text files/images in total.');
    const items=[];
    for(const relative of request.files) {
      const filename=await scopedPath(root,relative),stat=await fs.stat(filename);
      if(!stat.isFile()||stat.size>16000)throw new Error('Each embedding text file must be at most 16,000 UTF-8 bytes.');
      const bytes=await fs.readFile(filename);
      if(bytes.includes(0))throw new Error('Embedding text input must be UTF-8 text.');
      items.push({source:relative,text:new TextDecoder('utf-8',{fatal:true}).decode(bytes)});
    }
    for(const relative of request.images) {
      const image=await readImage(root,relative),ext=path.extname(relative).toLowerCase();
      items.push({source:relative,image:`data:image/${ext==='.png'?'png':ext==='.webp'?'webp':'jpeg'};base64,${image.bytes.toString('base64')}`});
    }
    return {items};
  }
  throw new Error('Unknown local component processor.');
}
function childProcess(executable,args,signal,options={}) {
  signal?.throwIfAborted();
  const child=spawn(executable,args,{windowsHide:true,stdio:['ignore','ignore','pipe'],...options});
  let stderr='';child.stderr.on('data',chunk=>{stderr=(stderr+chunk.toString()).slice(-32768);process.stderr.write(chunk);});
  // Attach immediately: startup errors and quick exits must never become unhandled events.
  const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,sig)=>code===0?resolve():reject(new Error(`Local component exited (${code ?? sig}). See worker.log.`)));});
  done.catch(()=>{});
  const abort=()=>child.kill();signal?.addEventListener('abort',abort,{once:true});
  return {child,done,get stderr(){return stderr;},async close(){signal?.removeEventListener('abort',abort);if(child.exitCode===null&&child.signalCode===null){child.kill();await done.catch(()=>{});}}};
}
async function freePort() {
  const server=net.createServer();server.listen(0,'127.0.0.1');await once(server,'listening');
  const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;
}
export function embeddingInput(item) {
  // Qwen's retrieval instruction and chat framing are shared by both modalities.
  const content=[{type:'text',text:"<|im_start|>system\nRepresent the user's input.<|im_end|>\n<|im_start|>user\n"}];
  if(item.image)content.push({type:'image_url',image_url:{url:item.image}});
  else content.push({type:'text',text:item.text});
  content.push({type:'text',text:'<|im_end|>\n<|im_start|>assistant\n'});
  return {content};
}
export function checkedVector(value,dimensions=2048) {
  if(!Array.isArray(value)||value.length!==dimensions||value.some(n=>typeof n!=='number'||!Number.isFinite(n)))throw new Error('Runtime returned an invalid embedding vector.');
  const norm=Math.hypot(...value);if(norm<1e-9)throw new Error('Runtime returned a zero embedding vector.');
  return value.map(n=>n/norm);
}
async function releaseOwnModel(config) {
  const loaded=JSON.parse(await lms(config,['ps','--json']));
  const own=loaded.find(m=>m.identifier===config.modelIdentifier);
  if(!own)return;
  if(own.deviceIdentifier!=null||own.status!=='idle'||own.queued>0)throw new Error('Malyn model is remote or busy; GPU memory was not reclaimed.');
  await lms(config,['unload',config.modelIdentifier]);
}
export async function performComponent(config,configPath,request,directory,update,signal) {
  const name=request.loopSpec.processor,spec=componentSpec(name),started=Date.now();
  if(request.modelKey && request.modelKey!==spec.modelKey)throw new Error(`This loop requires ${spec.modelKey}.`);
  if(request.loopSpec.model.preferredModelKey!==spec.modelKey)throw new Error('Loop model does not match its component processor.');
  update({phase:'verifying_model',model:spec.modelKey});
  let component;
  try {component=await getComponent(configPath,name,{verify:true});}
  catch(error){if(error.code==='ENOENT')throw new Error(`Install the optional component first: malyn components install ${name} --config "${configPath}"`);throw error;}
  const inputs=await componentInputs(request.root,request),artifacts=[];
  signal?.throwIfAborted();
  let gpu,durationSeconds;
  if(name==='whisper') {
    const hardware=await inspect(config);gpu=hardware.gpu.name;
    const devices=await exec(component.executable,['--help'],{windowsHide:true,timeout:30000,maxBuffer:1024*1024});
    const matched=(devices.stdout+'\n'+devices.stderr).split(/\r?\n/).map(line=>line.match(/^ggml_vulkan: (\d+) = (.+)$/)).filter(Boolean).find(match=>match[2].includes(gpu));
    if(!matched)throw new Error('Configured GPU is unavailable in the Whisper runtime. No CPU fallback is enabled.');
    await releaseOwnModel(config);signal?.throwIfAborted();
    update({phase:'transcribing',gpu,model:spec.modelKey});
    const input=path.join(directory,'input.wav'),output=path.join(directory,'transcript-raw');
    await fs.writeFile(input,inputs.bytes,{flag:'wx'});
    const runner=childProcess(component.executable,['-m',component.model,'-f',input,'-l','auto','-t',String(Math.min(8,os.availableParallelism())),'-otxt','-of',output,'-dev',matched[1]],signal,{env:{...process.env,GGML_VK_DISABLE_HOST_VISIBLE_VIDMEM:'1'}});
    try {await runner.done;signal?.throwIfAborted();}finally{await runner.close();}
    const text=await fs.readFile(`${output}.txt`,'utf8');
    if(!text.trim())throw new Error('Whisper produced an empty transcript.');
    if(!/Vulkan\d+.*(?:buffer|compute)|using Vulkan\d+|Vulkan\d+ backend/i.test(runner.stderr))throw new Error('Whisper did not confirm a Vulkan execution backend.');
    artifacts.push(await writeArtifact(directory,request.loopSpec.output.artifact,`# Local audio transcript\n\nModel: Whisper Base · ${gpu} · ${inputs.durationSeconds.toFixed(1)} seconds of audio\n\nAutomatic transcription may contain errors; check important details against the recording.\n\n${text.trim()}\n`));
    durationSeconds=inputs.durationSeconds;
  } else {
    const hardware=await inspect(config);gpu=hardware.gpu.name;
    const devices=await exec(component.executable,['--list-devices'],{windowsHide:true,timeout:30000,maxBuffer:1024*1024});
    const matched=(devices.stdout+'\n'+devices.stderr).split(/\r?\n/).map(line=>line.match(/^\s*(Vulkan\d+):\s*(.+)$/)).filter(Boolean).find(match=>match[2].includes(gpu));
    if(!matched)throw new Error('Configured GPU is unavailable in the embedding runtime. No CPU fallback is enabled.');
    await releaseOwnModel(config);signal?.throwIfAborted();
    const port=await freePort(),origin=`http://127.0.0.1:${port}`,token=randomBytes(32).toString('hex'),keyFile=path.join(directory,'.component-key');
    await fs.writeFile(keyFile,token,{flag:'wx',mode:0o600});
    const runner=childProcess(component.executable,['--model',component.model,'--mmproj',component.projector,'--embedding','--pooling','last','--ctx-size','8192','--batch-size','8192','--ubatch-size','8192','--parallel','1','--gpu-layers','all','--device',matched[1],'--host','127.0.0.1','--port',String(port),'--api-key-file',keyFile,'--no-webui'],signal,{env:{...process.env,GGML_VK_DISABLE_HOST_VISIBLE_VIDMEM:'1'}});
    try {
      update({phase:'loading',gpu,model:spec.modelKey});
      let ready=false;
      for(let attempt=0;attempt<300;attempt++) {
        signal?.throwIfAborted();
        if(runner.child.exitCode!==null||runner.child.signalCode!==null){await runner.done;throw new Error('Embedding runtime exited before becoming ready.');}
        try {const response=await fetch(`${origin}/health`,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(1000)});if(response.ok){ready=true;break;}}catch{}
        await new Promise(resolve=>setTimeout(resolve,500));
      }
      if(!ready)throw new Error('Embedding runtime did not become ready.');
      update({phase:'embedding',gpu,model:spec.modelKey});
      const vectors=[];
      for(const item of inputs.items) {
        signal?.throwIfAborted();
        const response=await fetch(`${origin}/v1/embeddings`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({input:[embeddingInput(item)],encoding_format:'float'}),signal});
        if(!response.ok)throw new Error(`Embedding request failed (HTTP ${response.status}). See worker.log.`);
        const result=await response.json();
        vectors.push({source:item.source,embedding:checkedVector(result.data?.[0]?.embedding,spec.dimensions)});
      }
      artifacts.push(await writeArtifact(directory,request.loopSpec.output.artifact,JSON.stringify({model:spec.modelKey,quantization:'Q4_K_M',dimensions:spec.dimensions,normalization:'L2',items:vectors})));
    } finally {await runner.close();await fs.rm(keyFile,{force:true});}
  }
  signal?.throwIfAborted();
  return {status:'completed',phase:'finished',model:spec.modelKey,gpu,backend:spec.backend,loop:request.loopSpec.name,artifacts,elapsedSeconds:+((Date.now()-started)/1000).toFixed(2),returnMode:request.returnMode,summary:'The local component finished. Detailed results are saved in the linked report.',...(durationSeconds?{audioDurationSeconds:durationSeconds}:{}),componentUnloaded:true};
}
