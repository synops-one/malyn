// Compatibility for older clients and stored jobs. New integrations use recipes.
import { listRecipes } from './recipes.mjs';
export { parseRecipe as parseLoop, getRecipe as getLoop, installRecipe as installLoop,
  userRecipesDirectory as userLoopsDirectory } from './recipes.mjs';
export async function listLoops(configPath) {
  const { recipes, ...rest } = await listRecipes(configPath);
  return { loops: recipes, ...rest };
}
