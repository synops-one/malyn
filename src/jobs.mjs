import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { inside } from './files.mjs';
import { getLoop } from './loops.mjs';
import { readImage } from './images.mjs';
import { readConfig } from './config.mjs';
import { readControl } from './control.mjs';
import { componentInputs } from './component-worker.mjs';

const validId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
export const jobsDirectory = configPath => path.join(path.dirname(path.resolve(configPath)), 'jobs');
export async function getJob(configPath, id) {
  if (!validId.test(id ?? '')) throw new Error('Invalid job ID.');
  const directory = path.join(jobsDirectory(configPath), id);
  if ((await fs.lstat(directory)).isSymbolicLink()) throw new Error('Linked job directories are excluded.');
  let state = JSON.parse(await fs.readFile(path.join(directory, 'status.json'), 'utf8'));
  if (state.status === 'running' && !alive(state.pid)) {
    // The worker may have published its terminal state and exited after our read.
    state = JSON.parse(await fs.readFile(path.join(directory, 'status.json'), 'utf8'));
    if(state.status==='running')state.status='interrupted';
  }
  const result = { ...state, resultDirectory: directory };
  // Detailed generated text stays in local artifacts unless explicitly requested.
  if (state.returnMode !== 'summary') {
    delete result.summary;
    delete result.error;
    if (state.status === 'completed') result.summary = 'Malyn finished the local task. Detailed results are saved in the linked report.';
    else if (['failed','cancelled','interrupted','incomplete'].includes(state.status)) result.summary = `Malyn did not finish this task (${state.status}). See the local job report for details.`;
    if (state.error) result.diagnosticPath = path.join(directory, 'status.json');
  }
  return result;
}
export async function listJobs(configPath, limit = 20) {
  let entries;
  try { entries = await fs.readdir(jobsDirectory(configPath), { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const jobs = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !validId.test(entry.name)) continue;
    try {
      const { id, status, phase, startedAt, finishedAt } = await getJob(configPath, entry.name);
      jobs.push({ id, status, phase, startedAt, finishedAt });
    } catch { /* An interrupted creation may not have a status file. */ }
  }
  return jobs.sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? '')).slice(0, limit);
}
export async function cancelJob(configPath, id) {
  const state = await getJob(configPath, id);
  if (state.status === 'running') await fs.writeFile(path.join(state.resultDirectory, 'cancel'), 'cancel');
  return { id, cancellationRequested: state.status === 'running', status: state.status };
}
export async function validateRequest(config, request) {
  if (typeof request.task !== 'string' || !request.task.trim() || request.task.length > 12000 || !path.isAbsolute(request.root ?? '')) {
    throw new Error('submit requires a task of 1–12000 characters and an absolute root directory.');
  }
  const root = await fs.realpath(request.root);
  if (!(await fs.stat(root)).isDirectory()) throw new Error('root must be a directory.');
  if (config.allowedRoots?.length) {
    const allowed = await Promise.all(config.allowedRoots.map(p => fs.realpath(p)));
    if (!allowed.some(p => inside(p, root))) throw new Error('Task root is outside configured allowedRoots.');
  }
  const files = request.files ?? [];
  if (!Array.isArray(files) || files.length > 30 || files.some(p => typeof p !== 'string' || path.isAbsolute(p) || !inside(root, path.resolve(root, p)))) {
    throw new Error('files must contain up to 30 relative paths within the task root.');
  }
  const images = request.images ?? [];
  if (!Array.isArray(images) || images.length > 4) throw new Error('Pass at most four images.');
  for (const image of images) await readImage(root, image);
  const returnMode = request.returnMode ?? 'links';
  if(request.restrictFiles!==undefined && typeof request.restrictFiles!=='boolean')throw new Error('restrictFiles must be boolean.');
  if(request.restrictFiles && files.length+images.length!==1)throw new Error('A selected-file job requires exactly one file or image.');
  if (!['links','summary'].includes(returnMode)) throw new Error('returnMode must be links or summary.');
  if (request.modelKey !== undefined && (typeof request.modelKey !== 'string' || !request.modelKey.trim() || request.modelKey.length > 300)) throw new Error('Invalid modelKey.');
  return { root, task: request.task, files, images, returnMode, ...(request.restrictFiles?{restrictFiles:true}:{}), ...(request.modelKey ? { modelKey: request.modelKey } : {}) };
}
export async function releaseLock(lockFile, id) {
  try {
    const current = JSON.parse(await fs.readFile(lockFile, 'utf8'));
    if (current.id === id) await fs.rm(lockFile);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
export async function waitForOwnership(configPath, id, pid = process.pid) {
  const file = path.join(jobsDirectory(configPath), 'worker.lock');
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const lock = JSON.parse(await fs.readFile(file, 'utf8'));
      if (lock.id === id && lock.pid === pid) return;
    } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    await delay(25);
  }
  throw new Error('Worker did not receive its job lock.');
}
export async function submitJob(configPath, config, request, options = {}) {
  return withSubmissionLock(configPath, async jobRoot => {
  if ((await readControl(configPath)).paused) return { status: 'paused', reason: 'Malyn is paused. Resume new tasks from the tray, admin UI or CLI.' };
  // Re-read inside the shared transaction so a settings change cannot race access checks.
  const loop = request.loop ? await getLoop(configPath, request.loop) : null;
  if (loop && !loop.platforms.includes(process.platform)) throw new Error('This loop does not support this platform.');
  if (loop && Array.isArray(request.images ?? []) && ((request.images ?? []).length < loop.images.min || (request.images ?? []).length > loop.images.max)) throw new Error(`Loop ${loop.name} requires ${loop.images.min}–${loop.images.max} images.`);
  if (!options.workerPath) config = await readConfig(configPath);
  const input = await validateRequest(config, { ...request, task: request.task?.trim() || (loop ? `Run the ${loop.name} loop.` : request.task) });
  if (loop) {
    if (input.images.length < loop.images.min || input.images.length > loop.images.max) throw new Error(`Loop ${loop.name} requires ${loop.images.min}–${loop.images.max} images.`);
    const { markdown, path: loopPath, origin, ...snapshot } = loop;
    input.loopSpec = snapshot;
    if (['whisper','embeddings'].includes(loop.processor)) await componentInputs(input.root,input);
  }
  return submitLocked(configPath, input, jobRoot, options);
  });
}
export async function withIdleWorker(configPath, operation) {
  return withSubmissionLock(configPath, async jobRoot => {
    try {
      const owner = JSON.parse(await fs.readFile(path.join(jobRoot, 'worker.lock'), 'utf8'));
      if (alive(owner.pid)) return { status: 'busy', job_id: owner.id, reason: 'Finish or cancel the active job before changing settings or models.' };
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return operation();
  });
}
export async function withSubmissionLock(configPath, operation) {
  const jobRoot = jobsDirectory(configPath);
  await fs.mkdir(jobRoot, { recursive: true });
  // Serialize stale-lock recovery as well as creation. Never auto-steal this short
  // transaction lock: concurrent recoverers could otherwise delete a new lock.
  const transactionFile = path.join(jobRoot, 'submission.lock');
  let transaction;
  try { transaction = await fs.open(transactionFile, 'wx'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let owner;
    try { owner = JSON.parse(await fs.readFile(transactionFile, 'utf8')); } catch { /* acquisition in progress */ }
    if (owner && !alive(owner.pid)) throw new Error(`Interrupted submission lock at ${transactionFile}. Stop submitting clients and remove that file before retrying.`);
    return { status: 'busy', reason: 'Another submission is acquiring the worker.' };
  }
  try {
    await transaction.writeFile(JSON.stringify({ pid: process.pid }));
    return await operation(jobRoot);
  } finally {
    await transaction.close();
    await fs.rm(transactionFile, { force: true });
  }
}
async function submitLocked(configPath, input, jobRoot, options) {
  const lockFile = path.join(jobRoot, 'worker.lock');
  const id = randomUUID();
  let lock;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { lock = await fs.open(lockFile, 'wx'); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let current;
      try { current = JSON.parse(await fs.readFile(lockFile, 'utf8')); }
      catch (readError) {
        if (readError.code === 'ENOENT') continue;
        if (readError instanceof SyntaxError) return { status: 'busy', reason: 'Another submission is acquiring the worker.' };
        throw readError;
      }
      if (alive(current.pid)) return { status: 'busy', job_id: current.id };
      await releaseLock(lockFile, current.id);
    }
  }
  if (!lock) return { status: 'busy', reason: 'Retry submission.' };
  await lock.writeFile(JSON.stringify({ id, pid: process.pid })); await lock.close();
  const directory = path.join(jobRoot, id), startedAt = new Date().toISOString();
  let log, child;
  try {
    await fs.mkdir(directory);
    const jobFile = path.join(directory, 'request.json');
    await fs.writeFile(jobFile, JSON.stringify({ id, ...input }));
    await fs.writeFile(path.join(directory, 'status.json'), JSON.stringify({ id, status: 'running', phase: 'starting', pid: process.pid, startedAt, returnMode: input.returnMode }));
    log = await fs.open(path.join(directory, 'worker.log'), 'a');
    child = spawn(process.execPath, [options.workerPath ?? fileURLToPath(new URL('./worker.mjs', import.meta.url)), '--job', jobFile, path.resolve(configPath)], {
      windowsHide: true, detached: true, stdio: ['ignore', log.fd, log.fd],
    });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    // The child waits for ownership before writing status or releasing this lock.
    await fs.writeFile(path.join(directory, 'status.json'), JSON.stringify({ id, status: 'running', phase: 'starting', pid: child.pid, startedAt, returnMode: input.returnMode }));
    await fs.writeFile(lockFile, JSON.stringify({ id, pid: child.pid }));
    child.unref();
    return { id, status: 'running', checkAfterSeconds: 20 };
  } catch (error) {
    if (child?.pid) child.kill();
    await releaseLock(lockFile, id);
    await fs.writeFile(path.join(directory, 'status.json'), JSON.stringify({ id, status: 'failed', startedAt, error: error.message })).catch(() => {});
    throw error;
  } finally { await log?.close(); }
}
