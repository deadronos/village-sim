import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIG,
  createInitialWorld,
  getEntityById,
  getGatedActions,
  setStock,
} from "../src/index.ts";

describe("Gating rules (A6)", () => {
  it("offers ONLY buy_food when hunger > 0.8 (e.g. 0.9)", () => {
    const world = createInitialWorld(DEFAULT_CONFIG);
    const anna = getEntityById(world, "anna")!;
    anna.needs.hunger = 0.9;
    anna.needs.energy = 0.2;
    anna.needs.social = 0.1;

    const actions = getGatedActions(world, anna);
    expect(Object.keys(actions)).toEqual(["buy_food"]);
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
});
