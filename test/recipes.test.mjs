import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getRecipe, listRecipes, parseRecipe, importRecipe, installRecipe, exportRecipe, recipeName } from '../src/recipes.mjs';
import { submitJob, cancelJob, getJob } from '../src/jobs.mjs';
import { cleanup } from './helpers.mjs';

async function fixture(t) {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'malyn-recipes-'));
  t.after(()=>cleanup(directory));
  const config=path.join(directory,'config.json');
  const original=await exportRecipe(config,'describe-my-image');
  const markdown=original.markdown.replaceAll('describe-my-image','my-image-recipe');
  return {directory,config,original,input:{filename:'my-image-recipe.md',markdown}};
}
test('recipe export and import preserve model requirements and contracts without executing or including local data',async t=>{
  const {directory,config,original,input}=await fixture(t);
  await fs.writeFile(config,'PRIVATE CONFIG');
  await fs.mkdir(path.join(directory,'jobs'));
  await fs.writeFile(path.join(directory,'jobs','private.txt'),'PRIVATE JOB');
  assert.deepEqual(Object.keys(original),['filename','markdown']);
  const result=await importRecipe(config,input);
  assert.equal(result.executed,false);
  assert.equal(path.dirname(result.path),path.join(directory,'recipes'));
  assert.equal((await getRecipe(config,'my-image-recipe')).origin,'user');
  assert.deepEqual(await exportRecipe(config,'my-image-recipe'),input);
  assert.deepEqual(parseRecipe(input.markdown).model,parseRecipe(original.markdown).model);
  assert.deepEqual(await fs.readdir(path.join(directory,'jobs')),['private.txt']);
  assert.equal(await fs.readFile(config,'utf8'),'PRIVATE CONFIG');
  await assert.rejects(()=>importRecipe(config,input),/already exists/);
  assert.deepEqual(await exportRecipe(config,'my-image-recipe'),input);
  assert.equal((await listRecipes(config)).recipes.length,6);
});
test('legacy user directory and metadata remain readable; exports and imports use recipe metadata',async t=>{
  const {directory,config,input}=await fixture(t);
  const legacy=input.markdown.replace('```malyn-recipe','```malyn-loop');
  await fs.mkdir(path.join(directory,'loops'));
  const file=path.join(directory,'loops',input.filename);
  await fs.writeFile(file,legacy);
  assert.equal((await getRecipe(config,'my-image-recipe')).origin,'user');
  assert.deepEqual(await exportRecipe(config,'my-image-recipe'),input);
  assert.equal(await fs.readFile(file,'utf8'),legacy);
  await assert.rejects(()=>importRecipe(config,input),/already exists/);
  const other=path.join(directory,'second','config.json');
  await installRecipe(other,file);
  assert.equal((await getRecipe(other,'my-image-recipe')).markdown,input.markdown);
});
test('recipe imports reject traversal, ambiguous contracts, reserved outputs and invalid bounds before writing',async t=>{
  const {directory,config,input,original}=await fixture(t);
  for(const filename of ['../escape.md','x/escape.md','C:\\escape.md','recipe.txt','CON.md'])await assert.rejects(()=>importRecipe(config,{...input,filename}));
  await assert.rejects(()=>importRecipe(config,{...input,filename:'different.md'}),/match/);
  await assert.rejects(()=>importRecipe(config,{...input,path:'outside'}));
  await assert.rejects(()=>importRecipe(config,{...input,markdown:input.markdown+input.markdown}),/exactly one/);
  await assert.rejects(()=>importRecipe(config,{...input,markdown:input.markdown+'\0'}),/64 KiB/);
  await assert.rejects(()=>importRecipe(config,{...input,markdown:input.markdown.replace('image-description.md','answer.txt')}),/reserved/);
  await assert.rejects(()=>importRecipe(config,{...input,markdown:input.markdown.replace('"vision"','"text"')}),/vision/);
  await assert.rejects(()=>importRecipe(config,original),/already exists/);
  await assert.rejects(()=>exportRecipe(config,'../config'));
  await assert.rejects(()=>fs.access(path.join(directory,'recipes')),{code:'ENOENT'});
});
test('recipe byte limit includes multibyte text and canonical export remains importable',async t=>{
  const {config,input}=await fixture(t);
  const prefix=input.markdown+'\n## Notes\n';
  const markdown=prefix+'x'.repeat(65536-Buffer.byteLength(prefix));
  await importRecipe(config,{...input,markdown});
  assert.equal(Buffer.byteLength((await exportRecipe(config,'my-image-recipe')).markdown),65536);
  await assert.rejects(()=>importRecipe(config,{...input,markdown:markdown+'é'}),/64 KiB/);
});
test('linked recipe directories and malformed UTF-8 cannot be imported',async t=>{
  const {directory,config,input}=await fixture(t);
  const file=path.join(directory,input.filename);
  await fs.writeFile(file,Buffer.concat([Buffer.from(input.markdown),Buffer.from([0xff])]));
  await assert.rejects(()=>installRecipe(config,file),/encoded data/);
  const target=path.join(directory,'elsewhere');await fs.mkdir(target);
  await fs.symlink(target,path.join(directory,'recipes'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(()=>importRecipe(config,input),/Linked recipe/);
  assert.deepEqual(await fs.readdir(target),[]);
});
test('recipe submit alias snapshots the contract and rejects conflicting legacy names',async t=>{
  const {directory,config}=await fixture(t);
  assert.equal(recipeName({loop:'ask-malyn'}),'ask-malyn');
  assert.equal(recipeName({recipe:'ask-malyn',loop:'ask-malyn'}),'ask-malyn');
  await assert.rejects(()=>submitJob(config,{}, {root:directory,recipe:'ask-malyn',loop:'describe-my-image'}),/conflicting/);
  const result=await submitJob(config,{}, {root:directory,recipe:'ask-malyn'},{workerPath:path.resolve('test/fixtures/waiting-worker.mjs')});
  try {
    assert.equal(result.status,'running');
    const request=JSON.parse(await fs.readFile(path.join(directory,'jobs',result.id,'request.json'),'utf8'));
    assert.equal(request.loopSpec.name,'ask-malyn');
    assert.equal(request.loopSpec.workerContract,(await getRecipe(config,'ask-malyn')).workerContract);
    assert.equal(request.task,'Run the ask-malyn recipe.');
  } finally {
    await cancelJob(config,result.id);
    const deadline=Date.now()+10000;
    while((await getJob(config,result.id)).status==='running' && Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,50));
    assert.equal((await getJob(config,result.id)).status,'cancelled');
  }
});
