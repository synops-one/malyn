import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { sourceFiles } from './release-files.mjs';
import { validateConfig } from '../src/config.mjs';
import { parseLoop } from '../src/loops.mjs';
const root = path.resolve(import.meta.dirname, '..');
const json = async relative => JSON.parse((await fs.readFile(path.join(root, relative), 'utf8')).replace(/^\uFEFF/, ''));
const pkg = await json('package.json'), lock = await json('package-lock.json'), plugin = await json('plugin.json'), mcp = await json('mcp.json');
assert.equal(pkg.name, lock.name); assert.equal(pkg.version, lock.version); assert.equal(pkg.version, plugin.version);
assert.deepEqual(await json('npm-shrinkwrap.json'), lock, 'Publishable shrinkwrap must match the development lock.');
assert.equal(pkg.license, 'MIT'); assert.equal(plugin.license, 'MIT');
assert.equal(plugin.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
assert.equal(mcp.$schema, 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json');
assert.equal(mcp.mcpServers.malyn.type, 'stdio');
assert.equal(mcp.mcpServers.malyn.args[0], '${PLUGIN_ROOT}/bin/malyn.mjs');
assert.equal(mcp.mcpServers.malyn.args[1], 'serve');
assert.match(await fs.readFile(path.join(root, pkg.bin.malyn), 'utf8'), /^#!\/usr\/bin\/env node/);
for (const relative of ['profiles/arc-b580.json', 'profiles/arc-b60.json', 'profiles/custom.example.json']) validateConfig(await json(relative));
for (const name of ['ask-malyn','describe-my-image', 'windows-system-logs', 'transcribe-audio', 'embed-local-files']) parseLoop(await fs.readFile(path.join(root, 'loops', `${name}.md`), 'utf8'), name);
const inventory = await json('LICENSES/inventory.json');
const deps = Object.entries(lock.packages).filter(([relative, entry]) => relative && !entry.dev);
assert.equal(inventory.length, deps.length, 'License inventory must match the locked production dependency count.');
for (const [, entry] of deps) assert.ok(entry.integrity, 'Dependencies must have registry integrity pins.');
for (const record of inventory) for (const notice of record.notices) {
  assert.ok(notice.file.startsWith('LICENSES/') && !notice.file.includes('..'));
  assert.equal(createHash('sha256').update(await fs.readFile(path.join(root, notice.file))).digest('hex'), notice.sha256);
}
const files = await sourceFiles(root);
for (const relative of files) {
  if (relative.startsWith('LICENSES/') || relative === 'THIRD_PARTY_NOTICES.md') continue;
  if (relative.endsWith('.png')) continue;
  const content = await fs.readFile(path.join(root, relative), 'utf8');
  assert.ok(!/[A-Za-z]:[\\/]Users[\\/][^\\/]+|codex[-]clipboard-|host[-]log-audit-|BEGIN (?:RSA |OPENSSH )?PRIVATE KEY/i.test(content), `Private host material in ${relative}`);
}
const skill = await fs.readFile(path.join(root, 'skills/malyn-worker/SKILL.md'), 'utf8');
assert.match(skill, /^---\r?\nname: malyn-worker\r?\ndescription: .+\r?\n---/);
console.log(`Release checks passed: ${files.length} source files, ${inventory.length} dependency notices, plugin metadata, profiles and privacy exclusions.`);
