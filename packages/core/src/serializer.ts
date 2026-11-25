import { RECIPES, findSuppliersForItem } from "./economy.ts";
import { getTopBonds, getTopRumor } from "./gossip.ts";
import type { ChoiceQuestion, Entity, Focus, ItemKind, WorldState } from "./types.ts";
import { formatSimTime, getStock } from "./world.ts";

export const DAWN_FOCUS_CRITERIA: Record<Focus, string> = {
  duty: "trade and village work",
  earn: "produce and earn gold",
  socialize: "talk with neighbors",
  rest: "rest and keep energy up",
};

function formatInventory(inventory: Partial<Record<ItemKind, number>>): string {
  const entries = (Object.entries(inventory) as Array<[ItemKind, number]>)
    .filter(([, qty]) => qty > 0)
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (entries.length === 0) return "none";
  return entries.map(([item, qty]) => `${qty} ${item}`).join(", ");
}

/**
 * Shared world summary placed in the `state` field of a batched System One call.
 * Kept concise (~20-30 tokens) so a 4B model stays well within its <=384-token sweet spot.
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
    `Day ${world.day} ${time}, weather ${world.weather}, prosperity ${world.prosperity}. ` +
    `Stocks: wheat ${wheatSupply}, bread ${breadSupply}, stew ${stewSupply}, wood ${woodSupply}.`
  );
}

/**
 * Primary artifact of the project (§6.3, §7.4):
 * Compact ~55-90 token entity instruction string containing every fact needed
 * for a stateless typed-decision provider without duplicating shared world state
 * or leaking peer confidences.
 */
export function serializeEntityInstruction(world: WorldState, entity: Entity): string {
  const carrying = formatInventory(entity.inventory);
  const recent = entity.memory.length > 0 ? entity.memory.slice(-2).join("; ") : "quiet morning";

  const recipe = RECIPES[entity.role];
  let supplyHint = "";
  if (recipe && Object.keys(recipe.inputs).length > 0) {
    const missing = (Object.entries(recipe.inputs) as Array<[ItemKind, number]>)
      .filter(([item, qty]) => getStock(entity, item) < qty)
      .map(([item]) => item);
    if (missing.length > 0) {
      supplyHint = ` Needs: ${missing.join(", ")}.`;
    }
  }

  const topBond = getTopBonds(world, entity, 1)[0];
  const bondHint =
    topBond && (topBond.tier === "warm" || topBond.tier === "close")
      ? ` Closest: ${topBond.entity.name.toLowerCase()} (${topBond.tier}).`
      : "";

  const topRumor = getTopRumor(entity);
  const rumorHint = topRumor ? ` Heard: ${topRumor.summary}.` : "";

  return (
    `${entity.name.toLowerCase()} the ${entity.role} at ${entity.location}. ` +
    `Gold ${entity.gold}g, carrying ${carrying}.${supplyHint} ` +
    `Hunger ${entity.needs.hunger.toFixed(2)}, energy ${entity.needs.energy.toFixed(2)}, ` +
    `social ${entity.needs.social.toFixed(2)}, meals ${entity.mealsToday}. ` +
    `Duty: ${entity.duty}. Focus: ${entity.focus}. ` +
    `Recent: ${recent}.${bondHint}${rumorHint}`
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
  const recent = entity.memory.length > 0 ? entity.memory.slice(-2).join("; ") : "fresh dawn";
  const topRumor = getTopRumor(entity);
  const rumorHint = topRumor ? ` Heard: ${topRumor.summary}.` : "";
  return {
    type: "choice",
    instructions:
      `Dawn: ${entity.name.toLowerCase()} the ${entity.role} at ${entity.home}. ` +
      `Gold ${entity.gold}g, carrying ${carrying}. ` +
      `Energy ${entity.needs.energy.toFixed(2)}, social ${entity.needs.social.toFixed(2)}. ` +
      `Duty: ${entity.duty}. Recent: ${recent}.${rumorHint} Pick focus.`,
    criteria: { ...DAWN_FOCUS_CRITERIA },
  };
}
