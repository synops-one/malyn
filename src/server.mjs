import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readConfig, defaultConfigPath } from './config.mjs';
import { status } from './runtime.mjs';
import { submitJob, getJob, cancelJob } from './jobs.mjs';
import { listLoops, getLoop, installLoop } from './loops.mjs';
import { listRecipes, getRecipe, installRecipe, exportRecipe, recipeName } from './recipes.mjs';
import { listModels, configureModel, settingsSchema } from './models.mjs';
import { listComponents } from './components.mjs';

export async function startServer(filename = defaultConfigPath()) {
  const configPath = path.resolve(filename);
  const server = new McpServer({ name: 'malyn-local-worker', version: JSON.parse(await fs.readFile(new URL('../package.json',import.meta.url),'utf8')).version });
  const asText = object => ({ content: [{ type: 'text', text: JSON.stringify(object) }] });
  server.registerTool('malyn', {
    description: 'Malyn helps with bounded local AI work using shareable Markdown recipes in her Kitchen. Use recipes to discover them, recipe to read one, import_recipe with recipe_file to add a reviewed local Markdown file, and export_recipe to get its shareable filename and Markdown. Import never runs the recipe. An image plus @malyn defaults to describe-my-image; Windows log checks use windows-system-logs. Use models/configure for local model choices and submit with recipe/root/files/images to run. Malyn checks and loads a compatible installed model. check returns report links by default; open or quote reports only when the user asks for details. Use returnMode summary only when requested. Collection steps belong to the supervising agent. Legacy loop actions remain supported.',
    inputSchema: {
      action: z.enum(['status', 'submit', 'check', 'cancel', 'recipes', 'recipe', 'import_recipe', 'export_recipe', 'loops', 'loop', 'install_loop', 'models', 'configure', 'components']),
      task: z.string().max(12000).optional(), root: z.string().optional(),
      files: z.array(z.string()).max(30).optional(), job_id: z.string().optional(),
      recipe: z.string().max(64).optional(), recipe_file: z.string().optional(),
      loop: z.string().max(64).optional(), loop_file: z.string().optional(),
      images: z.array(z.string()).max(4).optional(), modelKey: z.string().max(300).optional(),
      returnMode: z.enum(['links','summary']).optional(), settings: settingsSchema.optional(),
    },
  }, async args => {
    try {
      if (args.action === 'check') return asText(await getJob(configPath, args.job_id));
      if (args.action === 'cancel') return asText(await cancelJob(configPath, args.job_id));
      if (args.action === 'recipes') return asText(await listRecipes(configPath));
      if (args.action === 'recipe') {
        const { workerContract, ...recipe } = await getRecipe(configPath, recipeName(args));
        return asText(recipe);
      }
      if (args.action === 'import_recipe') return asText(await installRecipe(configPath, args.recipe_file));
      if (args.action === 'export_recipe') return asText(await exportRecipe(configPath, recipeName(args)));
      if (args.action === 'loops') return asText(await listLoops(configPath));
      if (args.action === 'loop') {
        const { workerContract, ...loop } = await getLoop(configPath, args.loop);
        return asText(loop); // The contract is already present in the Markdown.
      }
      if (args.action === 'install_loop') return asText(await installLoop(configPath, args.loop_file));
      if (args.action === 'configure') return asText(await configureModel(configPath, args.settings));
      if (args.action === 'components') return asText(await listComponents(configPath));
      const config = await readConfig(configPath);
      if (args.action === 'status') return asText(await status(config));
      if (args.action === 'models') return asText({...await listModels(config),...await listComponents(configPath)});
      return asText(await submitJob(configPath, config, args));
    } catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
  });
  await server.connect(new StdioServerTransport());
  return server;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await startServer(process.argv[2]);
}
