import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listLoops, getLoop, installLoop, parseLoop } from '../src/loops.mjs';
import { submitJob, getJob } from '../src/jobs.mjs';
import { readImage } from '../src/images.mjs';
import { cleanup } from './helpers.mjs';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jHh8AAAAASUVORK5CYII=', 'base64');

test('bundled loops are discoverable without configuration and shared Markdown installs without execution', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'malyn-loops-'));
  try {
    const config = path.join(dir, 'malyn.config.json');
    assert.deepEqual((await listLoops(config)).loops.map(l => l.name), ['ask-malyn','describe-my-image','embed-local-files','transcribe-audio','windows-system-logs']);
    const builtin = await getLoop(config, 'describe-my-image');
    assert.ok(builtin.model.capabilities.includes('vision'));
    assert.match(builtin.workerContract, /image-description.md/);
    const shared = path.join(dir, 'my-image-loop.md');
    await fs.writeFile(shared, builtin.markdown.replaceAll('describe-my-image','my-image-loop'));
    const result = await installLoop(config, shared);
    assert.equal(result.executed, false);
    assert.equal((await getLoop(config, 'my-image-loop')).origin, 'user');
    await assert.rejects(() => installLoop(config, shared), /already exists/);
    await assert.rejects(() => getLoop(config, '../outside'), /Invalid/);
    assert.throws(() => parseLoop(builtin.markdown.replace('"vision"', '"text"')), /vision/);
    assert.throws(() => parseLoop(builtin.markdown.replace('"image-description.md"', '"answer.txt"')), /reserved/);
    await assert.rejects(() => submitJob(config, {}, { root: dir, loop: 'describe-my-image' }), /requires 1/);
  } finally { await cleanup(dir); }
});

test('image inputs are bounded, scoped and checked for actual file signatures', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'malyn-images-'));
  try {
    await fs.writeFile(path.join(dir,'ok.png'), png);
    assert.deepEqual((await readImage(dir,'ok.png')).bytes, png);
    await fs.writeFile(path.join(dir,'fake.png'), 'not an image');
    await assert.rejects(() => readImage(dir,'fake.png'), /signature/);
    await assert.rejects(() => readImage(dir,'../outside.png'), /task root/);
    await assert.rejects(() => readImage(dir,path.join(dir,'ok.png')), /relative/);
    const large = await fs.open(path.join(dir,'large.png'),'w'); await large.truncate(10*1024*1024+1); await large.close();
    await assert.rejects(() => readImage(dir,'large.png'), /10 MiB/);
  } finally { await cleanup(dir); }
});

test('default check does not expose generated details or raw errors; summary opt-in is explicit', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'malyn-private-'));
  const id = '12345678-1234-1234-1234-123456789abc';
  try {
    const job = path.join(dir,'jobs',id); await fs.mkdir(job,{recursive:true});
    const file = path.join(job,'status.json');
    const details = { id, status:'completed', summary:'PRIVATE_IMAGE_TEXT', error:'PRIVATE_HOST_ERROR', artifacts:[{path:path.join(job,'report.md'),bytes:100}] };
    await fs.writeFile(file,JSON.stringify(details));
    const safe = await getJob(path.join(dir,'config.json'),id);
    assert.ok(!JSON.stringify(safe).includes('PRIVATE_'));
    assert.equal(safe.artifacts.length,1);
    await fs.writeFile(file,JSON.stringify({...details,returnMode:'summary'}));
    assert.equal((await getJob(path.join(dir,'config.json'),id)).summary,'PRIVATE_IMAGE_TEXT');
    await fs.writeFile(file,JSON.stringify({...details,status:'failed'}));
    const failed = await getJob(path.join(dir,'config.json'),id);
    assert.ok(!JSON.stringify(failed).includes('PRIVATE_'));
    assert.equal(failed.diagnosticPath,file);
  } finally { await cleanup(dir); }
});
