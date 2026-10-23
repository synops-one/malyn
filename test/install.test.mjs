import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cleanup } from './helpers.mjs';
const exec = promisify(execFile);
const windows = { skip: process.platform !== 'win32' };
const install = (...args) => exec('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.resolve('Install-Malyn.ps1'), ...args], { windowsHide: true, timeout: 15000 });

test('migration refuses an existing destination config without changing either copy', windows, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'malyn-install-'));
  try {
    const old = path.join(directory, 'old'), target = path.join(directory, 'new');
    await fs.mkdir(old); await fs.mkdir(target);
    const original = '{"modelKey":"existing","contextLength":131072}';
    const active = '{"modelKey":"newer-settings","contextLength":32768}';
    await fs.writeFile(path.join(old, 'malyn.config.json'), original);
    await fs.writeFile(path.join(target, 'malyn.config.json'), active);
    await assert.rejects(() => install('-MigrateFrom', old, '-InstallDir', target, '-SkipRegister', '-SkipSmoke'), /already configured/);
    assert.equal(await fs.readFile(path.join(old, 'malyn.config.json'), 'utf8'), original);
    assert.equal(await fs.readFile(path.join(target, 'malyn.config.json'), 'utf8'), active);
    assert.deepEqual(await fs.readdir(target), ['malyn.config.json']);
  } finally { await cleanup(directory); }
});

test('migration refuses a live old worker before copying or loading anything', windows, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'malyn-active-'));
  try {
    const old = path.join(directory, 'old'), target = path.join(directory, 'new');
    await fs.mkdir(path.join(old, 'jobs'), { recursive: true });
    await fs.writeFile(path.join(old, 'malyn.config.json'), JSON.stringify({ modelKey: 'existing' }));
    await fs.writeFile(path.join(old, 'jobs/worker.lock'), JSON.stringify({ pid: process.pid }));
    await assert.rejects(() => install('-MigrateFrom', old, '-InstallDir', target, '-SkipRegister', '-SkipSmoke'), /active or unfinished worker/);
    await assert.rejects(() => fs.access(target), { code: 'ENOENT' });
  } finally { await cleanup(directory); }
});

test('migration ownership check rejects relative paths and sibling path prefixes', windows, async () => {
  const helper = path.resolve('scripts/windows-common.ps1').replaceAll("'", "''");
  const script = `. '${helper}'; @( (Test-MalynChildPath 'C:\\old\\runtime\\node.exe' 'C:\\old'), (Test-MalynChildPath 'C:\\older\\runtime\\node.exe' 'C:\\old'), (Test-MalynChildPath 'runtime\\node.exe' 'C:\\old'), (Test-MalynChildPath 'C:\\old\\..\\other\\app.mjs' 'C:\\old') ) | ConvertTo-Json -Compress`;
  const result = await exec('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true });
  assert.deepEqual(JSON.parse(result.stdout), [true, false, false, false]);
});
