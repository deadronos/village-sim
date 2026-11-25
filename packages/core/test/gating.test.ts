import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIG,
  ITEM_PRICES,
  ReplayProvider,
  ScriptedProvider,
  VillageSimulation,
  createInitialWorld,
  getEntityById,
  getGatedActions,
  setStock,
  type DecisionProvider,
} from "../src/index.ts";

function createFoodShortage(provider: DecisionProvider = new ScriptedProvider(), maxBatch = 1) {
  const sim = new VillageSimulation({ ...DEFAULT_CONFIG, maxBatch }, provider);
  const pip = getEntityById(sim.world, "pip")!;
  getEntityById(sim.world, "garrick")!.gold += pip.gold;
  pip.gold = 0;
  pip.location = "bakery";
  for (const entity of sim.world.entities) {
    setStock(entity, "bread", 0);
    setStock(entity, "stew", 0);
  }
  return { sim, pip };
}

function createContestedMeal(provider?: DecisionProvider) {
  const { sim, pip } = createFoodShortage(provider, 2);
  const garrick = getEntityById(sim.world, "garrick")!;
  garrick.gold -= ITEM_PRICES.bread;
  garrick.location = "bakery";
  garrick.needs.hunger = 0.85;
  pip.gold = ITEM_PRICES.bread;
  pip.needs.hunger = 0.85;
  setStock(getEntityById(sim.world, "anna")!, "bread", 1);
  return { sim, pip };
}

describe("Gating rules (A6)", () => {
  it("offers only buy_food when urgently hungry and food is affordable", () => {
    const world = createInitialWorld(DEFAULT_CONFIG);
    const anna = getEntityById(world, "anna")!;
    anna.needs.hunger = 0.9;
    anna.needs.energy = 0.2;
    anna.needs.social = 0.1;

    const actions = getGatedActions(world, anna);
    expect(Object.keys(actions)).toEqual(["buy_food"]);
  });

  it("lets a broke hungry villager eat food they already carry", () => {
    const world = createInitialWorld(DEFAULT_CONFIG);
    const anna = getEntityById(world, "anna")!;
    anna.gold = 0;
    anna.needs.hunger = 0.85;
    setStock(anna, "bread", 1);

    expect(getGatedActions(world, anna)).toEqual({ buy_food: "eat urgently" });
  });

  it("gives a hungry villager with no food source a feasible action and records the shortage", async () => {
    const { sim, pip } = createFoodShortage();
    pip.needs.hunger = 0.85;

    expect(getGatedActions(sim.world, pip)).not.toHaveProperty("buy_food");
    const snapshot = await sim.stepTick();
    const decision = snapshot.decisions.find((record) => record.question_id === "act_pip");
    expect(decision?.action).toBeDefined();
    expect(decision?.action).not.toBe("buy_food");
    expect(pip.memory).not.toContain("found no food to buy");
    expect(pip.rumors).toContainEqual(
      expect.objectContaining({ kind: "shortage", subjectId: "pip" }),
    );
    expect(sim.world.deadlockCounter.pip ?? 0).toBe(0);
    expect(
      snapshot.events.some((event) => event.entityId === "pip" && event.kind === "deadlock"),
    ).toBe(false);
  });

  it("uses the emergency pantry when a villager reaches maximum hunger during a shortage", async () => {
    const { sim, pip } = createFoodShortage();
    pip.needs.hunger = 1;

    const credit = await sim.stepTick();
    expect(credit.events).toContainEqual(
      expect.objectContaining({ kind: "deadlock", entityId: "pip", gold: 4 }),
    );

    const ration = await sim.stepTick();
    expect(ration.events).toContainEqual(
      expect.objectContaining({
        kind: "deadlock",
        entityId: "pip",
        message: expect.stringContaining("pantry ration"),
      }),
    );
    expect(pip.mealsToday).toBe(1);
    expect(sim.world.deadlockCounter.pip).toBe(0);
  });

  it("revalidates food actions after an earlier villager in the batch buys the last meal", async () => {
    const { sim, pip } = createContestedMeal();
    expect(getGatedActions(sim.world, pip)).toEqual({ buy_food: "eat urgently" });

    const snapshot = await sim.stepTick();
    const first = snapshot.decisions.find((record) => record.question_id === "act_garrick");
    const second = snapshot.decisions.find((record) => record.question_id === "act_pip");
    expect(first?.action).toBe("buy_food");
    expect(
      snapshot.events.filter((event) => event.kind === "trade").map((event) => event.entityId),
    ).toEqual(["garrick"]);
    expect(second).toMatchObject({ provider: "scripted", fallback: true, escalated: false });
    expect(second?.action).not.toBe("buy_food");
    expect(second?.criteria).not.toHaveProperty("buy_food");
    expect(pip.memory).not.toContain("found no food to buy");
    expect(pip.rumors).toContainEqual(
      expect.objectContaining({ kind: "shortage", subjectId: "pip" }),
    );
    expect(sim.world.deadlockCounter.pip ?? 0).toBe(0);

    const replay = createContestedMeal(new ReplayProvider(sim.decisions, 2));
    const replayed = await replay.sim.stepTick();
    expect(replayed.stateHash).toBe(snapshot.stateHash);
    expect(replayed.decisions.find((record) => record.question_id === "act_pip")?.action).toBe(
      second?.action,
    );
  });

  it("replays the old hunger override for version 1 logs", async () => {
    const { sim, pip } = createFoodShortage(new ReplayProvider([], 1));
    pip.needs.hunger = 0.85;

    const snapshot = await sim.stepTick();
    expect(snapshot.decisions.find((record) => record.question_id === "act_pip")?.action).toBe(
      "buy_food",
    );
    // First-tick hash for this shortage fixture on b07a5ba, before the gate changed.
    expect(snapshot.stateHash).toBe(
      "4133cd17fe023e9571bc87e1507ac0265f4fba9f74b70d9e4b686ed9aa58063f",
    );
    expect(sim.records[0]).toMatchObject({ recordType: "header", version: 1 });
  });

  it("does not offer restock when no supplier has stock", () => {
    const world = createInitialWorld(DEFAULT_CONFIG);
    const anna = getEntityById(world, "anna")!;
    const dorn = getEntityById(world, "dorn")!;

    // Anna has water, lacks wheat, and Dorn has 0 wheat
    setStock(anna, "wheat", 0);
    setStock(anna, "water", 2);
    setStock(dorn, "wheat", 0);

    const actions = getGatedActions(world, anna);
    expect(actions.restock).toBeUndefined();
    expect(actions.work).toBeUndefined();
  });

  it("offers restock when missing an input and a supplier has stock", () => {
    const world = createInitialWorld(DEFAULT_CONFIG);
    const anna = getEntityById(world, "anna")!;
    const dorn = getEntityById(world, "dorn")!;

    setStock(anna, "wheat", 0);
    setStock(anna, "water", 2);
    setStock(dorn, "wheat", 3);

    const actions = getGatedActions(world, anna);
    expect(actions.restock).toBeDefined();
  });

  it("does not offer rest when energy >= 0.45 (e.g. 0.9)", () => {
    const world = createInitialWorld(DEFAULT_CONFIG);
    const anna = getEntityById(world, "anna")!;
    anna.needs.energy = 0.9;

    const actions = getGatedActions(world, anna);
    expect(actions.rest).toBeUndefined();

    anna.needs.energy = 0.3;
    expect(getGatedActions(world, anna).rest).toBeDefined();
  });

  it("offers patrol to guard and NOT to baker", () => {
    const world = createInitialWorld(DEFAULT_CONFIG);
    const garrick = getEntityById(world, "garrick")!;
    const anna = getEntityById(world, "anna")!;

    expect(getGatedActions(world, garrick).patrol).toBeDefined();
    expect(getGatedActions(world, anna).patrol).toBeUndefined();
  });

  it("always offers wander to child and as fallback when nothing else is allowed", () => {
    const world = createInitialWorld(DEFAULT_CONFIG);
    const pip = getEntityById(world, "pip")!;
    expect(getGatedActions(world, pip).wander).toBeDefined();

    // Remove all options for farmer: at cap, full hunger/energy/social, no bread
    const dorn = getEntityById(world, "dorn")!;
    setStock(dorn, "wheat", 8);
    setStock(dorn, "bread", 0);
    dorn.needs.hunger = 0.1;
    dorn.needs.energy = 0.95;
    dorn.needs.social = 0.95;
    expect(Object.keys(getGatedActions(world, dorn))).toEqual(["wander"]);
  });

  it("gates innkeeper restocking on stew stock and preserves a gold reserve when holding stew", () => {
    const world = createInitialWorld(DEFAULT_CONFIG);
    const bram = getEntityById(world, "bram")!;
    const anna = getEntityById(world, "anna")!;
    setStock(anna, "bread", 4);

    // At 3+ stew, restock is withheld so the innkeeper does not over-buy inputs
    bram.gold = 20;
    setStock(bram, "stew", 3);
    setStock(bram, "bread", 0);
    setStock(bram, "water", 2);
    expect(getGatedActions(world, bram).restock).toBeUndefined();

    // Below 3 stew, holding 1 stew and only 4g (bread price): paid restock would drop gold to 0g, so it is withheld
    bram.gold = ITEM_PRICES.bread;
    setStock(bram, "stew", 1);
    setStock(bram, "bread", 0);
    setStock(bram, "water", 2);
    expect(getGatedActions(world, bram).restock).toBeUndefined();

    // With enough gold to keep a bread reserve (>= 8g), restock is allowed again
    bram.gold = ITEM_PRICES.bread * 2;
    expect(getGatedActions(world, bram).restock).toBeDefined();
  });
});
