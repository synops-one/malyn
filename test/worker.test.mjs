import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { inside, readText, scopedPath, listFiles, searchFiles, writeArtifact } from '../src/files.mjs';
import { chooseGpu, matchesLoadConfig } from '../src/runtime.mjs';
import { cleanup } from './helpers.mjs';

test('worker reads only within the requested root and excludes secrets',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'malyn-test-'));
  try{
    await fs.writeFile(path.join(root,'source.txt'),'alpha\nbeta\ngamma');
    await fs.writeFile(path.join(root,'.env'),'SECRET=do-not-read');
    await fs.mkdir(path.join(root,'.private-worker'));
    await fs.writeFile(path.join(root,'.private-worker','report.txt'),'SECRET=private-result');
    await fs.writeFile(path.join(root,'.local-state.json'),'SECRET=private-state');
    assert.equal((await readText(root,'source.txt',2,1)).text,'2: beta');
    assert.equal((await readText(root,path.join(root,'source.txt'),2,1)).text,'2: beta');
    assert.equal((await readText(root,'source.txt',2,1)).truncated,true);
    await assert.rejects(()=>scopedPath(root,'../escape.txt'),/leaves/);
    await assert.rejects(()=>scopedPath(root,'.env'),/excluded/);
    await assert.rejects(()=>readText(root,'.private-worker/report.txt'),/excluded/);
    await assert.rejects(()=>readText(root,path.join(root,'.private-worker','report.txt')),/excluded/);
    await assert.rejects(()=>readText(root,'.local-state.json'),/excluded/);
    assert.deepEqual((await listFiles(root)).entries,[{name:'source.txt',type:'file'}]);
    assert.equal(inside(root,root+'-sibling'),false);
    assert.deepEqual((await searchFiles(root,'beta')).matches,[{path:'source.txt',line:2,text:'beta'}]);
    assert.equal((await searchFiles(root,'SECRET')).matches.length,0);
  }finally{await cleanup(root);}
});

test('artifacts cannot overwrite files or write outside the job directory',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'malyn-artifact-'));
  try{
    await writeArtifact(root,'patch.diff','first');
    await assert.rejects(()=>writeArtifact(root,'patch.diff','overwrite'),/EEXIST/);
    await assert.rejects(()=>writeArtifact(root,'../escape.txt','oops'),/filename/);
    await assert.rejects(()=>writeArtifact(root,'cancel','oops'),/Reserved/);
    await assert.rejects(()=>writeArtifact(root,'STATUS.TMP','oops'),/Reserved/);
    await assert.rejects(()=>writeArtifact(root,'large.txt','x'.repeat(250001)),/250 KB/);
    assert.equal(await fs.readFile(path.join(root,'patch.diff'),'utf8'),'first');
  }finally{await cleanup(root);}
});

test('binary and oversized sources are rejected instead of consuming context',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'malyn-binary-'));
  try{
    await fs.writeFile(path.join(root,'binary.bin'),Buffer.from([65,0,66]));
    await fs.writeFile(path.join(root,'large.txt'),'x'.repeat(2000001));
    await assert.rejects(()=>readText(root,'binary.bin'),/Binary/);
    await assert.rejects(()=>readText(root,'large.txt'),/2 MB/);
  }finally{await cleanup(root);}
});

test('directory links cannot escape the task root',async()=>{
  const parent=await fs.mkdtemp(path.join(os.tmpdir(),'malyn-link-'));
  const root=path.join(parent,'root'), outside=path.join(parent,'outside');
  try{
    await fs.mkdir(root);await fs.mkdir(outside);
    await fs.writeFile(path.join(outside,'outside.txt'),'not part of this task');
    await fs.symlink(outside,path.join(root,'link'),process.platform==='win32'?'junction':'dir');
    await assert.rejects(()=>readText(root,'link/outside.txt'),/Links are excluded/);
  }finally{await cleanup(parent);}
});

test('GPU selection requires the B60 and excludes the integrated GPU',()=>{
  const gpuInfo=[{name:'Intel Graphics',deviceId:0,integrationType:'integrated'},{name:'Intel Arc Pro B60 Graphics',deviceId:1,integrationType:'discrete'}];
  const survey={engines:[{name:'llama.cpp-vulkan',compatibility:{status:'compatible'},hardwareSurvey:{gpuSurveyResult:{gpuInfo}}}]};
  assert.equal(chooseGpu(survey,'Arc.*Pro B60').gpu.deviceId,1);
  assert.deepEqual(chooseGpu(survey,'Arc.*Pro B60').disabled,[0]);
  gpuInfo.pop();
  assert.throws(()=>chooseGpu(survey,'Arc.*Pro B60'),/B60 unavailable/);
});

test('reusing a loaded model requires the selected GPU and full offload, not just matching context',()=>{
  const config={contextLength:65536,kvCacheQuantization:'q8_0'},hardware={gpu:{deviceId:1},disabled:[0]};
  const actual={contextLength:65536,llamaKCacheQuantizationType:'q8_0',llamaVCacheQuantizationType:'q8_0',gpu:{ratio:'max',mainGpu:1,disabledGpus:[0]},offloadKVCacheToGpu:true};
  assert.equal(matchesLoadConfig(actual,config,hardware),true);
  for(const gpu of [{ratio:0,mainGpu:1,disabledGpus:[0]},{ratio:'max',mainGpu:0,disabledGpus:[1]},{ratio:'max',mainGpu:1,disabledGpus:[]}])assert.equal(matchesLoadConfig({...actual,gpu},config,hardware),false);
});
