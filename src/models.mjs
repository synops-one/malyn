import { z } from 'zod';
import { LMStudioClient } from '@lmstudio/sdk';
import { readConfig, saveConfig, validateConfig } from './config.mjs';
import { lms, logger, loadWorker } from './runtime.mjs';
import { withIdleWorker } from './jobs.mjs';
import { getLoop } from './loops.mjs';
import { getComponent } from './components.mjs';

export const settingsSchema = z.object({
  modelKey: z.string().min(1).max(300).optional(),
  contextLength: z.number().int().min(8192).max(262144).optional(),
  kvCacheQuantization: z.enum(['q8_0','q4_0','f16']).optional(),
  maxOutputTokens: z.number().int().min(32).max(16384).optional(),
  reasoningBudget: z.number().int().min(0).max(16384).optional(),
  maxPredictionRounds: z.number().int().min(1).max(16).optional(),
  maxToolCalls: z.number().int().min(1).max(64).optional(),
  ttlSeconds: z.number().int().min(60).max(86400).optional(),
}).strict().refine(x => Object.keys(x).length > 0, 'Supply at least one setting.');

export async function downloadedModels(config) {
  await lms(config, ['daemon','up']);
  const client = new LMStudioClient({ logger });
  return (await client.system.listDownloadedModels('llm')).filter(m => m.deviceIdentifier == null);
}
export function selectModel(config, models, spec = {}, override) {
  const capabilities = spec.capabilities ?? ['text','tools'];
  const compatible = m => (!capabilities.includes('vision') || m.vision === true) && (!capabilities.includes('tools') || m.trainedForToolUse === true);
  const requested = override ?? spec.preferredModelKey;
  const selected = requested ? models.find(m => m.modelKey === requested) :
    models.find(m => m.modelKey === config.modelKey && compatible(m)) ?? [...models].sort((a,b) => a.modelKey.localeCompare(b.modelKey)).find(compatible);
  if (!selected) throw new Error(requested ? `Local model ${requested} is not installed. No model was downloaded.` : `No installed local model satisfies ${capabilities.join(', ')}. List models and install a suitable model separately.`);
  if (!compatible(selected)) throw new Error(`Model ${selected.modelKey} does not advertise the loop's required capabilities: ${capabilities.join(', ')}.`);
  const minimum = spec.minContextLength ?? 8192;
  if (selected.maxContextLength && selected.maxContextLength < minimum) throw new Error(`Model ${selected.modelKey} cannot satisfy the loop's minimum context ${minimum}.`);
  const contextLength = Math.max(minimum, Math.min(config.contextLength, selected.maxContextLength || config.contextLength));
  const maxOutputTokens = Math.max(config.maxOutputTokens, spec.minOutputTokens ?? 32);
  return { config: validateConfig({ ...config, modelKey: selected.modelKey, contextLength, maxOutputTokens }), selected };
}
export async function listModels(config) {
  return { models: (await downloadedModels(config)).map(m => ({ modelKey: m.modelKey, vision: m.vision, trainedForToolUse: m.trainedForToolUse, maxContextLength: m.maxContextLength, quantization: m.quantization })), configuredModel: config.modelKey, remoteModelsExcluded: true };
}
export async function configureModel(configPath, changes, dependencies = {}) {
  const settings = settingsSchema.parse(changes);
  return withIdleWorker(configPath, async () => {
    const config = validateConfig({ ...await readConfig(configPath), ...settings });
    const models = await (dependencies.downloadedModels ?? downloadedModels)(config);
    const model = models.find(m => m.modelKey === config.modelKey);
    if (!model) throw new Error('The configured model must already be downloaded on this computer.');
    if (model.maxContextLength && config.contextLength > model.maxContextLength) throw new Error('Requested context exceeds this model\'s advertised maximum.');
    await saveConfig(configPath, config, { overwrite: true });
    return { configured: true, settings: { modelKey: config.modelKey, contextLength: config.contextLength, kvCacheQuantization: config.kvCacheQuantization, maxOutputTokens: config.maxOutputTokens, reasoningBudget: config.reasoningBudget }, loadRequested: false, next: 'Submit a job to verify and load as needed; CLI prepare can load without inference.' };
  });
}
export async function prepareModel(configPath, loopName, modelKey, dependencies = {}) {
  return withIdleWorker(configPath, async () => {
    const config = await readConfig(configPath);
    const loop = loopName ? await getLoop(configPath, loopName) : null;
    if (loop && !loop.platforms.includes(process.platform)) throw new Error('This loop does not support this platform.');
    if (['whisper','embeddings'].includes(loop?.processor)) {
      const component=await getComponent(configPath,loop.processor,{verify:true});
      if(modelKey && modelKey!==component.modelKey)throw new Error('Model does not match this component loop.');
      return {ready:true,model:component.modelKey,loaded:false,loadsDuringJob:true,inferenceVerified:false};
    }
    const chosen = selectModel(config, await (dependencies.downloadedModels ?? downloadedModels)(config), loop?.model, modelKey);
    const loaded = await (dependencies.loadWorker ?? loadWorker)(chosen.config);
    return { loaded: true, model: loaded.disk.modelKey, contextLength: await loaded.model.getContextLength(), loop: loop?.name ?? null, configurationChanged: false, inferenceVerified: false };
  });
}

export async function unloadModel(configPath) {
  return withIdleWorker(configPath, async () => {
    const config = await readConfig(configPath);
    const loaded = JSON.parse(await lms(config, ['ps', '--json']));
    const own = loaded.find(model => model.identifier === config.modelIdentifier);
    if (!own) return { unloaded: false, alreadyUnloaded: true };
    if (own.deviceIdentifier != null || own.status !== 'idle' || own.queued > 0) throw new Error('The worker model is remote or busy; it was not unloaded.');
    await lms(config, ['unload', config.modelIdentifier]);
    return { unloaded: true };
  });
}
