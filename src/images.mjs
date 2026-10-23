import fs from 'node:fs/promises';
import path from 'node:path';
import { scopedPath } from './files.mjs';

export async function readImage(root, relative) {
  if (typeof relative !== 'string' || path.isAbsolute(relative)) throw new Error('Images must be relative paths within the task root.');
  const file = await scopedPath(root, relative);
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > 10 * 1024 * 1024) throw new Error('Each image must be a regular file of at most 10 MiB.');
  const bytes = await fs.readFile(file);
  const ext = path.extname(file).toLowerCase();
  const png = bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const webp = bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP';
  if (!((ext === '.png' && png) || (['.jpg','.jpeg'].includes(ext) && jpeg) || (ext === '.webp' && webp))) throw new Error('Expected a PNG, JPEG or WebP image with a matching file signature.');
  return { name: path.basename(file), bytes };
}
