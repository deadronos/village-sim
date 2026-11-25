import { RECIPES, findSuppliersForItem } from "./economy.ts";
import type { ChoiceQuestion, Entity, Focus, ItemKind, WorldState } from "./types.ts";
import { formatSimTime, getStock } from "./world.ts";

export const DAWN_FOCUS_CRITERIA: Record<Focus, string> = {
  duty: "prioritize trade and village work",
  earn: "focus on production and earning gold",
  socialize: "spend time talking with neighbors",
  rest: "take it easy and keep energy high",
};

function formatInventory(inventory: Partial<Record<ItemKind, number>>): string {
  const entries = (Object.entries(inventory) as Array<[ItemKind, number]>)
    .filter(([, qty]) => qty > 0)
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (entries.length === 0) return "nothing";
  return entries.map(([item, qty]) => `${qty} ${item}`).join(", ");
}

/**
 * Shared world summary placed in the `state` field of a batched System One call.
 * Kept concise (~45-70 tokens) so a 4B model stays well within its <=384-token sweet spot.
 */
export function serializeWorldState(world: WorldState): string {
  const time = formatSimTime(world.tick, world.minutesPerTick, world.startHour);
  const breadSupply = findSuppliersForItem(world, "bread", "", 1).reduce(
    (sum, e) => sum + getStock(e, "bread"),
    0,
  );
  const stewSupply = findSuppliersForItem(world, "stew", "", 1).reduce(
    (sum, e) => sum + getStock(e, "stew"),
    0,
  );
  const wheatSupply = findSuppliersForItem(world, "wheat", "", 1).reduce(
    (sum, e) => sum + getStock(e, "wheat"),
    0,
  );
  const woodSupply = findSuppliersForItem(world, "wood", "", 1).reduce(
    (sum, e) => sum + getStock(e, "wood"),
    0,
  );

  return (
    `Day ${world.day}, ${time}, weather ${world.weather}. ` +
    `Village stocks: wheat ${wheatSupply}, bread ${breadSupply}, stew ${stewSupply}, wood ${woodSupply}. ` +
    `Places: well, market, bakery, tavern, smithy, fields, woods, garden.`
  );
}

/**
 * Primary artifact of the project (§6.3, §7.4):
 * Compact ~60-120 token entity instruction string containing every fact needed
 * for a stateless typed-decision provider without leaking peer confidences.
 */
export function serializeEntityInstruction(world: WorldState, entity: Entity): string {
  const time = formatSimTime(world.tick, world.minutesPerTick, world.startHour);
  const carrying = formatInventory(entity.inventory);
  const recent = entity.memory.length > 0 ? entity.memory.join("; ") : "quiet morning";

  const recipe = RECIPES[entity.role];
  let supplyHint = "";
  if (recipe && Object.keys(recipe.inputs).length > 0) {
    const missing = (Object.entries(recipe.inputs) as Array<[ItemKind, number]>)
      .filter(([item, qty]) => getStock(entity, item) < qty)
      .map(([item]) => item);
    if (missing.length > 0) {
      supplyHint = ` Missing for work: ${missing.join(", ")}.`;
    }
  }

  return (
    `${entity.name.toLowerCase()} the ${entity.role}, at ${entity.location}. ` +
    `Gold ${entity.gold}g, carrying ${carrying}.${supplyHint} ` +
    `Hunger ${entity.needs.hunger.toFixed(2)}, energy ${entity.needs.energy.toFixed(2)}, ` +
    `social ${entity.needs.social.toFixed(2)}. ` +
    `Meals today: ${entity.mealsToday}. ` +
    `The village relies on ${entity.name.toLowerCase()} to ${entity.duty}. ` +
    `Today's focus: ${entity.focus}. ` +
    `Recent: ${recent}. ` +
    `It is ${time}, weather ${world.weather}.`
  );
}

export function buildTickQuestion(
  world: WorldState,
  entity: Entity,
  criteria: Record<string, string>,
): ChoiceQuestion {
  return {
    type: "choice",
    instructions: serializeEntityInstruction(world, entity),
    criteria,
  };
}

export function buildDawnQuestion(world: WorldState, entity: Entity): ChoiceQuestion {
  const carrying = formatInventory(entity.inventory);
  const recent = entity.memory.length > 0 ? entity.memory.join("; ") : "fresh dawn";
  return {
    type: "choice",
    instructions:
      `Dawn of Day ${world.day} (${world.weather}). ` +
      `${entity.name.toLowerCase()} the ${entity.role} wakes at ${entity.home}. ` +
      `Gold ${entity.gold}g, carrying ${carrying}. ` +
      `Energy ${entity.needs.energy.toFixed(2)}, social ${entity.needs.social.toFixed(2)}. ` +
      `Duty: ${entity.duty}. Recent: ${recent}. Choose today's focus.`,
    criteria: { ...DAWN_FOCUS_CRITERIA },
  };
}
