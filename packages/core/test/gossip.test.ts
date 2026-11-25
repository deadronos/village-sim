import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIG,
  ITEM_CAPS,
  ScriptedProvider,
  SystemOneProvider,
  VillageSimulation,
  assertWorldInvariants,
  buildDawnQuestion,
  buildTickQuestion,
  configFromEnv,
  computeProsperity,
  createInitialWorld,
  decayRumorsForNewDay,
  getEntityById,
  getRelationshipTier,
  getStock,
  propagateGossip,
  pushMemory,
  recordRumor,
  resolveConfig,
  serializeEntityInstruction,
  serializeWorldState,
  setStock,
  tryCozySurplusExchange,
  updateWorldProsperity,
  type Question,
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
      id: "custom-surplus-id",
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
    expect(instr).toContain("Unverified rumor (day 1, 0 hops): dorn has surplus wheat.");
    // Stay well inside the System One compact token budget (~60-120 tokens -> <= 650 chars)
    expect(instr.length).toBeLessThan(650);
  });

  it("uses only the newest eligible rumor in both prompts and supports a configurable age cap", () => {
    const world = createInitialWorld(DEFAULT_CONFIG);
    const anna = getEntityById(world, "anna")!;
    world.day = 5;
    recordRumor(anna, {
      id: "old-friendship",
      kind: "friendship",
      subjectId: "dorn",
      summary: "dorn befriended mira",
      day: 2,
      tick: 12,
      hops: 1,
    });
    recordRumor(anna, {
      id: "new-friendship",
      kind: "friendship",
      subjectId: "dorn",
      summary: "dorn befriended bram",
      day: 3,
      tick: 2,
      hops: 2,
    });

    for (const prompt of [
      buildDawnQuestion(world, anna).instructions,
      buildTickQuestion(world, anna, { work: "bake" }).instructions,
    ]) {
      expect(prompt).toContain("Unverified rumor (day 3, 2 hops): dorn befriended bram.");
      expect(prompt).not.toContain("dorn befriended mira");
      expect(prompt.match(/Unverified rumor/g)).toHaveLength(1);
    }
    const config = resolveConfig({ env: configFromEnv({ DECISION_RUMOR_MAX_AGE_DAYS: "1" }) });
    expect(config.rumorMaxAgeDays).toBe(1);
    expect(buildDawnQuestion(world, anna, config.rumorMaxAgeDays).instructions).not.toContain(
      "Unverified rumor",
    );
    expect(
      buildTickQuestion(world, anna, { work: "bake" }, config.rumorMaxAgeDays).instructions,
    ).not.toContain("Unverified rumor");
    expect(() => resolveConfig({ file: { rumorMaxAgeDays: -1 } })).toThrow("rumorMaxAgeDays");
    world.day = 6;
    expect(buildDawnQuestion(world, anna).instructions).not.toContain("Unverified rumor");
    expect(serializeEntityInstruction(world, anna)).not.toContain("Unverified rumor");
  });

  it("suppresses stock contradictions and their copies in recent gossip memory", () => {
    const world = createInitialWorld(DEFAULT_CONFIG);
    const anna = getEntityById(world, "anna")!;
    const dorn = getEntityById(world, "dorn")!;
    setStock(dorn, "wheat", 0);
    pushMemory(anna, "checked the oven");
    pushMemory(anna, "heard from dorn: dorn has surplus wheat");
    recordRumor(anna, {
      id: "surplus:1:dorn:wheat",
      kind: "surplus",
      subjectId: "dorn",
      summary: "dorn has surplus wheat",
      day: 1,
      tick: 5,
    });
    recordRumor(anna, {
      id: "friendship:dorn:mira",
      kind: "friendship",
      subjectId: "dorn",
      summary: "dorn and mira became close friends",
      day: 1,
      tick: 3,
      hops: 1,
    });

    expect(serializeWorldState(world)).toContain("Stocks: wheat 0");
    for (const prompt of [
      buildDawnQuestion(world, anna).instructions,
      serializeEntityInstruction(world, anna),
    ]) {
      expect(prompt).not.toContain("dorn has surplus wheat");
      expect(prompt).toContain("Recent: checked the oven.");
      expect(prompt).toContain(
        "Unverified rumor (day 1, 1 hop): dorn and mira became close friends.",
      );
    }
  });

  it("keeps a personal shortage until that villager has enough stock", () => {
    const world = createInitialWorld(DEFAULT_CONFIG);
    const anna = getEntityById(world, "anna")!;
    setStock(anna, "wheat", 0);
    recordRumor(anna, {
      id: "shortage:1:anna:wheat",
      kind: "shortage",
      subjectId: "anna",
      summary: "anna is short on wheat",
      day: 1,
      tick: 1,
    });

    expect(serializeWorldState(world)).not.toContain("Stocks: wheat 0");
    expect(serializeEntityInstruction(world, anna)).toContain("anna is short on wheat");

    setStock(anna, "wheat", 3);
    expect(serializeEntityInstruction(world, anna)).not.toContain("anna is short on wheat");
  });

  it("suppresses a meal shortage when the villager can eat again", () => {
    const world = createInitialWorld(DEFAULT_CONFIG);
    const anna = getEntityById(world, "anna")!;
    anna.gold = 0;
    setStock(anna, "bread", 0);
    setStock(anna, "stew", 0);
    recordRumor(anna, {
      id: "shortage:1:anna:food",
      kind: "shortage",
      subjectId: "anna",
      summary: "anna cannot find an affordable meal",
      day: 1,
      tick: 1,
    });

    expect(serializeEntityInstruction(world, anna)).toContain(
      "anna cannot find an affordable meal",
    );
    setStock(anna, "bread", 1);
    expect(serializeEntityInstruction(world, anna)).not.toContain(
      "anna cannot find an affordable meal",
    );
    expect(buildDawnQuestion(world, anna).instructions).not.toContain(
      "anna cannot find an affordable meal",
    );
  });

  it("applies the configured age in both System One prompts without leaking legacy gossip", async () => {
    const requests: Array<{ state: string; questions: Record<string, Question> }> = [];
    const scripted = new ScriptedProvider();
    const provider = new SystemOneProvider({
      endpoint: DEFAULT_CONFIG.endpoint,
      model: DEFAULT_CONFIG.model,
      timeoutMs: 1000,
      batch: "always",
      fetchImpl: async (_input, init) => {
        const request = JSON.parse(init!.body as string) as (typeof requests)[number];
        requests.push(request);
        const result = await scripted.decide(request.state, request.questions, 7);
        return new Response(JSON.stringify({ answers: result.answers }));
      },
    });
    const sim = new VillageSimulation(
      resolveConfig({
        env: configFromEnv({ DECISION_PROVIDER: "systemone", DECISION_RUMOR_MAX_AGE_DAYS: "0" }),
      }),
      provider,
    );
    expect(sim.records[0]).toMatchObject({ recordType: "header", rumorMaxAgeDays: 0 });
    const anna = getEntityById(sim.world, "anna")!;
    const bram = getEntityById(sim.world, "bram")!;
    sim.world.day = 2;
    recordRumor(anna, {
      id: "friendship:dorn:mira",
      kind: "friendship",
      subjectId: "dorn",
      summary: "dorn and mira became close friends",
      day: 1,
      tick: 4,
    });
    recordRumor(bram, {
      id: "friendship:bram:mira",
      kind: "friendship",
      subjectId: "bram",
      summary: "bram and mira became close friends",
      day: 2,
      tick: 0,
    });
    await sim.stepTick();

    for (const phase of ["dawn", "act"]) {
      const key = `${phase}_anna`;
      const questions = requests.find((request) => key in request.questions)?.questions;
      expect(Object.keys(questions?.[key] ?? {}).toSorted()).toEqual([
        "criteria",
        "instructions",
        "type",
      ]);
      expect(questions?.[key]?.instructions).not.toMatch(/Unverified rumor|Heard:|dorn and mira/);
      expect(questions?.[`${phase}_bram`]?.instructions).toContain(
        "Unverified rumor (day 2, 0 hops): bram and mira",
      );
    }
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
