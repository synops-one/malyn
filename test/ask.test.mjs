import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {askRequest} from '../src/ask.mjs';
import {selectedFilePath} from '../src/worker.mjs';
import {validateRequest} from '../src/jobs.mjs';
import {cleanup} from './helpers.mjs';

test('Ask Malyn restricts reads to the selected file and retains configured root boundaries',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'malyn-ask-'));
  try{
    const selected=path.join(dir,'report & notes.txt');await fs.writeFile(selected,'Summary source.');
    await fs.writeFile(path.join(dir,'neighbour.txt'),'Excluded sibling.');
    const request=await askRequest(selected),validated=await validateRequest({allowedRoots:[dir]},request);
    assert.equal(validated.restrictFiles,true);assert.deepEqual(request.files,['report & notes.txt']);
    assert.equal(await selectedFilePath(dir,request,selected),await fs.realpath(selected));
    await assert.rejects(()=>selectedFilePath(dir,request,'neighbour.txt'),/Only the selected/);
    await assert.rejects(()=>validateRequest({allowedRoots:[path.dirname(dir)+'-other']},request));
    await assert.rejects(()=>validateRequest({}, {...request,files:['report & notes.txt','neighbour.txt']}),/exactly one/);
    await assert.rejects(()=>askRequest(dir),/not a folder/);
  }finally{await cleanup(dir);}
});
test('Ask Malyn rejects unsupported, binary, secret and linked input before launching inference',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'malyn-ask-types-'));
  try{
    for(const [name,content] of [['file.pdf','%PDF-'],['binary.txt',Buffer.from([1,0,2])],['invalid.txt',Buffer.from([0xff])],['credentials.txt','secret']]){
      await fs.writeFile(path.join(dir,name),content);await assert.rejects(()=>askRequest(path.join(dir,name)));
    }
    const sub=path.join(dir,'private');await fs.mkdir(sub);await fs.writeFile(path.join(sub,'file.txt'),'linked');
    await fs.symlink(sub,path.join(dir,'link'),process.platform==='win32'?'junction':'dir');
    await assert.rejects(()=>askRequest(path.join(dir,'link','file.txt')),/Links/);
  }finally{await cleanup(dir);}
});
