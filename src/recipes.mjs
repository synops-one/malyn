import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export const maxRecipeBytes = 65536;
const bundled = fileURLToPath(new URL('../recipes/', import.meta.url));
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
export function parseRecipe(markdown, expectedName) {
  if (typeof markdown !== 'string' || Buffer.byteLength(markdown) > maxRecipeBytes || markdown.includes('\0')) throw new Error('A recipe must be UTF-8 Markdown of at most 64 KiB.');
  const blocks = [...markdown.matchAll(/^```malyn-(?:recipe|loop)\r?\n([\s\S]*?)^```[ \t]*\r?$/gm)];
  if (blocks.length !== 1) throw new Error('A recipe needs exactly one malyn-recipe JSON metadata block (legacy malyn-loop is also accepted).');
  const spec = specSchema.parse(JSON.parse(blocks[0][1]));
  if (expectedName && spec.name !== expectedName) throw new Error('Recipe name must match its .md filename.');
  if (spec.images.min > spec.images.max || (spec.images.max > 0 && !spec.model.capabilities.includes('vision'))) throw new Error('Image recipes must declare vision capability and valid image limits.');
  if ((!spec.processor || spec.processor==='agent') && (!spec.model.capabilities.includes('tools') || !spec.model.minContextLength)) throw new Error('Agent recipes require tools and a minimum context.');
  if(spec.processor==='whisper' && (!spec.model.capabilities.includes('transcription') || spec.model.preferredModelKey!=='whisper/base' || spec.images.max!==0))throw new Error('Whisper recipes require whisper/base, transcription and no images.');
  if(spec.processor==='embeddings' && (!spec.model.capabilities.includes('embedding') || spec.model.preferredModelKey!=='qwen/qwen3-vl-embedding-2b'))throw new Error('Embedding recipes require Qwen3-VL-Embedding-2B.');
  if ((spec.model.minOutputTokens ?? 32) > spec.model.minContextLength / 2) throw new Error('Recipe output allowance must leave room for inputs.');
  if (reserved.has(spec.output.artifact.toLowerCase())) throw new Error('Recipe output uses a reserved worker filename.');
  const section = /^## Worker contract\s*\r?\n/m.exec(markdown);
  const workerContract = section ? markdown.slice(section.index + section[0].length).split(/^## /m)[0].trim() : '';
  if (!workerContract || workerContract.length > 10000) throw new Error('A recipe needs a Worker contract section of 1–10000 characters.');
  return { ...spec, workerContract };
}
export const userRecipesDirectory = configPath => path.join(path.dirname(path.resolve(configPath)), 'recipes');
async function readFile(filename, expectedName) {
  const stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw new Error('Expected a regular recipe Markdown file of at most 64 KiB.');
  const markdown = new TextDecoder('utf-8', { fatal: true }).decode(await fs.readFile(filename));
  return { ...parseRecipe(markdown, expectedName), markdown, path: filename };
}
async function candidates(configPath) {
  const result = [];
  for (const [directory, origin] of [[bundled, 'bundled'], [userRecipesDirectory(configPath), 'user'], [legacyLoopsDirectory(configPath), 'user']]) {
    try {
      if ((await fs.lstat(directory)).isSymbolicLink()) throw new Error('Linked recipe directories are excluded.');
      for (const file of (await fs.readdir(directory)).sort()) if (/^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.test(file)) result.push({ name: file.slice(0,-3), filename: path.join(directory,file), origin });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return result;
}
export async function listRecipes(configPath) {
  const recipes = [], errors = [], seen = new Set();
  for (const item of await candidates(configPath)) {
    try {
      if (seen.has(item.name)) throw new Error('Duplicate recipe name; bundled names cannot be shadowed.');
      seen.add(item.name);
      const { markdown, workerContract, ...spec } = await readFile(item.filename, item.name);
      recipes.push({ ...spec, origin: item.origin });
    } catch (error) { errors.push({ name: item.name, error: error.message }); }
  }
  return { recipes, errors, userDirectory: userRecipesDirectory(configPath) };
}
export async function getRecipe(configPath, name) {
  nameSchema.parse(name);
  const found = (await candidates(configPath)).find(item => item.name === name);
  if (!found) throw new Error(`Unknown recipe: ${name}. List recipes first.`);
  return { ...await readFile(found.filename, name), origin: found.origin };
}

export const legacyLoopsDirectory = configPath => path.join(path.dirname(path.resolve(configPath)), 'loops');
export function recipeName(input) {
  if (input.recipe !== undefined && input.loop !== undefined && input.recipe !== input.loop) throw new Error('Pass recipe or the legacy loop alias, not conflicting names.');
  const name = input.recipe ?? input.loop;
  return name === undefined ? undefined : nameSchema.parse(name);
}
function canonicalMarkdown(markdown) { return markdown.replace(/^```malyn-loop(?=\r?$)/gm, '```malyn-recipe'); }
const importSchema = z.object({ filename: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/).max(67), markdown: z.string() }).strict();
export async function importRecipe(configPath, input) {
  const { filename, markdown } = importSchema.parse(input);
  const recipe = parseRecipe(markdown, filename.slice(0,-3));
  const normalized = canonicalMarkdown(markdown);
  parseRecipe(normalized, recipe.name);
  if ((await candidates(configPath)).some(item => item.name === recipe.name)) throw new Error('That recipe name already exists. Give your copy a new filename and matching metadata name before importing.');
  const directory = userRecipesDirectory(configPath);
  await fs.mkdir(directory, { recursive: true });
  if ((await fs.lstat(directory)).isSymbolicLink()) throw new Error('Linked recipe directories are excluded.');
  const target = path.join(directory, filename);
  await fs.writeFile(target, normalized, { flag: 'wx', mode: 0o600 });
  return { name: recipe.name, path: target, installed: true, executed: false };
}
export async function installRecipe(configPath, filename) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename)) throw new Error('Use an absolute path to the shared .md file.');
  if (path.extname(filename) !== '.md') throw new Error('Shared recipes must have a .md extension.');
  const recipe = await readFile(filename, path.basename(filename, '.md'));
  return importRecipe(configPath, { filename: path.basename(filename), markdown: recipe.markdown });
}
export async function exportRecipe(configPath, name) {
  const recipe = await getRecipe(configPath, name);
  const markdown = canonicalMarkdown(recipe.markdown);
  parseRecipe(markdown, name);
  return { filename: `${recipe.name}.md`, markdown };
}
