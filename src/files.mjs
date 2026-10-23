import fs from 'node:fs/promises';
import path from 'node:path';

const excluded = new Set(['node_modules']);
const secret = /^(\.env($|\.)|credentials($|\.)|id_(rsa|ed25519)($|\.))|\.(pfx|p12|key)$/i;
const excludedEntry = name => excluded.has(name.toLowerCase()) || secret.test(name)
  || (name.startsWith('.') && name !== '.' && name !== '..');

export function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

export async function scopedPath(root, name) {
  if (typeof name !== 'string' || name.includes('\0') || (process.platform === 'win32' && /:/.test(name.replace(/^[A-Za-z]:[\\/]/, '')))) {
    throw new Error('Use a normal file path inside the task root.');
  }
  const originalRoot = path.resolve(root);
  root = await fs.realpath(originalRoot);
  const supplied = path.resolve(originalRoot, name);
  const relative = inside(originalRoot, supplied) ? path.relative(originalRoot, supplied)
    : inside(root, supplied) ? path.relative(root, supplied) : null;
  if (relative === null) throw new Error('Path leaves the task root.');
  const resolved = path.resolve(root, relative);
  const parts = name.split(/[\\/]/);
  if (parts.some(excludedEntry)) throw new Error('Private or excluded path.');
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('Links are excluded from local worker reads.');
  }
  const real = await fs.realpath(resolved);
  if (!inside(root, real)) throw new Error('Link leaves the task root.');
  if (path.relative(root, real).split(path.sep).some(excludedEntry)) throw new Error('Link resolves to a private or excluded path.');
  return real;
}

export async function readText(root, name, start = 1, count = 200, limits = {}) {
  const file = await scopedPath(root, name);
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > 2_000_000) throw new Error('Expected a text file of at most 2 MB.');
  const bytes = await fs.readFile(file);
  if (bytes.includes(0)) throw new Error('Binary input: convert it to text before delegation.');
  const lines = bytes.toString('utf8').split(/\r?\n/);
  const offset = Math.max(0, start - 1);
  const { maxLines = 300, maxCharacters = 18000 } = limits;
  const selected = lines.slice(offset, offset + Math.min(maxLines, count));
  const text = selected.map((line, i) => `${offset + i + 1}: ${line}`).join('\n');
  return { path: name, totalLines: lines.length, text: text.slice(0, maxCharacters), truncated: text.length > maxCharacters || offset + selected.length < lines.length };
}

export async function listFiles(root, name = '.') {
  const directory = await scopedPath(root, name);
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const allowed = entries.filter(e => !excludedEntry(e.name) && !e.isSymbolicLink());
  return { entries: allowed.slice(0, 150).map(e => ({ name: e.name, type: e.isDirectory() ? 'directory' : 'file' })), truncated: allowed.length > 150 };
}

export async function searchFiles(root, needle, directory = '.') {
  if (!needle || needle.length > 300) throw new Error('Supply a literal search string of 1-300 characters.');
  const pending = [directory], matches = [];
  let scanned = 0;
  while (pending.length && scanned < 200 && matches.length < 40) {
    const name = pending.shift();
    let resolved, entries;
    try { resolved = await scopedPath(root, name); entries = await fs.readdir(resolved, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.isSymbolicLink() || excludedEntry(entry.name)) continue;
      const relative = path.join(name, entry.name);
      if (entry.isDirectory()) { if (pending.length < 100) pending.push(relative); continue; }
      if (++scanned > 200 || matches.length >= 40) break;
      try {
        const file = await scopedPath(root, relative);
        if ((await fs.stat(file)).size > 500000) continue;
        const bytes = await fs.readFile(file);
        if (bytes.includes(0)) continue;
        const lines = bytes.toString('utf8').split(/\r?\n/);
        for (let i = 0; i < lines.length && matches.length < 40; i++) {
          if (lines[i].includes(needle)) matches.push({ path: relative, line: i + 1, text: lines[i].slice(0, 400) });
        }
      } catch { /* unreadable entries are skipped */ }
    }
  }
  return { matches, scanned, bounded: true };
}

export async function writeArtifact(directory, name, content) {
  if (['request.json', 'status.json', 'status.tmp', 'worker.log', 'cancel', 'answer.txt'].includes(name?.toLowerCase())) throw new Error('Reserved worker control filename.');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(name)) throw new Error('Artifact name must be a simple filename.');
  if (typeof content !== 'string' || Buffer.byteLength(content) > 250000) throw new Error('Artifact exceeds 250 KB.');
  const target = path.join(directory, name);
  await fs.writeFile(target, content, { flag: 'wx', encoding: 'utf8' });
  return { path: target, bytes: Buffer.byteLength(content) };
}
