import { DEFAULT_CONFIG } from "./config.ts";
import { ITEM_CAPS, RECIPES, findSuppliersForItem } from "./economy.ts";
import { hasAffordableFoodSource } from "./gating.ts";
import { getTopBonds, getTopRumor } from "./gossip.ts";
import type { ChoiceQuestion, Entity, Focus, ItemKind, Rumor, WorldState } from "./types.ts";
import { formatSimTime, getEntityById, getStock } from "./world.ts";

export const DAWN_FOCUS_CRITERIA: Record<Focus, string> = {
  duty: "trade and village work",
  earn: "produce and earn gold",
  socialize: "talk with neighbors",
  rest: "rest and keep energy up",
};

const SHARED_STOCK_ITEMS: readonly ItemKind[] = ["wheat", "bread", "stew", "wood"];

function formatInventory(inventory: Partial<Record<ItemKind, number>>): string {
  const entries = (Object.entries(inventory) as Array<[ItemKind, number]>)
    .filter(([, qty]) => qty > 0)
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (entries.length === 0) return "none";
  return entries.map(([item, qty]) => `${qty} ${item}`).join(", ");
}

function availableStock(world: WorldState, item: ItemKind): number {
  return findSuppliersForItem(world, item, "", 1).reduce((sum, e) => sum + getStock(e, item), 0);
}

/**
 * Shared world summary placed in the `state` field of a batched System One call.
 * Kept concise (~20-30 tokens) so a 4B model stays well within its <=384-token sweet spot.
 */
export function serializeWorldState(world: WorldState): string {
  const time = formatSimTime(world.tick, world.minutesPerTick, world.startHour);
  const stocks = SHARED_STOCK_ITEMS.map((item) => `${item} ${availableStock(world, item)}`);

  return (
    `Day ${world.day} ${time}, weather ${world.weather}, prosperity ${world.prosperity}. ` +
    `Stocks: ${stocks.join(", ")}.`
  );
}

function contradictsStock(world: WorldState, rumor: Rumor): boolean {
  if (rumor.kind !== "surplus" && rumor.kind !== "shortage") return false;

  // Item-specific stock rumors use <kind>:<day>:<subject>:<item>. The summary
  // pattern also supports older or manually supplied rumors with custom IDs.
  const [kind, , subjectId, idItem] = rumor.id.split(":");
  const itemFromId = kind === rumor.kind && subjectId === rumor.subjectId ? idItem : undefined;
  const subject = getEntityById(world, rumor.subjectId);
  if (rumor.kind === "shortage" && itemFromId === "food") {
    return subject !== undefined && hasAffordableFoodSource(world, subject);
  }
  const itemFromSummary =
    rumor.kind === "surplus"
      ? / has surplus ([a-z]+)\.?$/i.exec(rumor.summary)?.[1]
      : / is short on ([a-z]+)\.?$/i.exec(rumor.summary)?.[1];
  const candidate = itemFromId ?? itemFromSummary?.toLowerCase();
  if (!candidate || !Object.hasOwn(ITEM_CAPS, candidate)) return false;

  const item = candidate as ItemKind;
  if (rumor.kind === "surplus") {
    return (
      (subject !== undefined && getStock(subject, item) === 0) ||
      (SHARED_STOCK_ITEMS.includes(item) && availableStock(world, item) === 0)
    );
  }
  // Stock elsewhere in town does not contradict a villager's own shortage.
  return (
    subject !== undefined && getStock(subject, item) >= (RECIPES[subject.role]?.inputs[item] ?? 1)
  );
}

function rumorInstructions(
  world: WorldState,
  entity: Entity,
  maxAgeDays: number,
  render: (memory: readonly string[], hint: string) => string,
): Pick<ChoiceQuestion, "instructions" | "scriptedInstructions"> {
  const recent = entity.memory.filter((entry) => !entry.startsWith("heard from "));
  const rumor = getTopRumor(
    entity,
    (candidate) =>
      candidate.originDay <= world.day &&
      world.day - candidate.originDay <= maxAgeDays &&
      !contradictsStock(world, candidate),
  );
  const modelHint = rumor
    ? ` Unverified rumor (day ${rumor.originDay}, ${rumor.hops} ${rumor.hops === 1 ? "hop" : "hops"}): ${rumor.summary}.`
    : "";
  const legacyRumor = getTopRumor(entity);

  return {
    instructions: render(recent, modelHint),
    scriptedInstructions: render(
      entity.memory,
      legacyRumor ? ` Heard: ${legacyRumor.summary}.` : "",
    ),
  };
}

function formatRecent(memory: readonly string[], fallback: string): string {
  return memory.length > 0 ? memory.slice(-2).join("; ") : fallback;
}

/**
 * Primary artifact of the project (§6.3, §7.4):
 * Compact ~55-90 token entity instruction string containing every fact needed
 * for a stateless typed-decision provider without duplicating shared world state
 * or leaking peer confidences.
 */
function entityInstructions(world: WorldState, entity: Entity, rumorMaxAgeDays: number) {
  const carrying = formatInventory(entity.inventory);

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

  const prefix =
    `${entity.name.toLowerCase()} the ${entity.role} at ${entity.location}. ` +
    `Gold ${entity.gold}g, carrying ${carrying}.${supplyHint} ` +
    `Hunger ${entity.needs.hunger.toFixed(2)}, energy ${entity.needs.energy.toFixed(2)}, ` +
    `social ${entity.needs.social.toFixed(2)}, meals ${entity.mealsToday}. ` +
    `Duty: ${entity.duty}. Focus: ${entity.focus}. `;
  return rumorInstructions(
    world,
    entity,
    rumorMaxAgeDays,
    (memory, hint) =>
      `${prefix}Recent: ${formatRecent(memory, "quiet morning")}.${bondHint}${hint}`,
  );
}

export function serializeEntityInstruction(
  world: WorldState,
  entity: Entity,
  rumorMaxAgeDays = DEFAULT_CONFIG.rumorMaxAgeDays,
): string {
  return entityInstructions(world, entity, rumorMaxAgeDays).instructions;
}

export function buildTickQuestion(
  world: WorldState,
  entity: Entity,
  criteria: Record<string, string>,
  rumorMaxAgeDays = DEFAULT_CONFIG.rumorMaxAgeDays,
): ChoiceQuestion {
  return {
    type: "choice",
    ...entityInstructions(world, entity, rumorMaxAgeDays),
    criteria,
  };
}

export function buildDawnQuestion(
  world: WorldState,
  entity: Entity,
  rumorMaxAgeDays = DEFAULT_CONFIG.rumorMaxAgeDays,
): ChoiceQuestion {
  const carrying = formatInventory(entity.inventory);
  const prefix =
    `Dawn: ${entity.name.toLowerCase()} the ${entity.role} at ${entity.home}. ` +
    `Gold ${entity.gold}g, carrying ${carrying}. ` +
    `Energy ${entity.needs.energy.toFixed(2)}, social ${entity.needs.social.toFixed(2)}. ` +
    `Duty: ${entity.duty}. `;
  return {
    type: "choice",
    ...rumorInstructions(
      world,
      entity,
      rumorMaxAgeDays,
      (memory, hint) =>
        `${prefix}Recent: ${formatRecent(memory, "fresh dawn")}.${hint} Pick focus.`,
    ),
    criteria: { ...DAWN_FOCUS_CRITERIA },
  };
}
