import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { submitJob, getJob, cancelJob, listJobs, validateRequest, releaseLock } from '../src/jobs.mjs';
import { cleanup } from './helpers.mjs';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
test('concurrent stale-lock recovery admits one worker; cancellation needs no config or GPU', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'malyn-jobs-'));
  const configPath = path.join(directory, 'missing.json');
  let id;
  try {
    await fs.mkdir(path.join(directory, 'jobs'));
    await fs.writeFile(path.join(directory, 'jobs', 'worker.lock'), JSON.stringify({ id: 'dead-worker', pid: 0 }));
    const responses = await Promise.all(Array.from({ length: 8 }, () => submitJob(configPath, {}, { root: directory, task: 'wait' }, { workerPath: path.resolve('test/fixtures/waiting-worker.mjs') })));
    const running = responses.filter(r => r.status === 'running');
    assert.equal(running.length, 1); id = running[0].id;
    assert.equal(responses.filter(r => r.status === 'busy').length, 7);
    assert.equal((await cancelJob(configPath, id)).cancellationRequested, true);
    const deadline = Date.now() + 10000;
    let job;
    do { await delay(50); job = await getJob(configPath, id); } while (job.status === 'running' && Date.now() < deadline);
    assert.equal(job.status, 'cancelled');
    assert.equal((await listJobs(configPath))[0].id, id);
    assert.equal((await cancelJob(configPath, id)).cancellationRequested, false);
    for (let i = 0; i < 40; i++) {
      try { await fs.access(path.join(directory, 'jobs', 'worker.lock')); await delay(25); }
      catch (error) { if (error.code !== 'ENOENT') throw error; break; }
    }
    await assert.rejects(() => fs.access(path.join(directory, 'jobs', 'worker.lock')), { code: 'ENOENT' });
  } finally {
    if (id) await cancelJob(configPath, id).catch(() => {});
    await cleanup(directory);
  }
});
test('a crashed submission transaction is reported without stealing its lock', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'malyn-stale-'));
  try {
    const jobs = path.join(directory, 'jobs'); await fs.mkdir(jobs);
    const file = path.join(jobs, 'submission.lock');
    await fs.writeFile(file, JSON.stringify({ pid: 0 }));
    await assert.rejects(() => submitJob(path.join(directory, 'config.json'), {}, { root: directory, task: 'x' }), /Interrupted submission lock/);
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).pid, 0);
  } finally { await cleanup(directory); }
});
test('allowed roots and relative suggestions are checked before starting a worker', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'malyn-roots-'));
  try {
    const allowed = path.join(directory, 'allowed'); await fs.mkdir(allowed);
    await assert.rejects(() => validateRequest({ allowedRoots: [allowed] }, { root: directory, task: 'x' }), /allowedRoots/);
    await assert.rejects(() => validateRequest({}, { root: allowed, task: 'x', files: ['../secret'] }), /relative/);
    assert.equal((await validateRequest({ allowedRoots: [directory] }, { root: allowed, task: 'x' })).root, await fs.realpath(allowed));
    const lock = path.join(directory, 'worker.lock');
    await fs.writeFile(lock, JSON.stringify({ id: 'current', pid: process.pid }));
    await releaseLock(lock, 'previous');
    assert.equal(JSON.parse(await fs.readFile(lock)).id, 'current');
  } finally { await cleanup(directory); }
});
