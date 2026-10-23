import fs from 'node:fs/promises';
import path from 'node:path';
import { waitForOwnership, releaseLock, jobsDirectory } from '../../src/jobs.mjs';
const [, , , jobFile, config] = process.argv;
const request = JSON.parse(await fs.readFile(jobFile, 'utf8'));
const directory = path.dirname(jobFile);
await waitForOwnership(config, request.id);
const startedAt = new Date().toISOString();
await fs.writeFile(path.join(directory, 'status.json'), JSON.stringify({ id: request.id, status: 'running', pid: process.pid, startedAt }));
const deadline = Date.now() + 15000;
let cancelled = false;
while (Date.now() < deadline) {
  try { await fs.access(path.join(directory, 'cancel')); cancelled = true; break; } catch { /* waiting */ }
  await new Promise(resolve => setTimeout(resolve, 25));
}
await fs.writeFile(path.join(directory, 'status.tmp'), JSON.stringify({ id: request.id, status: cancelled ? 'cancelled' : 'failed', pid: process.pid, startedAt }));
await fs.rename(path.join(directory, 'status.tmp'), path.join(directory, 'status.json'));
await releaseLock(path.join(jobsDirectory(config), 'worker.lock'), request.id);
