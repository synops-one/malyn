import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { validateWav, componentInputs, checkedVector, embeddingInput } from '../src/component-worker.mjs';
import { listComponents, getComponent, componentSpec } from '../src/components.mjs';
import { parseLoop, getLoop } from '../src/loops.mjs';
import { cleanup } from './helpers.mjs';

function wav(seconds=1) {
  const bytes=Buffer.alloc(44+32000*seconds);
  bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);
  bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(16000,24);bytes.writeUInt32LE(32000,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);
  bytes.write('data',36);bytes.writeUInt32LE(bytes.length-44,40);return bytes;
}
test('audio format and duration limits reject unsupported or truncated input',()=>{
  assert.equal(validateWav(wav()).durationSeconds,1);
  assert.throws(()=>validateWav(Buffer.from('not audio')),/WAV/);
  const stereo=wav();stereo.writeUInt16LE(2,22);assert.throws(()=>validateWav(stereo),/mono/);
  assert.throws(()=>validateWav(wav().subarray(0,90)),/Truncated/);
  assert.throws(()=>validateWav(wav(601)),/ten minutes/);
});
test('component loops cannot replace a fixed processor with arbitrary model or executable arguments',async()=>{
  const loop=await getLoop(path.resolve('unused.config.json'),'transcribe-audio');
  assert.throws(()=>parseLoop(loop.markdown.replace('whisper/base','arbitrary/model')),/Whisper loops/);
  assert.throws(()=>parseLoop(loop.markdown.replace('"processor": "whisper"','"processor": "shell"')),/Invalid/);
  assert.throws(()=>componentSpec('__proto__'),/Choose/);
});
test('component input reads retain root boundaries, private-file exclusions and batch limits',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'malyn-component-'));
  try {
    await fs.writeFile(path.join(dir,'input.wav'),wav());
    const audio={files:['input.wav'],images:[],loopSpec:{processor:'whisper'}};
    assert.equal((await componentInputs(dir,audio)).durationSeconds,1);
    await assert.rejects(()=>componentInputs(dir,{...audio,files:['../outside.wav']}),/root/);
    await fs.writeFile(path.join(dir,'credentials.txt'),'do not read');
    const embedding={files:['credentials.txt'],images:[],loopSpec:{processor:'embeddings'}};
    await assert.rejects(()=>componentInputs(dir,embedding),/Private/);
    await assert.rejects(()=>componentInputs(dir,{...embedding,files:Array(5).fill('x')}),/one to four/);
    await fs.writeFile(path.join(dir,'large.txt'),'x'.repeat(16001));
    await assert.rejects(()=>componentInputs(dir,{...embedding,files:['large.txt']}),/16,000/);
    const status=await listComponents(path.join(dir,'config.json'));
    assert.ok(status.components.every(c=>!c.installed&&c.backend.includes('Vulkan')));
  }finally{await cleanup(dir);}
});
test('embedding results must be finite, correctly sized and nonzero before local persistence',()=>{
  assert.deepEqual(checkedVector([3,4],2),[0.6,0.8]);
  assert.throws(()=>checkedVector([0,0],2),/zero/);
  assert.throws(()=>checkedVector([NaN,1],2),/invalid/);
  assert.throws(()=>checkedVector([1],2),/invalid/);
  const prompt=embeddingInput({image:'data:image/png;base64,AA=='});
  assert.equal(prompt.content[1].image_url.url,'data:image/png;base64,AA==');
  assert.ok(prompt.content[0].text.includes("Represent the user's input."));
});
test('component manifests cannot redirect execution outside their own directory',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'malyn-component-manifest-'));
  try {
    const target=path.join(dir,'components','whisper');await fs.mkdir(target,{recursive:true});
    const spec=componentSpec('whisper');
    for(const executable of ['../../../whisper-cli.exe','../embeddings/whisper-cli.exe']) {
      await fs.writeFile(path.join(target,'installation.json'),JSON.stringify({modelKey:spec.modelKey,runtime:spec.runtime.name,executable,executableSha256:'a'.repeat(64)}));
      await assert.rejects(()=>getComponent(path.join(dir,'config.json'),'whisper'),/leaves its installation/);
    }
  }finally{await cleanup(dir);}
});
