import { ITEM_CAPS, ITEM_PRICES, RECIPES } from "./economy.ts";
import type {
  Entity,
  ItemKind,
  ProsperityTier,
  RelationshipTier,
  Rumor,
  RumorKind,
  SimEvent,
  WorldState,
} from "./types.ts";
import { addStock, clamp01, formatSimTime, getStock, pushMemory } from "./world.ts";

export const RUMOR_LIMIT = 4;

export function getRelationshipTier(affinity: number): RelationshipTier {
  if (affinity >= 0.72) return "close";
  if (affinity >= 0.56) return "warm";
  if (affinity >= 0.4) return "neutral";
  return "cool";
}

export function getTopBonds(
  world: WorldState,
  entity: Entity,
  limit = 3,
): Array<{ entity: Entity; affinity: number; tier: RelationshipTier }> {
  return world.entities
    .filter((other) => other.id !== entity.id)
    .map((other) => {
      const affinity = entity.affinity[other.id] ?? 0.5;
      return { entity: other, affinity, tier: getRelationshipTier(affinity) };
    })
    .toSorted((a, b) => {
      if (b.affinity !== a.affinity) return b.affinity - a.affinity;
      return a.entity.id < b.entity.id ? -1 : 1;
    })
    .slice(0, limit);
}

/**
 * Computes the deterministic village prosperity score (0..1) and tier
 * (`lean | steady | thriving`) from villager gold, food reserves, and trade momentum.
 */
export function computeProsperity(world: WorldState): {
  score: number;
  tier: ProsperityTier;
} {
  const count = Math.max(1, world.entities.length);
  const totalGold = world.entities.reduce((sum, e) => sum + e.gold, 0);
  const avgGold = totalGold / count;

  let totalFood = 0;
  for (const e of world.entities) {
    totalFood += getStock(e, "bread") + getStock(e, "stew");
  }

  const goldScore = Math.min(1, avgGold / 34);
  const foodScore = Math.min(1, totalFood / 16);
  const momentumBase = world.day > 1 ? 6 : 4;
  const tradeScore = Math.min(1, (world.tradesToday + momentumBase) / 18);

  const score = clamp01(goldScore * 0.4 + foodScore * 0.35 + tradeScore * 0.25);
  const tier: ProsperityTier = score >= 0.66 ? "thriving" : score >= 0.42 ? "steady" : "lean";
  return { score, tier };
}

export function updateWorldProsperity(world: WorldState): void {
  const { score, tier } = computeProsperity(world);
  world.prosperityScore = score;
  world.prosperity = tier;
}

export function recordRumor(
  entity: Entity,
  params: {
    id: string;
    kind: RumorKind;
    subjectId: string;
    summary: string;
    day: number;
    tick: number;
    hops?: number;
    sourceId?: string;
  },
): boolean {
  const existingIdx = entity.rumors.findIndex((r) => r.id === params.id);
  const incomingHops = params.hops ?? 0;

  if (existingIdx !== -1) {
    const existing = entity.rumors[existingIdx]!;
    // Keep the fresher or lower-hop version of the same rumor
    if (
      params.day > existing.originDay ||
      (params.day === existing.originDay && params.tick > existing.originTick) ||
      incomingHops < existing.hops
    ) {
      entity.rumors[existingIdx] = {
        id: params.id,
        kind: params.kind,
        subjectId: params.subjectId,
        summary: params.summary,
        originDay: params.day,
        originTick: params.tick,
        hops: incomingHops,
        sourceId: params.sourceId ?? entity.id,
      };
      return true;
    }
    return false;
  }

  entity.rumors.push({
    id: params.id,
    kind: params.kind,
    subjectId: params.subjectId,
    summary: params.summary,
    originDay: params.day,
    originTick: params.tick,
    hops: incomingHops,
    sourceId: params.sourceId ?? entity.id,
  });

  if (entity.rumors.length > RUMOR_LIMIT) {
    // Evict oldest / highest-hop rumor deterministically
    entity.rumors.sort((a, b) => {
      if (a.originDay !== b.originDay) return b.originDay - a.originDay;
      if (a.originTick !== b.originTick) return b.originTick - a.originTick;
      if (a.hops !== b.hops) return a.hops - b.hops;
      return a.id < b.id ? -1 : 1;
    });
    entity.rumors.length = RUMOR_LIMIT;
  }

  return true;
}

/**
 * Decay stale rumors overnight (> 1 day old) so the rumor graph stays fresh and relevant.
 */
export function decayRumorsForNewDay(world: WorldState): void {
  for (const entity of world.entities) {
    entity.rumors = entity.rumors.filter((r) => world.day - r.originDay <= 1);
  }
}

/**
 * Propagate one unknown or fresher rumor from `speaker` to `listener`.
 * Returns a `gossip` SimEvent when a rumor spreads.
 */
export function propagateGossip(
  world: WorldState,
  speaker: Entity,
  listener: Entity,
): SimEvent | null {
  if (speaker.rumors.length === 0) return null;

  const listenerIds = new Set(listener.rumors.map((r) => r.id));
  const candidates = speaker.rumors
    .filter((r) => r.sourceId !== listener.id && !listenerIds.has(r.id))
    .toSorted((a, b) => {
      if (a.hops !== b.hops) return a.hops - b.hops;
      if (b.originDay !== a.originDay) return b.originDay - a.originDay;
      if (b.originTick !== a.originTick) return b.originTick - a.originTick;
      return a.id < b.id ? -1 : 1;
    });

  const chosen = candidates[0];
  if (!chosen) return null;

  const stored = recordRumor(listener, {
    id: chosen.id,
    kind: chosen.kind,
    subjectId: chosen.subjectId,
    summary: chosen.summary,
    day: chosen.originDay,
    tick: chosen.originTick,
    hops: chosen.hops + 1,
    sourceId: speaker.id,
  });

  if (!stored) return null;

  pushMemory(listener, `heard from ${speaker.name.toLowerCase()}: ${chosen.summary}`);
  const time = formatSimTime(world.tick, world.minutesPerTick, world.startHour);
  return {
    day: world.day,
    tick: world.tick,
    time,
    kind: "gossip",
    entityId: speaker.id,
    otherEntityId: listener.id,
    place: speaker.location,
    rumorSummary: chosen.summary,
    message: `${time} ${speaker.name.toLowerCase()} tells ${listener.name.toLowerCase()}: "${chosen.summary}"`,
  };
}

/**
 * Record a friendship rumor if two villagers just crossed into the "close" tier (>= 0.72).
 */
export function maybeRecordFriendshipRumor(
  world: WorldState,
  a: Entity,
  b: Entity,
  prevAffinity: number,
): void {
  const nowAffinity = a.affinity[b.id] ?? 0.5;
  if (prevAffinity < 0.72 && nowAffinity >= 0.72) {
    const [first, second] = a.id < b.id ? [a, b] : [b, a];
    const id = `friendship:${first.id}:${second.id}`;
    const summary = `${first.name.toLowerCase()} and ${second.name.toLowerCase()} became close friends`;
    recordRumor(a, {
      id,
      kind: "friendship",
      subjectId: first.id,
      summary,
      day: world.day,
      tick: world.tick,
    });
    recordRumor(b, {
      id,
      kind: "friendship",
      subjectId: first.id,
      summary,
      day: world.day,
      tick: world.tick,
    });
  }
}

/**
 * Cozy prosperity & friendship interaction when two villagers socialize:
 * 1. When thriving, a well-off villager meeting a herbalist or smith with surplus stock
 *    may buy a personal herb bundle or tool (real P2P trade, gold conserved).
 * 2. When steady/thriving, a producer near stock cap meeting a warm/close friend who can
 *    use that item may gift 1 surplus unit (preserves all caps & gold invariants).
 */
export function tryCozySurplusExchange(
  world: WorldState,
  actor: Entity,
  partner: Entity,
): SimEvent | null {
  const time = formatSimTime(world.tick, world.minutesPerTick, world.startHour);

  // 1. Prosperous surplus P2P purchase of herbs or tools during a friendly chat
  if (
    world.prosperity === "thriving" &&
    actor.location === partner.location &&
    (partner.role === "herbalist" || partner.role === "smith")
  ) {
    const item: ItemKind = partner.role === "herbalist" ? "herbs" : "tool";
    const price = ITEM_PRICES[item];
    if (
      actor.gold >= price + 12 &&
      getStock(partner, item) >= 2 &&
      getStock(actor, item) === 0 &&
      getStock(actor, item) < ITEM_CAPS[item]
    ) {
      actor.gold -= price;
      partner.gold += price;
      addStock(partner, item, -1);
      addStock(actor, item, 1);

      actor.tradesToday += 1;
      partner.tradesToday += 1;
      world.tradesToday += 1;
      world.tradesTotal += 1;

      const prevAff = actor.affinity[partner.id] ?? 0.5;
      actor.affinity[partner.id] = clamp01(prevAff + 0.04);
      partner.affinity[actor.id] = clamp01((partner.affinity[actor.id] ?? 0.5) + 0.04);
      maybeRecordFriendshipRumor(world, actor, partner, prevAff);

      pushMemory(actor, `bought spare ${item} from ${partner.name.toLowerCase()} for ${price}g`);
      pushMemory(partner, `sold spare ${item} to ${actor.name.toLowerCase()} for ${price}g`);

      return {
        day: world.day,
        tick: world.tick,
        time,
        kind: "trade",
        entityId: actor.id,
        otherEntityId: partner.id,
        place: actor.location,
        item,
        qty: 1,
        gold: price,
        message: `${time} ${actor.name.toLowerCase()} buys spare ${item} from ${partner.name.toLowerCase()} for ${price}g`,
      };
    }
  }

  // 2. Warm/close friend surplus gifting when producer is near stock cap
  if (world.prosperity === "lean") return null;
  const tier = getRelationshipTier(actor.affinity[partner.id] ?? 0.5);
  if (tier !== "warm" && tier !== "close") return null;

  const actorRecipe = RECIPES[actor.role];
  if (!actorRecipe) return null;

  const item = actorRecipe.output;
  const cap = ITEM_CAPS[item];
  if (getStock(actor, item) < cap - 1) return null;
  if (getStock(partner, item) >= cap) return null;

  const partnerRecipe = RECIPES[partner.role];
  const partnerNeedsInput = Boolean(partnerRecipe?.inputs[item]);
  const isUsefulFood = (item === "bread" || item === "stew") && partner.needs.hunger > 0.35;
  const isCozyHerbs = item === "herbs" && getStock(partner, "herbs") === 0;

  if (!partnerNeedsInput && !isUsefulFood && !isCozyHerbs) return null;

  addStock(actor, item, -1);
  addStock(partner, item, 1);

  const prevAff = actor.affinity[partner.id] ?? 0.5;
  actor.affinity[partner.id] = clamp01(prevAff + 0.08);
  partner.affinity[actor.id] = clamp01((partner.affinity[actor.id] ?? 0.5) + 0.08);
  maybeRecordFriendshipRumor(world, actor, partner, prevAff);

  pushMemory(actor, `gifted surplus ${item} to ${partner.name.toLowerCase()}`);
  pushMemory(partner, `received ${item} gift from ${actor.name.toLowerCase()}`);

  const summary = `${actor.name.toLowerCase()} gifted ${item} to ${partner.name.toLowerCase()}`;
  recordRumor(partner, {
    id: `gift:${world.day}:${actor.id}:${partner.id}:${item}`,
    kind: "gift",
    subjectId: actor.id,
    summary,
    day: world.day,
    tick: world.tick,
  });

  return {
    day: world.day,
    tick: world.tick,
    time,
    kind: "gift",
    entityId: actor.id,
    otherEntityId: partner.id,
    place: actor.location,
    item,
    qty: 1,
    message: `${time} ${actor.name.toLowerCase()} gifts surplus ${item} to ${partner.name.toLowerCase()}`,
  };
}

export function getTopRumor(
  entity: Entity,
  eligible?: (rumor: Rumor) => boolean,
): Rumor | undefined {
  const rumors = eligible ? entity.rumors.filter(eligible) : entity.rumors;
  return rumors.toSorted((a, b) => {
    if (b.originDay !== a.originDay) return b.originDay - a.originDay;
    if (b.originTick !== a.originTick) return b.originTick - a.originTick;
    if (a.hops !== b.hops) return a.hops - b.hops;
    return a.id < b.id ? -1 : 1;
  })[0];
}
