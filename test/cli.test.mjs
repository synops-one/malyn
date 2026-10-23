import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readConfig, validateConfig, defaultConfigPath } from '../src/config.mjs';
import { cleanup } from './helpers.mjs';
const exec = promisify(execFile);
const cli = (...args) => exec(process.execPath, [path.resolve('bin/malyn.mjs'), ...args], { windowsHide: true, timeout: 15000 });

test('CLI recipes export and import preserve Markdown and refuse overwrites',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'malyn-recipe-cli-'));
  t.after(()=>cleanup(directory));
  const config=path.join(directory,'config.json');
  assert.equal(JSON.parse((await cli('recipes','--config',config)).stdout).recipes.length,5);
  const output=path.join(directory,'describe-my-image.md');
  await cli('recipe','export','describe-my-image',output,'--config',config);
  const markdown=await fs.readFile(output,'utf8');
  await assert.rejects(()=>cli('recipe','export','describe-my-image',output,'--config',config),/EEXIST/);
  assert.equal(await fs.readFile(output,'utf8'),markdown);
  await assert.rejects(()=>cli('recipe','export','describe-my-image',path.join(directory,'wrong.md'),'--config',config),/filename matches/);
  const shared=path.join(directory,'shared-image.md');
  await fs.writeFile(shared,markdown.replaceAll('describe-my-image','shared-image'));
  assert.equal(JSON.parse((await cli('recipe','import',shared,'--config',config)).stdout).executed,false);
  assert.match((await cli('recipe','shared-image','--config',config)).stdout,/malyn-recipe/);
});

test('CLI setup preserves existing config unless explicitly forced and creates a backup', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'malyn-cli-'));
  const config = path.join(directory, 'config.json');
  try {
    const result = JSON.parse((await cli('setup', '--config', config, '--no-probe', '--lms', 'unused')).stdout);
    assert.equal(result.inferenceVerified, false);
    assert.equal((await readConfig(config)).modelIdentifier, 'malyn-worker');
    assert.equal((await readConfig(config)).profile, 'arc-b580');
    assert.equal((await readConfig(config)).modelKey, 'google/gemma-4-12b-qat');
    assert.equal((await readConfig(config)).contextLength, 65536);
    const before = await fs.readFile(config, 'utf8');
    await assert.rejects(() => cli('setup', '--config', config, '--no-probe'), /already exists/);
    assert.equal(await fs.readFile(config, 'utf8'), before);
    await cli('setup', '--config', config, '--no-probe', '--force', '--context', '32768');
    assert.equal(await fs.readFile(`${config}.previous`, 'utf8'), before);
    assert.equal((await readConfig(config)).contextLength, 32768);
    assert.deepEqual(JSON.parse((await cli('jobs', '--config', config)).stdout), []);
    await cli('setup', '--config', config, '--no-probe', '--force', '--profile', 'arc-b60');
    assert.equal((await readConfig(config)).gpuPattern, 'Arc.*Pro B60');
    assert.equal((await readConfig(config)).modelKey, 'qwen/qwen3.8-27b');
    assert.equal((await readConfig(config)).contextLength, 131072);
  } finally { await cleanup(directory); }
});
test('invalid configuration and incomplete custom setup fail before writing', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'malyn-config-'));
  try {
    const config = path.join(directory, 'config.json');
    await assert.rejects(() => cli('setup', '--config', config, '--profile', 'custom', '--no-probe'), /requires/);
    await assert.rejects(() => fs.access(config), { code: 'ENOENT' });
    assert.throws(() => validateConfig({ lmsPath: 'x', modelKey: 'x', gpuPattern: '[' }), /regular expression/);
    assert.throws(() => validateConfig({ lmsPath: 'x', modelKey: 'x', maxOutputTokens: 32, reasoningBudget: 100 }), /reasoningBudget/);
    assert.equal(validateConfig({ lmsPath: 'x', modelKey: 'x' }).modelIdentifier, 'malyn-worker');
  } finally { await cleanup(directory); }
});

test('Malyn configuration uses its explicit override and preserves custom model identifiers', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'malyn-config-path-'));
  try {
    const selected = path.join(directory, 'custom.config.json');
    const raw = { lmsPath: 'unused', modelKey: 'existing', contextLength: 131072 };
    await fs.writeFile(selected, JSON.stringify(raw));
    assert.equal(defaultConfigPath({ MALYN_CONFIG: selected }), selected);
    assert.equal(path.basename(defaultConfigPath({})), 'malyn.config.json');
    assert.equal((await readConfig(selected)).modelIdentifier, 'malyn-worker');
    await fs.writeFile(selected, JSON.stringify({ ...raw, modelIdentifier: 'my-existing-worker' }));
    assert.equal((await readConfig(selected)).modelIdentifier, 'my-existing-worker');
    assert.equal((await readConfig(selected)).contextLength, 131072);
  } finally { await cleanup(directory); }
});
