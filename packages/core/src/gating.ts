import {
  ITEM_CAPS,
  ITEM_PRICES,
  RECIPES,
  findSuppliersForItem,
  getMissingInputs,
  hasRecipeInputs,
} from "./economy.ts";
import type { ActionKind, Entity, ItemKind, WorldState } from "./types.ts";
import { getStock } from "./world.ts";

export interface RestockOption {
  item: ItemKind;
  targetPlace: string;
  sellerId?: string;
}

export interface GatingRule {
  action: ActionKind;
  describe: (entity: Entity) => string;
  isAllowed: (world: WorldState, entity: Entity) => boolean;
}

export function findRestockOption(world: WorldState, entity: Entity): RestockOption | null {
  const recipe = RECIPES[entity.role];
  if (!recipe) return null;

  const missing = getMissingInputs(entity, recipe);
  if (missing.length === 0) return null;

  for (const item of missing) {
    if (getStock(entity, item) >= ITEM_CAPS[item]) continue;
    if (item === "water") {
      return { item: "water", targetPlace: "well" };
    }
    const price = ITEM_PRICES[item];
    if (entity.gold < price) continue;
    const suppliers = findSuppliersForItem(world, item, entity.id, 1);
    if (suppliers.length > 0) {
      const seller = suppliers[0]!;
      return { item, targetPlace: seller.workplace, sellerId: seller.id };
    }
  }

  return null;
}

export function hasAffordableFoodSource(world: WorldState, entity: Entity): boolean {
  if (getStock(entity, "bread") > 0 || getStock(entity, "stew") > 0) return true;
  if (
    entity.gold >= ITEM_PRICES.bread &&
    findSuppliersForItem(world, "bread", entity.id, 1).length > 0
  ) {
    return true;
  }
  if (
    entity.gold >= ITEM_PRICES.stew &&
    findSuppliersForItem(world, "stew", entity.id, 1).length > 0
  ) {
    return true;
  }
  return false;
}

export function findSocialPartner(world: WorldState, entity: Entity): Entity | null {
  // Prefer someone not resting at home, weighted by friendship & weather-appropriate hubs
  const candidates = world.entities.filter(
    (other) => other.id !== entity.id && other.goal?.kind !== "rest",
  );
  if (candidates.length === 0) return null;

  const preferredHubs =
    world.weather === "rain"
      ? new Set(["tavern", "bakery"])
      : new Set(["tavern", "well", "market"]);

  const ranked = candidates.toSorted((a, b) => {
    const scoreA = (entity.affinity[a.id] ?? 0.5) + (preferredHubs.has(a.location) ? 0.18 : 0);
    const scoreB = (entity.affinity[b.id] ?? 0.5) + (preferredHubs.has(b.location) ? 0.18 : 0);
    if (scoreB !== scoreA) return scoreB - scoreA;
    return a.id < b.id ? -1 : 1;
  });

  return ranked[0] ?? null;
}

/**
 * Data-driven gating table from IDEA.md §7.2.
 * Never offers actions whose prerequisites are absent.
 */
export const GATING_RULES: readonly GatingRule[] = [
  {
    action: "work",
    describe: (entity) => RECIPES[entity.role]?.label ?? entity.duty,
    isAllowed: (_world, entity) => {
      const recipe = RECIPES[entity.role];
      if (!recipe) return false;
      if (!hasRecipeInputs(entity, recipe)) return false;
      return getStock(entity, recipe.output) < ITEM_CAPS[recipe.output];
    },
  },
  {
    action: "restock",
    describe: (entity) => {
      const recipe = RECIPES[entity.role];
      if (!recipe) return "get supplies";
      const missing = getMissingInputs(entity, recipe);
      return missing.length > 0 ? `get ${missing[0]}` : "get supplies";
    },
    isAllowed: (world, entity) => findRestockOption(world, entity) !== null,
  },
  {
    action: "buy_food",
    describe: (_entity) => "eat",
    isAllowed: (world, entity) => {
      const carryingFood = getStock(entity, "bread") > 0 || getStock(entity, "stew") > 0;
      const wantsFood = entity.needs.hunger > 0.4 || carryingFood;
      if (!wantsFood) return false;
      return hasAffordableFoodSource(world, entity);
    },
  },
  {
    action: "rest",
    describe: (_entity) => "rest",
    isAllowed: (_world, entity) => entity.needs.energy < 0.45,
  },
  {
    action: "socialize",
    describe: (_entity) => "talk",
    isAllowed: (world, entity) =>
      entity.needs.social < 0.75 && findSocialPartner(world, entity) !== null,
  },
  {
    action: "patrol",
    describe: (_entity) => "patrol",
    isAllowed: (_world, entity) => entity.role === "guard",
  },
];

/**
 * Computes the gated option map (action -> human description) for an entity.
 * Override: hunger > 0.8 offers ONLY buy_food.
 * Fallback: child always gets wander, and any entity with no other options gets wander.
 */
export function getGatedActions(world: WorldState, entity: Entity): Record<string, string> {
  // Hard survival override (§7.2 & A6)
  if (entity.needs.hunger > 0.8) {
    return { buy_food: "eat urgently" };
  }

  const criteria: Record<string, string> = {};
  for (const rule of GATING_RULES) {
    if (rule.isAllowed(world, entity)) {
      criteria[rule.action] = rule.describe(entity);
    }
  }

  if (entity.role === "child" || Object.keys(criteria).length === 0) {
    criteria.wander = "wander";
  }

  return criteria;
}
