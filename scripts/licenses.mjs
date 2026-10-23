import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
const root = path.resolve(import.meta.dirname, '..');
const lock = JSON.parse(await fs.readFile(path.join(root, 'package-lock.json'), 'utf8'));
const destination = path.join(root, 'LICENSES');
await fs.mkdir(destination, { recursive: true });
const records = [];
for (const [relative, entry] of Object.entries(lock.packages).sort()) {
  if (!relative || entry.dev) continue;
  const directory = path.join(root, relative);
  const pkg = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
  const names = (await fs.readdir(directory)).filter(name => /^(?:licen[cs]e|copying|notice)(?:[.-]|$)/i.test(name));
  const notices = [];
  for (const name of names.sort()) {
    const original = path.join(directory, name);
    if (!(await fs.stat(original)).isFile()) continue;
    const bytes = await fs.readFile(original);
    const filename = `${pkg.name.replace(/[^a-z0-9.-]/gi, '_')}-${pkg.version}-${name}`;
    await fs.writeFile(path.join(destination, filename), bytes);
    notices.push({ file: `LICENSES/${filename}`, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  if (!notices.length) throw new Error(`No upstream license/notice file found for ${pkg.name}@${pkg.version}; review before release.`);
  records.push({ name: pkg.name, version: pkg.version, license: pkg.license ?? entry.license ?? 'Review required', notices });
}
await fs.writeFile(path.join(destination, 'inventory.json'), `${JSON.stringify(records, null, 2)}\n`);
const rows = records.map(r => `| ${r.name} | ${r.version} | ${r.license} | ${r.notices.map(n => `[${path.basename(n.file)}](${n.file})`).join(', ')} |`);
await fs.writeFile(path.join(root, 'THIRD_PARTY_NOTICES.md'), `# Third-party notices\n\nMalyn's MIT license covers its original code. These locked JavaScript dependencies retain their upstream terms; complete license/notice files are copied verbatim below. The Windows ZIP also includes the Node.js distribution license at runtime/NODE-LICENSE. LM Studio and model weights are separate upstream downloads, not included in these archives.\n\n| Package | Version | Declared license | Upstream text |\n| --- | --- | --- | --- |\n${rows.join('\n')}\n`);
console.log(`Recorded licenses for ${records.length} locked dependency installations.`);
