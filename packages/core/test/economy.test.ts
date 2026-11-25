import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIG,
  ITEM_CAPS,
  ITEM_PRICES,
  RECIPES,
  ScriptedProvider,
  VillageSimulation,
  assertWorldInvariants,
  canonicalJson,
  computeWealthMetrics,
  createInitialWorld,
  decayNeeds,
  executeRecipe,
  executeTrade,
  formatDaySummaryTable,
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

  it("computes Gini coefficient and max/min ratio accurately", () => {
    expect(computeWealthMetrics([])).toMatchObject({ gini: 0, maxMinRatio: 1 });
    expect(computeWealthMetrics([20, 20, 20, 20])).toMatchObject({
      gini: 0,
      maxMinRatio: 1,
      minGold: 20,
      maxGold: 20,
      totalGold: 80,
    });
    expect(computeWealthMetrics([0, 0, 0, 100])).toMatchObject({
      gini: 0.75,
      maxMinRatio: 100,
      minGold: 0,
      maxGold: 100,
      totalGold: 100,
    });
  });

  it("consumes tools in farmer harvests and sustains real P2P tool trades from the smith", async () => {
    const world = createInitialWorld(DEFAULT_CONFIG);
    const dorn = getEntityById(world, "dorn")!;
    dorn.location = "fields";
    setStock(dorn, "wheat", 2);
    setStock(dorn, "tool", 0);

    // Without a tool, farmer cannot harvest
    expect(executeRecipe(world, dorn)).toMatchObject({
      ok: false,
      producedQty: 0,
      reason: "missing_inputs",
    });

    // With a tool, farmer consumes 1 tool to harvest 3 wheat
    setStock(dorn, "tool", 1);
    const harvested = executeRecipe(world, dorn);
    expect(harvested.ok).toBe(true);
    expect(harvested.producedQty).toBe(3);
    expect(getStock(dorn, "tool")).toBe(0);
    expect(getStock(dorn, "wheat")).toBe(5);

    // Multi-day run must include real P2P tool trades from Torin to Dorn
    const sim = new VillageSimulation(
      { ...DEFAULT_CONFIG, seed: 7, days: 3, provider: "scripted" },
      new ScriptedProvider(),
    );
    const result = await sim.runAllDays();
    const toolTrades = result.events.filter(
      (e) =>
        e.kind === "trade" &&
        e.item === "tool" &&
        e.otherEntityId === "torin" &&
        e.entityId === "dorn",
    );
    expect(toolTrades.length).toBeGreaterThanOrEqual(3);
  });

  it.each(Array.from({ length: 50 }, (_, seed) => seed))(
    "sustains the scripted economy for seven days (seed %i)",
    async (seed) => {
      const days = 7;
      const sim = new VillageSimulation(
        { ...DEFAULT_CONFIG, seed, days, provider: "scripted" },
        new ScriptedProvider(),
      );
      // The simulation checks world invariants on every tick and throws on failure.
      const { summaries, tickHashes } = await sim.runAllDays().catch((cause: unknown) => {
        throw new Error(`Seed ${seed}, day ${sim.world.day}, tick ${sim.world.tick} failed`, {
          cause,
        });
      });
      expect(summaries, "completed days").toHaveLength(days);
      expect(tickHashes, "completed ticks").toHaveLength(days * DEFAULT_CONFIG.ticksPerDay);

      for (const day of summaries) {
        const context = `seed ${seed}, day ${day.day}`;
        const underfed = day.entities.filter((entity) => entity.meals < 2);
        expect(
          day.minMealsPerEntity,
          `${context}: meals below 2 for ${underfed.map((entity) => `${entity.id} (${entity.meals})`).join(", ")}`,
        ).toBeGreaterThanOrEqual(2);
        expect(day.trades, `${context}: trades`).toBeGreaterThanOrEqual(8);
        expect(day.breadProduced, `${context}: bread produced`).toBeGreaterThanOrEqual(4);
        expect(day.wealthGini, `${context}: wealth Gini`).toBeGreaterThanOrEqual(0);
        expect(day.wealthGini, `${context}: wealth Gini`).toBeLessThanOrEqual(0.45);
        expect(day.fallbackDecisions, `${context}: unexpected fallback decisions`).toBe(0);

        const stockedAtZeroGold = day.entities.flatMap((entity) => {
          const output = RECIPES[entity.role]?.output;
          const stock = output ? (entity.stock[output] ?? 0) : 0;
          return entity.gold === 0 && stock > 0 ? [`${entity.id} (${stock} ${output})`] : [];
        });
        expect(
          stockedAtZeroGold.length,
          `${context}: villagers at 0g with stock to sell: ${stockedAtZeroGold.join(", ")}`,
        ).toBe(0);

        const producerMinGold = Math.min(
          ...day.entities.filter((entity) => RECIPES[entity.role]).map((entity) => entity.gold),
        );
        expect(
          producerMinGold,
          `${context}: day-end producer min gold floor`,
        ).toBeGreaterThanOrEqual(2);
      }
    },
  );

  it("keeps the innkeeper solvent on the default seed day-2 demo run (#36)", async () => {
    const sim = new VillageSimulation(
      { ...DEFAULT_CONFIG, seed: 7, days: 3, provider: "scripted" },
      new ScriptedProvider(),
    );
    const result = await sim.runAllDays();
    for (const day of result.summaries) {
      const bram = day.entities.find((e) => e.id === "bram")!;
      expect(bram.gold, `seed 7 day ${day.day}: bram gold`).toBeGreaterThanOrEqual(2);
    }
  });

  it("maintains healthy trade volume, wealth spread, and avoids consecutive 0g days with unsold stock", async () => {
    const seeds = [7, 19, 42, 101];

    for (const seed of seeds) {
      const sim = new VillageSimulation(
        { ...DEFAULT_CONFIG, seed, days: 3, provider: "scripted" },
        new ScriptedProvider(),
      );
      const result = await sim.runAllDays();

      const prevZeroStocked = new Set<string>();
      for (const day of result.summaries) {
        expect(day.trades).toBeGreaterThanOrEqual(8);
        expect(day.trades).toBeLessThanOrEqual(50);
        expect(day.breadProduced).toBeGreaterThanOrEqual(4);
        expect(day.minMealsPerEntity).toBeGreaterThanOrEqual(2);
        expect(day.mealsTotal).toBeLessThanOrEqual(28);
        expect(day.wealthGini).toBeLessThan(0.4);

        const table = formatDaySummaryTable(day);
        expect(table).toContain(`Wealth: Gini ${day.wealthGini.toFixed(3)}`);

        const currentLowGoldStocked = new Set<string>();
        for (const entity of day.entities) {
          const recipe = RECIPES[entity.role];
          if (!recipe) continue;
          const outputStock = entity.stock[recipe.output] ?? 0;
          if (entity.gold < ITEM_PRICES.bread && outputStock > 0) {
            expect(
              prevZeroStocked.has(entity.id),
              `seed ${seed} day ${day.day}: ${entity.id} ended consecutive days below bread price (${entity.gold}g) holding ${recipe.output}:${outputStock}`,
            ).toBe(false);
            currentLowGoldStocked.add(entity.id);
          }
        }
        prevZeroStocked.clear();
        for (const id of currentLowGoldStocked) prevZeroStocked.add(id);
      }
    }
  });
});
