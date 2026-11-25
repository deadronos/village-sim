import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIG,
  ITEM_CAPS,
  ScriptedProvider,
  VillageSimulation,
  assertWorldInvariants,
  computeProsperity,
  createInitialWorld,
  decayRumorsForNewDay,
  getEntityById,
  getRelationshipTier,
  getStock,
  propagateGossip,
  recordRumor,
  serializeEntityInstruction,
  serializeWorldState,
  setStock,
  tryCozySurplusExchange,
  updateWorldProsperity,
} from "../src/index.ts";

describe("Emergent villager gossip, memory graph, prosperity, and cozy routines", () => {
  it("classifies relationship tiers cleanly from affinity", () => {
    expect(getRelationshipTier(0.25)).toBe("cool");
    expect(getRelationshipTier(0.5)).toBe("neutral");
    expect(getRelationshipTier(0.62)).toBe("warm");
    expect(getRelationshipTier(0.8)).toBe("close");
  });

  it("propagates rumors hop-by-hop and decays stale rumors after >1 day", () => {
    const world = createInitialWorld(DEFAULT_CONFIG);
    const anna = getEntityById(world, "anna")!;
    const bram = getEntityById(world, "bram")!;
    const dorn = getEntityById(world, "dorn")!;

    recordRumor(anna, {
      id: "surplus:1:anna:bread",
      kind: "surplus",
      subjectId: "anna",
      summary: "anna has surplus bread",
      day: 1,
      tick: 5,
    });

    const ev1 = propagateGossip(world, anna, bram);
    expect(ev1?.kind).toBe("gossip");
    expect(bram.rumors).toHaveLength(1);
    expect(bram.rumors[0]?.hops).toBe(1);
    expect(bram.rumors[0]?.sourceId).toBe("anna");

    // Second hop: bram tells dorn
    const ev2 = propagateGossip(world, bram, dorn);
    expect(ev2?.kind).toBe("gossip");
    expect(dorn.rumors[0]?.hops).toBe(2);
    expect(dorn.rumors[0]?.sourceId).toBe("bram");

    // Same speaker won't repeat the exact same rumor back to anna
    expect(propagateGossip(world, bram, anna)).toBeNull();

    // Decay rumors older than 1 day
    world.day = 3;
    decayRumorsForNewDay(world);
    expect(anna.rumors).toHaveLength(0);
    expect(bram.rumors).toHaveLength(0);
    expect(dorn.rumors).toHaveLength(0);
  });

  it("computes village prosperity across lean, steady, and thriving conditions", () => {
    const world = createInitialWorld(DEFAULT_CONFIG);
    const initial = computeProsperity(world);
    expect(["steady", "thriving"]).toContain(initial.tier);

    // Simulate lean conditions
    for (const e of world.entities) {
      e.gold = 4;
      setStock(e, "bread", 0);
      setStock(e, "stew", 0);
    }
    world.tradesToday = 0;
    expect(computeProsperity(world).tier).toBe("lean");

    // Simulate thriving conditions
    for (const e of world.entities) {
      e.gold = 40;
      setStock(e, "bread", 3);
    }
    world.tradesToday = 16;
    expect(computeProsperity(world).tier).toBe("thriving");
  });

  it("executes cozy surplus friend gifting and prosperous herb/tool trades without violating invariants", () => {
    const world = createInitialWorld(DEFAULT_CONFIG);
    const dorn = getEntityById(world, "dorn")!;
    const anna = getEntityById(world, "anna")!;
    const mira = getEntityById(world, "mira")!;
    const bram = getEntityById(world, "bram")!;

    // 1. Warm friend surplus gift: Dorn near wheat cap gifts 1 wheat to Anna
    dorn.affinity.anna = 0.65;
    anna.affinity.dorn = 0.65;
    setStock(dorn, "wheat", ITEM_CAPS.wheat);
    setStock(anna, "wheat", 0);
    world.prosperity = "steady";

    const giftEv = tryCozySurplusExchange(world, dorn, anna);
    expect(giftEv?.kind).toBe("gift");
    expect(getStock(dorn, "wheat")).toBe(ITEM_CAPS.wheat - 1);
    expect(getStock(anna, "wheat")).toBe(1);
    expect(anna.rumors.some((r) => r.kind === "gift")).toBe(true);
    assertWorldInvariants(world);

    // 2. Thriving surplus herb purchase at tavern (bram starts with 24g >= 6g + 12g)
    world.prosperity = "thriving";
    bram.location = "tavern";
    mira.location = "tavern";
    setStock(mira, "herbs", 3);
    setStock(bram, "herbs", 0);
    const beforeGold = bram.gold + mira.gold;

    const tradeEv = tryCozySurplusExchange(world, bram, mira);
    expect(tradeEv?.kind).toBe("trade");
    expect(bram.gold + mira.gold).toBe(beforeGold);
    expect(getStock(bram, "herbs")).toBe(1);
    expect(getStock(mira, "herbs")).toBe(2);
    assertWorldInvariants(world);
  });

  it("includes prosperity, closest bond, and top rumor compactly in the prompt serializer", () => {
    const world = createInitialWorld(DEFAULT_CONFIG);
    updateWorldProsperity(world);
    const anna = getEntityById(world, "anna")!;
    anna.affinity.bram = 0.78;
    recordRumor(anna, {
      id: "surplus:1:dorn:wheat",
      kind: "surplus",
      subjectId: "dorn",
      summary: "dorn has surplus wheat",
      day: 1,
      tick: 2,
    });

    const stateStr = serializeWorldState(world);
    const instr = serializeEntityInstruction(world, anna);

    expect(stateStr).toContain(`prosperity ${world.prosperity}`);
    expect(instr).toContain("Closest: bram (close).");
    expect(instr).toContain("Heard: dorn has surplus wheat.");
    // Stay well inside the System One compact token budget (~60-120 tokens -> <= 650 chars)
    expect(instr.length).toBeLessThan(650);
  });

  it("generates emergent gossip and preserves living economy invariants over multi-day runs", async () => {
    const sim = new VillageSimulation(
      { ...DEFAULT_CONFIG, seed: 7, days: 3, provider: "scripted" },
      new ScriptedProvider(),
    );
    const result = await sim.runAllDays();

    const gossipEvents = result.events.filter((e) => e.kind === "gossip");
    expect(gossipEvents.length).toBeGreaterThan(0);

    for (const day of result.summaries) {
      expect(day.trades).toBeGreaterThanOrEqual(8);
      expect(day.breadProduced).toBeGreaterThanOrEqual(4);
      expect(day.minMealsPerEntity).toBeGreaterThanOrEqual(2);
    }
  });
});
