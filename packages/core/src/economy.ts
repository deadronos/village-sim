import { isValidPlace } from "./places.ts";
import type { Entity, ItemKind, Role, SimEvent, WorldState } from "./types.ts";
import { addStock, clamp01, formatSimTime, getStock, pushMemory } from "./world.ts";

export interface Recipe {
  role: Role;
  workplace: string;
  inputs: Partial<Record<ItemKind, number>>;
  output: ItemKind;
  outputQty: number;
  label: string;
}

export const RECIPES: Partial<Record<Role, Recipe>> = {
  farmer: {
    role: "farmer",
    workplace: "fields",
    inputs: { tool: 1 },
    output: "wheat",
    outputQty: 3,
    label: "harvest wheat",
  },
  baker: {
    role: "baker",
    workplace: "bakery",
    inputs: { wheat: 1, water: 1 },
    output: "bread",
    outputQty: 2,
    label: "bake bread",
  },
  innkeeper: {
    role: "innkeeper",
    workplace: "tavern",
    inputs: { bread: 1, water: 1 },
    output: "stew",
    outputQty: 1,
    label: "cook stew",
  },
  woodcutter: {
    role: "woodcutter",
    workplace: "woods",
    inputs: {},
    output: "wood",
    outputQty: 2,
    label: "chop wood",
  },
  smith: {
    role: "smith",
    workplace: "smithy",
    inputs: { wood: 1 },
    output: "tool",
    outputQty: 1,
    label: "forge tools",
  },
  herbalist: {
    role: "herbalist",
    workplace: "garden",
    inputs: {},
    output: "herbs",
    outputQty: 2,
    label: "gather herbs",
  },
};

export const ITEM_PRICES: Record<ItemKind, number> = {
  wheat: 5,
  water: 0,
  bread: 4,
  stew: 7,
  wood: 3,
  tool: 8,
  herbs: 5,
};

export const ITEM_CAPS: Record<ItemKind, number> = {
  wheat: 8,
  water: 6,
  bread: 8,
  stew: 6,
  wood: 8,
  tool: 6,
  herbs: 6,
};

export const NEED_DECAY = {
  hunger: 0.0175,
  energy: -0.016,
  social: -0.014,
} as const;

export function decayNeeds(entity: Entity): void {
  entity.needs.hunger = clamp01(entity.needs.hunger + NEED_DECAY.hunger);
  entity.needs.energy = clamp01(entity.needs.energy + NEED_DECAY.energy);
  entity.needs.social = clamp01(entity.needs.social + NEED_DECAY.social);
}

export function hasRecipeInputs(entity: Entity, recipe: Recipe): boolean {
  for (const [item, qty] of Object.entries(recipe.inputs) as Array<[ItemKind, number]>) {
    if (getStock(entity, item) < qty) return false;
  }
  return true;
}

export function getMissingInputs(entity: Entity, recipe: Recipe): ItemKind[] {
  const missing: ItemKind[] = [];
  for (const [item, qty] of Object.entries(recipe.inputs) as Array<[ItemKind, number]>) {
    if (getStock(entity, item) < qty) {
      missing.push(item);
    }
  }
  return missing;
}

export function findSuppliersForItem(
  world: WorldState,
  item: ItemKind,
  buyerId: string,
  minQty = 1,
): Entity[] {
  return world.entities.filter((seller) => {
    if (seller.id === buyerId) return false;
    // Only trade producers/merchants sell their goods
    const recipe = RECIPES[seller.role];
    if (!recipe || recipe.output !== item) return false;
    return getStock(seller, item) >= minQty;
  });
}

export interface TradeResult {
  ok: boolean;
  reason?: string;
  event?: SimEvent;
}

/**
 * Execute a deterministic person-to-person trade. Buyer must be at seller's
 * workplace, have enough gold, seller must have stock, and buyer must be under cap.
 */
export function executeTrade(
  world: WorldState,
  buyer: Entity,
  seller: Entity,
  item: ItemKind,
  qty = 1,
): TradeResult {
  if (qty <= 0) return { ok: false, reason: "invalid_qty" };
  if (buyer.id === seller.id) return { ok: false, reason: "self_trade" };
  if (buyer.location !== seller.workplace) {
    return { ok: false, reason: "wrong_location" };
  }

  const available = getStock(seller, item);
  if (available < qty) {
    return { ok: false, reason: "out_of_stock" };
  }

  const cap = ITEM_CAPS[item];
  if (getStock(buyer, item) + qty > cap) {
    return { ok: false, reason: "cap_reached" };
  }

  const totalPrice = ITEM_PRICES[item] * qty;
  if (buyer.gold < totalPrice) {
    return { ok: false, reason: "insufficient_gold" };
  }

  buyer.gold -= totalPrice;
  seller.gold += totalPrice;
  addStock(seller, item, -qty);
  addStock(buyer, item, qty);

  buyer.tradesToday += 1;
  seller.tradesToday += 1;
  world.tradesToday += 1;
  world.tradesTotal += 1;

  const qtyText = qty > 1 ? `${qty} ${item}` : item;
  pushMemory(buyer, `bought ${qtyText} from ${seller.name.toLowerCase()} for ${totalPrice}g`);
  pushMemory(seller, `sold ${qtyText} to ${buyer.name.toLowerCase()} for ${totalPrice}g`);

  // Mild mutual affinity bump from trade
  buyer.affinity[seller.id] = clamp01((buyer.affinity[seller.id] ?? 0.5) + 0.02);
  seller.affinity[buyer.id] = clamp01((seller.affinity[buyer.id] ?? 0.5) + 0.02);

  const time = formatSimTime(world.tick, world.minutesPerTick, world.startHour);
  return {
    ok: true,
    event: {
      day: world.day,
      tick: world.tick,
      time,
      kind: "trade",
      entityId: buyer.id,
      otherEntityId: seller.id,
      place: seller.workplace,
      item,
      qty,
      gold: totalPrice,
      message: `${time} ${buyer.name.toLowerCase()} buys ${qtyText} from ${seller.name.toLowerCase()} for ${totalPrice}g`,
    },
  };
}

export interface ProduceResult {
  ok: boolean;
  producedQty: number;
  reason?: string;
  event?: SimEvent;
}

/**
 * Deterministic recipe execution at the entity's workplace. Enforces input
 * availability and per-item stock caps.
 */
export function executeRecipe(world: WorldState, entity: Entity): ProduceResult {
  const recipe = RECIPES[entity.role];
  if (!recipe) return { ok: false, producedQty: 0, reason: "no_recipe" };
  if (entity.location !== recipe.workplace) {
    return { ok: false, producedQty: 0, reason: "wrong_location" };
  }
  if (!hasRecipeInputs(entity, recipe)) {
    return { ok: false, producedQty: 0, reason: "missing_inputs" };
  }

  const currentOut = getStock(entity, recipe.output);
  const cap = ITEM_CAPS[recipe.output];
  const headroom = cap - currentOut;
  if (headroom <= 0) {
    return { ok: false, producedQty: 0, reason: "cap_reached" };
  }

  for (const [input, qty] of Object.entries(recipe.inputs) as Array<[ItemKind, number]>) {
    addStock(entity, input, -qty);
  }

  const produced = Math.min(recipe.outputQty, headroom);
  addStock(entity, recipe.output, produced);
  entity.needs.energy = clamp01(entity.needs.energy - 0.05);

  if (recipe.output === "bread") {
    world.breadProducedToday += produced;
  } else if (recipe.output === "stew") {
    world.stewProducedToday += produced;
  }

  pushMemory(entity, `produced ${produced} ${recipe.output}`);
  const time = formatSimTime(world.tick, world.minutesPerTick, world.startHour);
  return {
    ok: true,
    producedQty: produced,
    event: {
      day: world.day,
      tick: world.tick,
      time,
      kind: "produce",
      entityId: entity.id,
      place: entity.location,
      item: recipe.output,
      qty: produced,
      message: `${time} ${entity.name.toLowerCase()} produces ${produced} ${recipe.output} at ${entity.location}`,
    },
  };
}

export function drawWaterFromWell(world: WorldState, entity: Entity): SimEvent | null {
  if (entity.location !== "well") return null;
  const current = getStock(entity, "water");
  const cap = ITEM_CAPS.water;
  const draw = Math.min(2, cap - current);
  if (draw <= 0) return null;

  addStock(entity, "water", draw);
  pushMemory(entity, `drew ${draw} water at well`);
  const time = formatSimTime(world.tick, world.minutesPerTick, world.startHour);
  return {
    day: world.day,
    tick: world.tick,
    time,
    kind: "produce",
    entityId: entity.id,
    place: "well",
    item: "water",
    qty: draw,
    message: `${time} ${entity.name.toLowerCase()} draws ${draw} water at well`,
  };
}

export function consumeCarriedMeal(world: WorldState, entity: Entity): SimEvent | null {
  const time = formatSimTime(world.tick, world.minutesPerTick, world.startHour);
  if (getStock(entity, "stew") > 0) {
    addStock(entity, "stew", -1);
    entity.needs.hunger = clamp01(entity.needs.hunger - 0.52);
    entity.needs.energy = clamp01(entity.needs.energy + 0.12);
    entity.needs.social = clamp01(entity.needs.social + 0.06);
    entity.mealsToday += 1;
    world.mealsToday += 1;
    pushMemory(entity, "ate hearty stew");
    return {
      day: world.day,
      tick: world.tick,
      time,
      kind: "eat",
      entityId: entity.id,
      place: entity.location,
      item: "stew",
      qty: 1,
      message: `${time} ${entity.name.toLowerCase()} eats stew at ${entity.location}`,
    };
  }
  if (getStock(entity, "bread") > 0) {
    addStock(entity, "bread", -1);
    entity.needs.hunger = clamp01(entity.needs.hunger - 0.44);
    entity.needs.energy = clamp01(entity.needs.energy + 0.06);
    entity.mealsToday += 1;
    world.mealsToday += 1;
    pushMemory(entity, "ate fresh bread");
    return {
      day: world.day,
      tick: world.tick,
      time,
      kind: "eat",
      entityId: entity.id,
      place: entity.location,
      item: "bread",
      qty: 1,
      message: `${time} ${entity.name.toLowerCase()} eats bread at ${entity.location}`,
    };
  }
  return null;
}

/**
 * Scheduled wages, allowances, and institutional demand at noon (12:00) and
 * evening (18:00). Keeps secondary trades alive and prevents gold droughts.
 */
export function runScheduledEconomyEvents(world: WorldState): SimEvent[] {
  const events: SimEvent[] = [];
  const totalMinutes = world.startHour * 60 + world.tick * world.minutesPerTick;
  const isNoon = totalMinutes === 12 * 60;
  const isEvening = totalMinutes === 18 * 60;
  if (!isNoon && !isEvening) return events;

  const time = formatSimTime(world.tick, world.minutesPerTick, world.startHour);

  for (const entity of world.entities) {
    if (entity.role === "guard") {
      const wage = 8;
      entity.gold += wage;
      world.totalGoldMinted += wage;
      pushMemory(entity, `received ${wage}g guard wage`);
      events.push({
        day: world.day,
        tick: world.tick,
        time,
        kind: "wage",
        entityId: entity.id,
        gold: wage,
        message: `${time} ${entity.name.toLowerCase()} receives ${wage}g guard wage`,
      });
    } else if (entity.role === "child") {
      const allowance = 6;
      entity.gold += allowance;
      world.totalGoldMinted += allowance;
      pushMemory(entity, `received ${allowance}g allowance`);
      events.push({
        day: world.day,
        tick: world.tick,
        time,
        kind: "wage",
        entityId: entity.id,
        gold: allowance,
        message: `${time} ${entity.name.toLowerCase()} receives ${allowance}g allowance`,
      });
    } else if (entity.role === "smith" && getStock(entity, "tool") >= 4) {
      const qty = 1;
      const pay = qty * ITEM_PRICES.tool;
      addStock(entity, "tool", -qty);
      entity.gold += pay;
      world.totalGoldMinted += pay;
      pushMemory(entity, `town bought ${qty} surplus tool for ${pay}g`);
      events.push({
        day: world.day,
        tick: world.tick,
        time,
        kind: "demand",
        entityId: entity.id,
        item: "tool",
        qty,
        gold: pay,
        message: `${time} town guild buys ${qty} surplus tool from ${entity.name.toLowerCase()} for ${pay}g`,
      });
    } else if (entity.role === "herbalist") {
      const qty = Math.min(2, getStock(entity, "herbs"));
      if (qty > 0) {
        const pay = qty * ITEM_PRICES.herbs;
        addStock(entity, "herbs", -qty);
        entity.gold += pay;
        world.totalGoldMinted += pay;
        pushMemory(entity, `town bought ${qty} herbs for ${pay}g`);
        events.push({
          day: world.day,
          tick: world.tick,
          time,
          kind: "demand",
          entityId: entity.id,
          item: "herbs",
          qty,
          gold: pay,
          message: `${time} town apothecary buys ${qty} herbs from ${entity.name.toLowerCase()} for ${pay}g`,
        });
      }
    } else if (entity.role === "woodcutter" && getStock(entity, "wood") >= 6) {
      const pay = ITEM_PRICES.wood;
      addStock(entity, "wood", -1);
      entity.gold += pay;
      world.totalGoldMinted += pay;
      pushMemory(entity, `town bought surplus wood for ${pay}g`);
      events.push({
        day: world.day,
        tick: world.tick,
        time,
        kind: "demand",
        entityId: entity.id,
        item: "wood",
        qty: 1,
        gold: pay,
        message: `${time} town mill buys surplus wood from ${entity.name.toLowerCase()} for ${pay}g`,
      });
    } else if (
      entity.role === "innkeeper" &&
      isEvening &&
      getStock(entity, "stew") >= 5 &&
      entity.gold < 12
    ) {
      const pay = ITEM_PRICES.stew;
      addStock(entity, "stew", -1);
      entity.gold += pay;
      world.totalGoldMinted += pay;
      pushMemory(entity, `traveler bought stew for ${pay}g`);
      events.push({
        day: world.day,
        tick: world.tick,
        time,
        kind: "demand",
        entityId: entity.id,
        item: "stew",
        qty: 1,
        gold: pay,
        message: `${time} passing traveler buys stew from ${entity.name.toLowerCase()} for ${pay}g`,
      });
    }
  }

  return events;
}

export interface WealthMetrics {
  gini: number;
  maxMinRatio: number;
  minGold: number;
  maxGold: number;
  totalGold: number;
}

/**
 * Compute wealth distribution metrics (Gini coefficient in [0, 1] and max/min ratio)
 * across villager gold balances.
 */
export function computeWealthMetrics(golds: readonly number[]): WealthMetrics {
  if (golds.length === 0) {
    return { gini: 0, maxMinRatio: 1, minGold: 0, maxGold: 0, totalGold: 0 };
  }
  const sorted = golds.toSorted((a, b) => a - b);
  const n = sorted.length;
  const minGold = sorted[0]!;
  const maxGold = sorted[n - 1]!;
  const totalGold = sorted.reduce((sum, g) => sum + g, 0);

  let gini = 0;
  if (totalGold > 0 && n > 1) {
    let weightedSum = 0;
    for (let i = 0; i < n; i++) {
      weightedSum += (2 * (i + 1) - n - 1) * sorted[i]!;
    }
    gini = weightedSum / (n * totalGold);
  }

  const maxMinRatio = maxGold === 0 ? 1 : maxGold / Math.max(1, minGold);
  return {
    gini: Math.round(Math.max(0, Math.min(1, gini)) * 1000) / 1000,
    maxMinRatio: Math.round(maxMinRatio * 100) / 100,
    minGold,
    maxGold,
    totalGold,
  };
}

/**
 * Deadlock relief: if a starving entity cannot afford bread or no food seller
 * has stock after two failed attempts, issue a tracked relief stipend or pantry ration.
 */
export function applyDeadlockRelief(world: WorldState, entity: Entity): SimEvent | null {
  const key = entity.id;
  const count = (world.deadlockCounter[key] ?? 0) + 1;
  world.deadlockCounter[key] = count;
  const time = formatSimTime(world.tick, world.minutesPerTick, world.startHour);

  if (entity.gold < ITEM_PRICES.bread && count >= 1) {
    const relief = ITEM_PRICES.bread;
    entity.gold += relief;
    world.totalGoldMinted += relief;
    pushMemory(entity, `received ${relief}g village credit`);
    return {
      day: world.day,
      tick: world.tick,
      time,
      kind: "deadlock",
      entityId: entity.id,
      gold: relief,
      message: `${time} village chest extends ${relief}g credit to ${entity.name.toLowerCase()}`,
    };
  }

  if (count >= 2 && entity.needs.hunger > 0.8) {
    world.deadlockCounter[key] = 0;
    entity.needs.hunger = clamp01(entity.needs.hunger - 0.42);
    entity.mealsToday += 1;
    world.mealsToday += 1;
    pushMemory(entity, "ate emergency pantry ration");
    return {
      day: world.day,
      tick: world.tick,
      time,
      kind: "deadlock",
      entityId: entity.id,
      place: entity.location,
      message: `${time} ${entity.name.toLowerCase()} takes an emergency pantry ration`,
    };
  }

  return null;
}

/**
 * Assert all deterministic world invariants every single tick.
 */
export function assertWorldInvariants(world: WorldState): void {
  let totalGold = 0;
  for (const entity of world.entities) {
    if (!Number.isFinite(entity.gold) || entity.gold < 0) {
      throw new Error(`Invariant violated: negative gold for ${entity.id} (${entity.gold})`);
    }
    totalGold += entity.gold;

    if (!isValidPlace(entity.location)) {
      throw new Error(`Invariant violated: invalid location for ${entity.id} (${entity.location})`);
    }

    for (const [item, qty] of Object.entries(entity.inventory) as Array<[ItemKind, number]>) {
      if (!Number.isFinite(qty) || qty < 0) {
        throw new Error(`Invariant violated: negative stock ${item}=${qty} for ${entity.id}`);
      }
      if (qty > ITEM_CAPS[item]) {
        throw new Error(
          `Invariant violated: stock cap exceeded ${item}=${qty} > ${ITEM_CAPS[item]} for ${entity.id}`,
        );
      }
    }

    if (
      entity.needs.hunger < 0 ||
      entity.needs.hunger > 1 ||
      entity.needs.energy < 0 ||
      entity.needs.energy > 1 ||
      entity.needs.social < 0 ||
      entity.needs.social > 1
    ) {
      throw new Error(`Invariant violated: need out of [0,1] for ${entity.id}`);
    }
  }

  const expectedGold = world.initialTotalGold + world.totalGoldMinted;
  if (totalGold !== expectedGold) {
    throw new Error(
      `Invariant violated: gold conservation broken (actual=${totalGold}, expected=${expectedGold})`,
    );
  }
}
