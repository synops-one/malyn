import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';

export const defaults = Object.freeze({
  backend: 'lmstudio', contextLength: 65536, kvCacheQuantization: 'q8_0',
  jobTimeoutSeconds: 2700, ttlSeconds: 3600, gpuPattern: 'Arc.*B580',
  runtimePattern: 'vulkan', allowIntegratedGpu: false, maxOutputTokens: 2200,
  reasoningBudget: 300, maxPredictionRounds: 8, maxToolCalls: 24, allowedRoots: [],
});
const schema = z.object({
  backend: z.literal('lmstudio'), lmsPath: z.string().min(1), modelKey: z.string().min(1),
  modelIdentifier: z.string().min(1).max(100),
  contextLength: z.number().int().min(8192).max(262144), kvCacheQuantization: z.enum(['q8_0', 'q4_0', 'f16']),
  jobTimeoutSeconds: z.number().int().min(60).max(14400), ttlSeconds: z.number().int().min(60).max(86400),
  gpuPattern: z.string().min(1).max(200), runtimePattern: z.string().min(1).max(200), allowIntegratedGpu: z.boolean(),
  maxOutputTokens: z.number().int().min(32).max(16384), reasoningBudget: z.number().int().min(0).max(16384),
  maxPredictionRounds: z.number().int().min(1).max(16), maxToolCalls: z.number().int().min(1).max(64),
  maxReadTokens: z.number().int().min(256).max(250000).optional(),
  allowedRoots: z.array(z.string().refine(path.isAbsolute, 'Root must be absolute')).max(50),
  profile: z.enum(['arc-b580', 'arc-b60', 'custom']).optional(),
}).strict();

export function defaultConfigPath(env = process.env) {
  if (env.MALYN_CONFIG) return path.resolve(env.MALYN_CONFIG);
  const base = process.platform === 'win32'
    ? (env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'))
    : (env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'));
  return path.join(base, 'Malyn', 'malyn.config.json');
}
export function validateConfig(input) {
  const config = schema.parse({ ...defaults, modelIdentifier: 'malyn-worker', ...input });
  for (const key of ['gpuPattern', 'runtimePattern']) {
    try { new RegExp(config[key], 'i'); } catch { throw new Error(`${key} must be a valid regular expression.`); }
  }
  if (config.reasoningBudget > config.maxOutputTokens) throw new Error('reasoningBudget must not exceed maxOutputTokens.');
  if (config.maxOutputTokens > config.contextLength / 2) throw new Error('maxOutputTokens must leave room for inputs.');
  return config;
}
export async function readConfig(filename = defaultConfigPath()) {
  const configPath = path.resolve(filename);
  let raw;
  try { raw = await fs.readFile(configPath, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error(`ENOENT: Malyn is not configured at ${configPath}. Run malyn setup or supply --config.`);
    throw error;
  }
  const input = JSON.parse(raw.replace(/^\uFEFF/, ''));
  return validateConfig(input);
}
export async function findLms() {
  let base = path.join(os.homedir(), '.lmstudio');
  try { base = (await fs.readFile(path.join(os.homedir(), '.lmstudio-home-pointer'), 'utf8')).trim(); } catch { /* default library */ }
  const candidate = path.join(base, 'bin', process.platform === 'win32' ? 'lms.exe' : 'lms');
  try { await fs.access(candidate); return candidate; } catch { return process.platform === 'win32' ? 'lms.exe' : 'lms'; }
}
export async function saveConfig(filename, input, { overwrite = false } = {}) {
  const config = validateConfig(input), target = path.resolve(filename);
  await fs.mkdir(path.dirname(target), { recursive: true });
  if (overwrite) {
    try { await fs.copyFile(target, `${target}.previous`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await fs.writeFile(target, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', flag: overwrite ? 'w' : 'wx', mode: 0o600 });
  return config;
}
