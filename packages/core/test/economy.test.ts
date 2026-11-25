import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIG,
  ITEM_CAPS,
  ScriptedProvider,
  VillageSimulation,
  assertWorldInvariants,
  canonicalJson,
  createInitialWorld,
  decayNeeds,
  executeRecipe,
  executeTrade,
  getEntityById,
  getStock,
  hashWorldState,
  setStock,
} from "../src/index.ts";

describe("Economy, recipes, caps, and invariants", () => {
  it("rejects invalid trades (wrong location, out of stock, insufficient gold, cap reached)", () => {
    const world = createInitialWorld(DEFAULT_CONFIG);
    const anna = getEntityById(world, "anna")!;
    const dorn = getEntityById(world, "dorn")!;

    // Wrong location
    anna.location = "bakery";
    expect(executeTrade(world, anna, dorn, "wheat", 1)).toMatchObject({
      ok: false,
      reason: "wrong_location",
    });

    // Move Anna to fields
    anna.location = "fields";

    // Out of stock
    setStock(dorn, "wheat", 0);
    expect(executeTrade(world, anna, dorn, "wheat", 1)).toMatchObject({
      ok: false,
      reason: "out_of_stock",
    });

    // Insufficient gold
    setStock(dorn, "wheat", 3);
    anna.gold = 2;
    expect(executeTrade(world, anna, dorn, "wheat", 1)).toMatchObject({
      ok: false,
      reason: "insufficient_gold",
    });

    // Cap reached
    anna.gold = 20;
    setStock(anna, "wheat", ITEM_CAPS.wheat);
    expect(executeTrade(world, anna, dorn, "wheat", 1)).toMatchObject({
      ok: false,
      reason: "cap_reached",
    });

    // Valid trade succeeds and conserves gold
    setStock(anna, "wheat", 0);
    const beforeTotalGold = anna.gold + dorn.gold;
    const res = executeTrade(world, anna, dorn, "wheat", 1);
    expect(res.ok).toBe(true);
    expect(anna.gold + dorn.gold).toBe(beforeTotalGold);
    expect(getStock(anna, "wheat")).toBe(1);
    expect(getStock(dorn, "wheat")).toBe(2);
  });

  it("executes baker and innkeeper recipes and enforces item caps", () => {
    const world = createInitialWorld(DEFAULT_CONFIG);
    const anna = getEntityById(world, "anna")!;
    anna.location = "bakery";
    setStock(anna, "wheat", 1);
    setStock(anna, "water", 1);
    setStock(anna, "bread", 1);

    const baked = executeRecipe(world, anna);
    expect(baked.ok).toBe(true);
    expect(baked.producedQty).toBe(2);
    expect(getStock(anna, "wheat")).toBe(0);
    expect(getStock(anna, "water")).toBe(0);
    expect(getStock(anna, "bread")).toBe(3);

    // Cap enforcement: at cap - 1, baking only produces up to cap
    setStock(anna, "wheat", 1);
    setStock(anna, "water", 1);
    setStock(anna, "bread", ITEM_CAPS.bread - 1);
    const capped = executeRecipe(world, anna);
    expect(capped.ok).toBe(true);
    expect(capped.producedQty).toBe(1);
    expect(getStock(anna, "bread")).toBe(ITEM_CAPS.bread);
  });

  it("clamps need decay within [0, 1]", () => {
    const world = createInitialWorld(DEFAULT_CONFIG);
    const pip = getEntityById(world, "pip")!;
    pip.needs.hunger = 0.99;
    pip.needs.energy = 0.01;
    pip.needs.social = 0.005;

    decayNeeds(pip);
    expect(pip.needs.hunger).toBe(1);
    expect(pip.needs.energy).toBe(0);
    expect(pip.needs.social).toBe(0);
  });

  it("produces stable canonical JSON and world hashes regardless of key order", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    const w1 = createInitialWorld(DEFAULT_CONFIG);
    const w2 = createInitialWorld(DEFAULT_CONFIG);
    expect(hashWorldState(w1)).toBe(hashWorldState(w2));
  });

  it("property test: invariants hold across 1,000+ ticks across multiple seeds", async () => {
    const seeds = [1, 17, 42, 99];
    let totalTicks = 0;

    for (const seed of seeds) {
      const sim = new VillageSimulation(
        { ...DEFAULT_CONFIG, seed, days: 4 },
        new ScriptedProvider(),
      );
      while (!sim.isFinished) {
        await sim.stepTick();
        assertWorldInvariants(sim.world);
        totalTicks += 1;
      }
    }

    expect(totalTicks).toBeGreaterThanOrEqual(1000);
  });
});
