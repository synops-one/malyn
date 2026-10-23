import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cleanup } from './helpers.mjs';
const exec = promisify(execFile);
const psQuote = s => `'${s.replaceAll("'","''")}'`;
async function fixture(directory, mode) {
  const loop = await fs.readFile('recipes/windows-system-logs.md','utf8');
  const collector = path.join(directory,'collect.ps1');
  await fs.writeFile(collector,loop.match(/^```powershell\r?\n([\s\S]*?)^```/m)[1]);
  const output = path.join(directory,'snapshot');
  const wrapper = path.join(directory,'fixture.ps1');
  await fs.writeFile(wrapper, `
function global:Get-WinEvent {
  [CmdletBinding()] param($FilterHashtable, $MaxEvents)
  if (${psQuote(mode)} -eq 'empty-denied') {
    $id = if ($FilterHashtable.LogName -eq 'System') { 'NoMatchingEventsFound' } else { 'AccessDenied' }
    $errorRecord = New-Object System.Management.Automation.ErrorRecord((New-Object System.Exception('fixture')), $id, 'InvalidOperation', $null)
    $PSCmdlet.ThrowTerminatingError($errorRecord)
  }
  foreach ($n in 1..3) {
    [pscustomobject]@{RecordId=$n;Id=42;ProviderName='Fixture';Level=2;TimeCreated=(Get-Date);Message=('x' * 1300)}
  }
}
& ${psQuote(collector)} -OutputDirectory ${psQuote(output)} -MaxEventsPerChannel 2
`);
  await exec('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',wrapper],{windowsHide:true,timeout:15000});
  return output;
}
test('Windows loop collector enforces sample limits, clips messages and keeps channel-specific evidence IDs', {skip:process.platform!=='win32'}, async () => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'malyn-collector-'));
  try {
    const output=await fixture(dir,'events');
    const json=async f=>JSON.parse(await fs.readFile(path.join(output,f),'utf8'));
    const coverage=await json('coverage.json');
    assert.equal(coverage.totalCollected,4);
    assert.ok(coverage.channels.every(c=>c.eventLimitReached&&c.clippedMessages===2));
    const index=await json('evidence-index.json');
    assert.equal(new Set(index.map(x=>x.evidenceId)).size,4);
    const events=(await fs.readFile(path.join(output,'events-001.jsonl'),'utf8')).trim().split(/\r?\n/).map(JSON.parse);
    assert.ok(events.every(e=>e.message.length===1200));
    assert.deepEqual((await json('groups.json')).map(g=>g.countInCollectedSample),[2,2]);
    for(const group of await json('groups.json'))for(const source of group.exampleSources){
      const record=events[source.line-1];assert.equal(source.file,'events-001.jsonl');assert.equal(record.channel,group.channel);assert.ok(group.exampleEvidenceIds.includes(record.evidenceId));
    }
  } finally { await cleanup(dir); }
});
test('Windows loop collector distinguishes no matching events from an inaccessible channel', {skip:process.platform!=='win32'}, async () => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'malyn-empty-'));
  try {
    const output=await fixture(dir,'empty-denied');
    const coverage=JSON.parse(await fs.readFile(path.join(output,'coverage.json'),'utf8'));
    assert.deepEqual(coverage.channels.map(c=>c.status),['empty','unavailable']);
    assert.equal(coverage.totalCollected,0);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(output,'evidence-index.json'),'utf8')),[]);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(output,'groups.json'),'utf8')),[]);
  } finally { await cleanup(dir); }
});
