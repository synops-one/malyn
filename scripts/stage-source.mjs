import fs from 'node:fs/promises';
import path from 'node:path';
import { sourceFiles } from './release-files.mjs';
const root = path.resolve(import.meta.dirname, '..');
const destination = path.resolve(process.argv[2] ?? path.join(root, 'build', `source-${Date.now()}`));
await fs.mkdir(destination, { recursive: false });
for (const relative of await sourceFiles(root)) {
  const target = path.join(destination, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(path.join(root, relative), target);
}
console.log(destination);
