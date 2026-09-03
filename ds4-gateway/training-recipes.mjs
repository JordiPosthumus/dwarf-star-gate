import fs from 'node:fs';
import {createHash} from 'node:crypto';
const bytes=fs.readFileSync(new URL('../predictor/recipes.json',import.meta.url));
const policy=JSON.parse(bytes);
export const RECIPE_POLICY_SHA256=createHash('sha256').update(bytes).digest('hex');
export const DEFAULT_RECIPE=policy.default;
export const TRAINING_RECIPES=Object.freeze(policy.recipes.map(({id,label,description})=>Object.freeze({id,label,description})));
export function trainingRecipe(id=DEFAULT_RECIPE) {
  const recipe=TRAINING_RECIPES.find(r=>r.id===id);
  if(!recipe)throw new Error('Unknown reviewed training recipe');
  return recipe;
}
