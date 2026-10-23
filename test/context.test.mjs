import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createContextBudget, readLimits } from '../src/context.mjs';
import { readText } from '../src/files.mjs';
import { readConfig } from '../src/runtime.mjs';
import { cleanup } from './helpers.mjs';

test('128K admits large local reads and reserves space for subsequent output',()=>{
  const budget = createContextBudget(131072, 1000);
  assert.equal(budget.admit(90000),true);
  budget.recordPrediction({predictedTokensCount:2200});
  const before = budget.remaining();
  assert.equal(budget.admit(before),false); // Framing also costs context.
  assert.equal(budget.remaining(),before);
  assert.equal(budget.admit(before - 64),true);
  assert.equal(budget.remaining(),0);
  assert.ok(budget.reserveTokens >= 2200);
});

test('parallel tool results cannot collectively overrun the token budget',async()=>{
  const budget=createContextBudget(16384,1000);
  const accepted=await Promise.all([6000,6000].map(async n=>budget.admit(n)));
  assert.deepEqual(accepted,[true,false]);
  assert.equal(budget.readTokens,6064);
});

test('larger context can actually read beyond the former line and character caps',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'malyn-context-'));
  try {
    const lines=Array.from({length:1100},(_,i)=>`record ${i}: ${'sample data '.repeat(5)}`);
    await fs.writeFile(path.join(root,'large.txt'),lines.join('\n'));
    const result=await readText(root,'large.txt',1,2000,readLimits(131072));
    assert.ok(result.text.length>28000);
    assert.ok(result.text.includes('1100: record 1099:'));
    assert.equal(result.truncated,false);
    await fs.writeFile(path.join(root,'config.json'),JSON.stringify({lmsPath:'unused',modelKey:'unused'}));
    const config=await readConfig(path.join(root,'config.json'));
    assert.equal(config.contextLength,65536);
    assert.equal(config.kvCacheQuantization,'q8_0');
  } finally { await cleanup(root); }
});
