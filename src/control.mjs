import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { withSubmissionLock } from './jobs.mjs';

export const controlPath = configPath => path.join(path.dirname(path.resolve(configPath)), 'control.json');
const schema = z.object({ paused: z.boolean(), screenshotMode: z.boolean().default(false) }).strict();
export async function readControl(configPath) {
  try { return schema.parse(JSON.parse(await fs.readFile(controlPath(configPath), 'utf8'))); }
  catch (error) { if (error.code === 'ENOENT') return { paused: false, screenshotMode:false }; throw error; }
}
export async function setPaused(configPath, paused) {
  if(typeof paused!=='boolean')throw new Error('paused must be boolean.');
  return setControl(configPath,{paused});
}
export async function setScreenshotMode(configPath,screenshotMode) {
  if(typeof screenshotMode!=='boolean')throw new Error('screenshotMode must be boolean.');
  return setControl(configPath,{screenshotMode});
}
async function setControl(configPath,patch) {
  return withSubmissionLock(configPath, async () => {
    const control=schema.parse({...await readControl(configPath),...patch});
    const target = controlPath(configPath), temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(control), { mode: 0o600, flag: 'wx' });
      await fs.rename(temporary, target);
    } finally { await fs.rm(temporary, { force: true }); }
    return { ...control, activeJobUnaffected: true };
  });
}
