import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { selectModel, configureModel } from '../src/models.mjs';
import { validateConfig, readConfig } from '../src/config.mjs';
import { cleanup } from './helpers.mjs';
const base = validateConfig({lmsPath:'unused',modelKey:'text',contextLength:32768});
const models = [
  {modelKey:'text',vision:false,trainedForToolUse:true,maxContextLength:131072},
  {modelKey:'vision',vision:true,trainedForToolUse:true,maxContextLength:131072},
  {modelKey:'no-tools',vision:true,trainedForToolUse:false,maxContextLength:131072},
];
test('loop model requirements drive selection and explicit incompatible overrides fail', () => {
  const spec = {capabilities:['text','vision','tools'],minContextLength:65536,minOutputTokens:4096};
  const selected = selectModel(base,models,spec);
  assert.equal(selected.config.modelKey,'vision');
  assert.equal(selected.config.contextLength,65536);
  assert.equal(selected.config.maxOutputTokens,4096);
  assert.equal(base.modelKey,'text');
  assert.throws(() => selectModel(base,models,spec,'text'), /capabilities/);
  assert.throws(() => selectModel(base,models,spec,'missing'), /not installed/);
  assert.throws(() => selectModel(base,models,{...spec,minContextLength:262144}), /minimum context/);
  assert.equal(selectModel(base,models,{capabilities:['tools']}).selected.modelKey,'text');
});
test('MCP settings are validated and backed up, and cannot change during an active job', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'malyn-settings-'));
  try {
    const filename = path.join(dir,'config.json');
    const raw = JSON.stringify(base); await fs.writeFile(filename,raw);
    const dependencies = {downloadedModels:async () => models};
    await assert.rejects(() => configureModel(filename,{lmsPath:'different-program'},dependencies));
    await assert.rejects(() => configureModel(filename,{modelKey:'missing'},dependencies), /downloaded/);
    assert.equal(await fs.readFile(filename,'utf8'),raw);
    await fs.mkdir(path.join(dir,'jobs'),{recursive:true});
    const lock = path.join(dir,'jobs/worker.lock');
    await fs.writeFile(lock,JSON.stringify({pid:process.pid,id:'active'}));
    assert.equal((await configureModel(filename,{modelKey:'vision'},dependencies)).status,'busy');
    assert.equal((await readConfig(filename)).modelKey,'text');
    await fs.rm(lock);
    assert.equal((await configureModel(filename,{modelKey:'vision',contextLength:65536},dependencies)).configured,true);
    assert.equal((await readConfig(filename)).modelKey,'vision');
    assert.equal(await fs.readFile(`${filename}.previous`,'utf8'),raw);
  } finally { await cleanup(dir); }
});
