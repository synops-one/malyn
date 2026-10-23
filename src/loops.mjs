import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const bundled = fileURLToPath(new URL('../loops/', import.meta.url));
const nameSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64);
const specSchema = z.object({
  schemaVersion: z.literal(1), name: nameSchema, description: z.string().min(1).max(300),
  processor: z.enum(['agent','whisper','embeddings']).optional(),
  platforms: z.array(z.enum(['win32', 'linux', 'darwin'])).min(1),
  model: z.object({
    capabilities: z.array(z.enum(['text', 'tools', 'vision','audio','transcription','embedding'])).min(1),
    minContextLength: z.number().int().min(8192).max(262144).optional(),
    minOutputTokens: z.number().int().min(32).max(16384).optional(),
    preferredModelKey: z.string().min(1).max(300).optional(),
  }).strict(),
  images: z.object({ min: z.number().int().min(0).max(4), max: z.number().int().min(0).max(4) }).strict(),
  output: z.object({ artifact: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/) }).strict(),
}).strict();
const reserved = new Set(['request.json','status.json','status.tmp','worker.log','cancel','answer.txt']);
export function parseLoop(markdown, expectedName) {
  if (Buffer.byteLength(markdown) > 65536 || markdown.includes('\0')) throw new Error('A loop must be UTF-8 Markdown of at most 64 KiB.');
  const block = markdown.match(/^```malyn-loop\r?\n([\s\S]*?)^```\s*$/m);
  if (!block) throw new Error('A loop needs a malyn-loop JSON metadata block.');
  const spec = specSchema.parse(JSON.parse(block[1]));
  if (expectedName && spec.name !== expectedName) throw new Error('Loop name must match its .md filename.');
  if (spec.images.min > spec.images.max || (spec.images.max > 0 && !spec.model.capabilities.includes('vision'))) throw new Error('Image loops must declare vision capability and valid image limits.');
  if ((!spec.processor || spec.processor==='agent') && (!spec.model.capabilities.includes('tools') || !spec.model.minContextLength)) throw new Error('Agent loops require tools and a minimum context.');
  if(spec.processor==='whisper' && (!spec.model.capabilities.includes('transcription') || spec.model.preferredModelKey!=='whisper/base' || spec.images.max!==0))throw new Error('Whisper loops require whisper/base, transcription and no images.');
  if(spec.processor==='embeddings' && (!spec.model.capabilities.includes('embedding') || spec.model.preferredModelKey!=='qwen/qwen3-vl-embedding-2b'))throw new Error('Embedding loops require Qwen3-VL-Embedding-2B.');
  if ((spec.model.minOutputTokens ?? 32) > spec.model.minContextLength / 2) throw new Error('Loop output allowance must leave room for inputs.');
  if (reserved.has(spec.output.artifact.toLowerCase())) throw new Error('Loop output uses a reserved worker filename.');
  const section = /^## Worker contract\s*\r?\n/m.exec(markdown);
  const workerContract = section ? markdown.slice(section.index + section[0].length).split(/^## /m)[0].trim() : '';
  if (!workerContract || workerContract.length > 10000) throw new Error('A loop needs a Worker contract section of 1–10000 characters.');
  return { ...spec, workerContract };
}
export const userLoopsDirectory = configPath => path.join(path.dirname(path.resolve(configPath)), 'loops');
async function readFile(filename, expectedName) {
  const stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw new Error('Expected a regular loop Markdown file of at most 64 KiB.');
  const markdown = await fs.readFile(filename, 'utf8');
  return { ...parseLoop(markdown, expectedName), markdown, path: filename };
}
async function candidates(configPath) {
  const result = [];
  for (const [directory, origin] of [[bundled, 'bundled'], [userLoopsDirectory(configPath), 'user']]) {
    try {
      if ((await fs.lstat(directory)).isSymbolicLink()) throw new Error('Linked loop directories are excluded.');
      for (const file of (await fs.readdir(directory)).sort()) if (/^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.test(file)) result.push({ name: file.slice(0,-3), filename: path.join(directory,file), origin });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return result;
}
export async function listLoops(configPath) {
  const loops = [], errors = [], seen = new Set();
  for (const item of await candidates(configPath)) {
    try {
      if (seen.has(item.name)) throw new Error('Duplicate loop name; bundled names cannot be shadowed.');
      const { markdown, workerContract, ...spec } = await readFile(item.filename, item.name);
      seen.add(item.name); loops.push({ ...spec, origin: item.origin });
    } catch (error) { errors.push({ name: item.name, error: error.message }); }
  }
  return { loops, errors, userDirectory: userLoopsDirectory(configPath) };
}
export async function getLoop(configPath, name) {
  nameSchema.parse(name);
  const found = (await candidates(configPath)).find(item => item.name === name);
  if (!found) throw new Error(`Unknown loop: ${name}. List loops first.`);
  return { ...await readFile(found.filename, name), origin: found.origin };
}
export async function installLoop(configPath, filename) {
  if (!path.isAbsolute(filename)) throw new Error('Use an absolute path to the shared .md file.');
  const loop = await readFile(filename, path.basename(filename, '.md'));
  if (path.extname(filename) !== '.md') throw new Error('Shared loops must have a .md extension.');
  if ((await candidates(configPath)).some(item => item.name === loop.name)) throw new Error('That loop name already exists. Rename the shared loop and its metadata before installing.');
  const directory = userLoopsDirectory(configPath);
  await fs.mkdir(directory, { recursive: true });
  if ((await fs.lstat(directory)).isSymbolicLink()) throw new Error('Linked loop directories are excluded.');
  const target = path.join(directory, `${loop.name}.md`);
  await fs.writeFile(target, loop.markdown, { flag: 'wx', mode: 0o600 });
  return { name: loop.name, path: target, installed: true, executed: false };
}
