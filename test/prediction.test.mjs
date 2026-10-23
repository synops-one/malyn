import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performTask } from '../src/worker.mjs';
import { validateConfig } from '../src/config.mjs';
import { cleanup } from './helpers.mjs';
import { getLoop } from '../src/loops.mjs';
const config = validateConfig({ lmsPath: 'unused', modelKey: 'fixture', maxOutputTokens: 64, reasoningBudget: 16, maxPredictionRounds: 2, maxToolCalls: 2 });
function runtime(act) {
  return { loadWorker: async () => ({
    model: { getContextLength: async () => 131072, countTokens: async s => Math.ceil(s.length / 4), act },
    hardware: { gpu: { name: 'test GPU' } }, disk: { modelKey: 'fixture' },
  }) };
}
test('prediction uses the real SDK output-limit option and reports truncation as incomplete', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'malyn-limit-'));
  try {
    const dependencies = runtime(async (_messages, _tools, options) => {
      assert.equal(options.maxTokens, 64);
      assert.equal(options.maxPredictedTokens, undefined);
      assert.equal(options.reasoningBudget, 16);
      assert.equal(options.maxPredictionRounds, 2);
      options.onPredictionCompleted({ stats: { stopReason: 'maxPredictedTokensReached', predictedTokensCount: options.maxTokens, promptTokensCount: 100 }, nonReasoningContent: 'partial draft' });
      return { rounds: 1, totalExecutionTimeSeconds: 0.1 };
    });
    const result = await performTask(config, { root: directory, task: 'Draft something' }, directory, () => {}, new AbortController().signal, dependencies);
    assert.equal(result.status, 'incomplete');
    assert.equal(result.localGeneratedTokens, 64);
    assert.equal(await fs.readFile(path.join(directory, 'answer.txt'), 'utf8'), 'partial draft');
  } finally { await cleanup(directory); }
});
test('cancellation remains unfinished even if the SDK resolves with partial text', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'malyn-abort-'));
  const controller = new AbortController();
  try {
    const dependencies = runtime(async (_messages, _tools, options) => {
      options.onPredictionCompleted({ stats: { stopReason: 'eosFound', predictedTokensCount: 10 }, nonReasoningContent: 'partial' });
      controller.abort(new Error('Cancelled by user'));
      return { rounds: 1, totalExecutionTimeSeconds: 0.1 };
    });
    await assert.rejects(() => performTask(config, { root: directory, task: 'Draft' }, directory, () => {}, controller.signal, dependencies), /Cancelled/);
    await assert.rejects(() => fs.access(path.join(directory, 'answer.txt')), { code: 'ENOENT' });
  } finally { await cleanup(directory); }
});
test('worker tools preserve source files, enforce call budget and save artifact-only output', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'malyn-tools-'));
  try {
    await fs.writeFile(path.join(directory, 'source.txt'), 'evidence');
    const output = path.join(directory, 'output'); await fs.mkdir(output);
    const dependencies = runtime(async (_messages, tools, options) => {
      const invoke = (name, args) => tools.find(t => t.name === name).implementation(args);
      assert.match((await invoke('read_file', { path: 'source.txt', start_line: 1, line_count: 10 })).text, /evidence/);
      await invoke('write_artifact', { name: 'draft.md', content: 'draft evidence' });
      await assert.rejects(() => invoke('read_file', { path: 'source.txt', start_line: 1, line_count: 10 }), /budget/);
      options.onPredictionCompleted({ stats: { stopReason: 'eosFound', predictedTokensCount: 10 }, nonReasoningContent: 'Saved draft.md' });
      return { rounds: 1, totalExecutionTimeSeconds: 0.1 };
    });
    const result = await performTask(config, { root: directory, task: 'Draft' }, output, () => {}, new AbortController().signal, dependencies);
    assert.equal(result.status, 'completed');
    assert.equal(result.artifacts.length, 1);
    assert.equal(await fs.readFile(path.join(directory, 'source.txt'), 'utf8'), 'evidence');
    assert.ok(result.localReadTokens > 0);
  } finally { await cleanup(directory); }
});

test('selected-file inference exposes no directory tools and blocks sibling reads even if the model asks',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'malyn-selected-tools-'));
  try {
    await fs.writeFile(path.join(directory,'selected.txt'),'selected evidence');
    await fs.writeFile(path.join(directory,'sibling.txt'),'private neighbour');
    const dependencies=runtime(async(_messages,tools,options)=>{
      assert.deepEqual(tools.map(t=>t.name),['read_file','write_artifact']);
      const read=args=>tools.find(t=>t.name==='read_file').implementation(args);
      assert.match((await read({path:'sibling.txt',start_line:1,line_count:10})).error,/Only the selected/);
      assert.match((await read({path:'selected.txt',start_line:1,line_count:10})).text,/selected evidence/);
      options.onPredictionCompleted({stats:{stopReason:'eosFound',predictedTokensCount:10},nonReasoningContent:'Checked selected file.'});
      return {rounds:1,totalExecutionTimeSeconds:0.1};
    });
    await performTask(config,{root:directory,files:['selected.txt'],restrictFiles:true,task:'Review selected'},directory,()=>{},new AbortController().signal,dependencies);
  }finally{await cleanup(directory);}
});

test('image loop supplies local images to the model and requires the named report artifact', async () => {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'malyn-vision-'));
  try {
    const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jHh8AAAAASUVORK5CYII=','base64');
    await fs.writeFile(path.join(directory,'image.png'),png);
    const loopSpec=await getLoop(path.join(directory,'config.json'),'describe-my-image');
    const dependencies=runtime(async (messages,_tools,options)=>{
      assert.deepEqual(messages[1].images,['local-image-handle']);
      assert.match(messages[1].content,/image-description.md/);
      options.onPredictionCompleted({stats:{stopReason:'eosFound',predictedTokensCount:10},nonReasoningContent:'Report ready.'});
      return {rounds:1,totalExecutionTimeSeconds:0.1};
    });
    const original=dependencies.loadWorker;
    dependencies.loadWorker=async()=>({...await original(),prepareImage:async image=>{assert.deepEqual(image.bytes,png);return 'local-image-handle';}});
    dependencies.downloadedModels=async()=>[{modelKey:'fixture',vision:true,trainedForToolUse:true,maxContextLength:262144}];
    const result=await performTask(config,{root:directory,task:'Describe',images:['image.png'],loopSpec},directory,()=>{},new AbortController().signal,dependencies);
    assert.equal(result.status,'incomplete');
    assert.equal(result.imageCount,1);
    assert.match(result.validationError,/required recipe report/);
  } finally { await cleanup(directory); }
});
