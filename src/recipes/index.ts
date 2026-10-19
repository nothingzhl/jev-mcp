import type { Recipe } from "../core/contracts.js";
import { JevError } from "../core/errors.js";
import { rankCandidatesRecipe } from "./rank-candidates.js";
import { triageFailureRecipe } from "./triage-failure.js";
import { verifyClaimsRecipe } from "./verify-claims.js";

const registry = new Map<string, Recipe>([
  [rankCandidatesRecipe.id, rankCandidatesRecipe],
  [verifyClaimsRecipe.id, verifyClaimsRecipe],
  [triageFailureRecipe.id, triageFailureRecipe],
]);

export function listRecipes(): Array<Pick<Recipe, "id" | "version" | "description">> {
  return [...registry.values()].map(({ id, version, description }) => ({ id, version, description }));
}

export function getRecipe(id: string): Recipe {
  const recipe = registry.get(id);
  if (!recipe) throw new JevError("INVALID_INPUT", "Unknown recipe; run jev recipes to inspect available recipe ids.");
  return recipe;
}
