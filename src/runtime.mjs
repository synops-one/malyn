import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { LMStudioClient } from '@lmstudio/sdk';
export { readConfig } from './config.mjs';

const exec = promisify(execFile);
export const logger = Object.fromEntries(['debug','info','warn','error'].map(level => [level, (...args) => console.error(...args)]));

export async function lms(config, args, timeout = 60000) {
  const env = config.profile === 'arc-b580' ? {...process.env,GGML_VK_DISABLE_HOST_VISIBLE_VIDMEM:'1'} : process.env;
  const { stdout } = await exec(config.lmsPath, args, { windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024, env });
  return stdout.trim();
}

export function chooseGpu(survey, pattern = 'Arc.*B580', options = {}) {
  for (const engine of survey.engines ?? []) {
    if (!new RegExp(options.runtimePattern ?? 'vulkan', 'i').test(engine.name) || engine.compatibility?.status !== 'compatible') continue;
    const gpus = engine.hardwareSurvey?.gpuSurveyResult?.gpuInfo ?? [];
    const gpu = gpus.find(g => (g.integrationType === 'discrete' || options.allowIntegratedGpu) && new RegExp(pattern, 'i').test(g.name));
    if (gpu) return { engine, gpu, disabled: gpus.filter(g => g.deviceId !== gpu.deviceId).map(g => g.deviceId) };
  }
  throw new Error(`GPU matching ${pattern} unavailable. Connect it and check the driver/runtime with malyn doctor. No CPU or remote fallback is enabled.`);
}

export async function inspect(config) {
  await lms(config, ['daemon', 'up']);
  const survey = JSON.parse(await lms(config, ['runtime', 'survey', '--refresh', '--json']));
  return chooseGpu(survey, config.gpuPattern, config);
}

export function matchesLoadConfig(actual,config,hardware) {
  return actual.contextLength===config.contextLength && actual.llamaKCacheQuantizationType===config.kvCacheQuantization && actual.llamaVCacheQuantizationType===config.kvCacheQuantization
    && actual.gpu?.ratio==='max' && actual.gpu.mainGpu===hardware.gpu.deviceId && hardware.disabled.every(id=>actual.gpu.disabledGpus?.includes(id)) && actual.offloadKVCacheToGpu===true;
}

export async function loadWorker(config, signal) {
  const hardware = await inspect(config);
  const client = new LMStudioClient({ logger });
  const models = await client.system.listDownloadedModels('llm');
  const disk = models.find(m => m.deviceIdentifier == null && m.modelKey === config.modelKey);
  if (!disk) throw new Error(`Local model ${config.modelKey} is missing. Rerun the installer. Linked machines are not used.`);
  const identifier = config.modelIdentifier ?? 'malyn-worker';
  let existing = (await client.llm.listLoaded()).find(m => m.identifier === identifier);
  if (existing?.deviceIdentifier != null) throw new Error(`The ${identifier} model identifier is used by a remote device.`);
  if (existing && existing.modelKey !== config.modelKey) {
    const active = JSON.parse(await lms(config, ['ps','--json'])).find(m => m.identifier === identifier && m.deviceIdentifier == null);
    if (!active || active.status !== 'idle' || active.queued > 0) throw new Error('The current worker model is busy; it was not unloaded.');
    await client.llm.unload(identifier, { deviceIdentifier: null });
    existing = null;
  }
  let model = existing ? await client.llm.model(identifier) : null;
  if (model) {
    const actual = await model.getLoadConfig();
    if (!matchesLoadConfig(actual,config,hardware)) {
      const active = JSON.parse(await lms(config, ['ps', '--json'])).find(m => m.identifier === identifier && m.deviceIdentifier == null);
      if (active && (active.status !== 'idle' || active.queued > 0)) throw new Error('Malyn is busy. Retry after its current prediction finishes to apply the context settings.');
      await client.llm.unload(identifier, { deviceIdentifier: null });
      model = null;
    }
  }
  model ??= await client.llm.load(config.modelKey, {
    deviceIdentifier: null,
    identifier,
    verbose: false,
    signal,
    ttl: config.ttlSeconds,
    config: {
      contextLength: config.contextLength, maxParallelPredictions: 1,
      gpu: { ratio: 'max', mainGpu: hardware.gpu.deviceId, disabledGpus: hardware.disabled },
      flashAttention: true, offloadKVCacheToGpu: true,
      autoFit: false, useUnifiedKvCache: true,
      llamaKCacheQuantizationType: config.kvCacheQuantization,
      llamaVCacheQuantizationType: config.kvCacheQuantization,
    },
  });
  return { model, hardware, disk, prepareImage: image => client.files.prepareImageBase64(image.name, image.bytes.toString('base64')) };
}

export async function status(config) {
  const hardware = await inspect(config);
  const loaded = JSON.parse(await lms(config, ['ps', '--json']));
  const worker = loaded.find(m => m.identifier === (config.modelIdentifier ?? 'malyn-worker') && m.deviceIdentifier == null);
  return {
    gpu: hardware.gpu.name,
    vramGiB: +(hardware.gpu.dedicatedMemoryCapacityBytes / 2**30).toFixed(2),
    runtime: `${hardware.engine.name}@${hardware.engine.version}`,
    model: config.modelKey,
    loaded: !!worker && worker.modelKey === config.modelKey,
    loadedModel: worker?.modelKey ?? null,
    identifierConflict: !!worker && worker.modelKey !== config.modelKey,
    contextLength: config.contextLength,
    loadedContextLength: worker?.contextLength ?? null,
    kvCacheQuantization: config.kvCacheQuantization,
    location: 'this computer',
  };
}
