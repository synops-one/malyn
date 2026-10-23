import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { readConfig, saveConfig, validateConfig } from './config.mjs';
import { downloadedModels } from './models.mjs';
import { withIdleWorker } from './jobs.mjs';

export const adminSettingsSchema = z.object({
  modelKey: z.string().min(1).max(300).optional(),
  contextLength: z.number().int().min(8192).max(262144).optional(),
  kvCacheQuantization: z.enum(['q8_0','q4_0','f16']).optional(),
  maxOutputTokens: z.number().int().min(32).max(16384).optional(),
  reasoningBudget: z.number().int().min(0).max(16384).optional(),
  maxPredictionRounds: z.number().int().min(1).max(16).optional(),
  maxToolCalls: z.number().int().min(1).max(64).optional(),
  ttlSeconds: z.number().int().min(60).max(86400).optional(),
  jobTimeoutSeconds: z.number().int().min(60).max(14400).optional(),
  gpuPattern: z.string().min(1).max(200).optional(),
  runtimePattern: z.string().min(1).max(200).optional(),
  allowIntegratedGpu: z.boolean().optional(),
  allowedRoots: z.array(z.string().refine(path.isAbsolute, 'Use absolute directories.')).max(50).optional(),
}).strict().refine(value => Object.keys(value).length > 0, 'Supply at least one setting.');
export function visibleSettings(config) {
  return Object.fromEntries(['modelKey','contextLength','kvCacheQuantization','maxOutputTokens','reasoningBudget','maxPredictionRounds','maxToolCalls','ttlSeconds','jobTimeoutSeconds','gpuPattern','runtimePattern','allowIntegratedGpu','allowedRoots'].map(key => [key, config[key]]));
}
export async function configureAdmin(configPath, changes, dependencies = {}) {
  const patch = adminSettingsSchema.parse(changes);
  return withIdleWorker(configPath, async () => {
    const config = validateConfig({ ...await readConfig(configPath), ...patch });
    for (const root of config.allowedRoots) {
      if (!(await fs.stat(root)).isDirectory()) throw new Error('Each allowed root must be an existing directory.');
    }
    if ('modelKey' in patch || 'contextLength' in patch) {
      const models = await (dependencies.downloadedModels ?? downloadedModels)(config);
      const model = models.find(item => item.modelKey === config.modelKey);
      if (!model) throw new Error('Select a model already downloaded on this computer.');
      if (model.maxContextLength && config.contextLength > model.maxContextLength) throw new Error('Context exceeds the model\'s advertised maximum.');
    }
    await saveConfig(configPath, config, { overwrite: true });
    return { configured: true, settings: visibleSettings(config), loadRequested: false };
  });
}
