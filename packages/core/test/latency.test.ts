import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIG,
  SystemOneProvider,
  VillageSimulation,
  buildDawnQuestion,
  configFromEnv,
  createInitialWorld,
  getEntityById,
  getPostActionCooldown,
  pushMemory,
  recordRumor,
  resolveConfig,
  selectEntitiesForTickDecision,
  serializeEntityInstruction,
  serializeWorldState,
  setStock,
} from "../src/index.ts";
import { startFakeSystemOne, type FakeSystemOneHandle } from "./fake_systemone.ts";

describe("Prompt compactness, LoD cadence, and bounded batch size (Issue #2)", () => {
  let server: FakeSystemOneHandle | null = null;

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
  });

  it("keeps serialized world state and entity instructions compact without duplicating shared state", () => {
    const world = createInitialWorld(DEFAULT_CONFIG);
    const anna = getEntityById(world, "anna")!;
    setStock(anna, "wheat", 0);
    setStock(anna, "water", 0);
    anna.affinity.bram = 0.82;
    pushMemory(anna, "sold bread to bram for 5g");
    pushMemory(anna, "bought wheat from dorn for 4g");
    pushMemory(anna, "heard from dorn: dorn has surplus wheat");
    pushMemory(anna, "produced 2 bread");
    recordRumor(anna, {
      id: "surplus:1:dorn:wheat",
      kind: "surplus",
      subjectId: "dorn",
      summary: "dorn has surplus wheat",
      day: 1,
      tick: 3,
    });

    const stateStr = serializeWorldState(world);
    const instr = serializeEntityInstruction(world, anna);
    const dawnQ = buildDawnQuestion(world, anna);

    // Shared world state omits static Places list and stays compact (~20-30 tokens)
    expect(stateStr).not.toContain("Places:");
    expect(stateStr.length).toBeLessThan(120);
    expect(stateStr).toContain("weather");
    expect(stateStr).toContain("prosperity");
    expect(stateStr).toContain("bread");

    // Entity instruction omits duplicated time/weather/prosperity and trims memory to last 2
    expect(instr).not.toContain("It is ");
    expect(instr).not.toContain("sold bread to bram");
    expect(instr).toContain("produced 2 bread");
    expect(instr).toContain("Needs: wheat, water.");
    expect(instr).toContain("Closest: bram (close).");
    expect(instr).toContain("Unverified rumor (day 1, 0 hops): dorn has surplus wheat.");
    // Tight ~55-90 token budget (<= 340 chars even in worst-case with bond + rumor + missing inputs)
    expect(instr.length).toBeLessThan(340);
    expect(dawnQ.instructions.length).toBeLessThan(280);
  });

  it("assigns role-based LoD cooldowns and clears cooldown on failed food/restock", () => {
    const world = createInitialWorld(DEFAULT_CONFIG);
    const anna = getEntityById(world, "anna")!;
    const cora = getEntityById(world, "cora")!;
    const garrick = getEntityById(world, "garrick")!;
    const pip = getEntityById(world, "pip")!;

    expect(getPostActionCooldown(anna, "work", true)).toBe(0);
    expect(getPostActionCooldown(cora, "work", true)).toBe(2);
    expect(getPostActionCooldown(garrick, "patrol", true)).toBe(3);
    expect(getPostActionCooldown(pip, "wander", true)).toBe(3);

    // Failed food/restock retries next tick with 0 cooldown
    expect(getPostActionCooldown(anna, "restock", false)).toBe(0);
    expect(getPostActionCooldown(pip, "buy_food", false)).toBe(0);
  });

  it("bounds per-tick selection to maxBatch and prioritizes urgent hunger & supply-chain roles", () => {
    const world = createInitialWorld(DEFAULT_CONFIG);
    // All 8 entities start idle and off-cooldown
    const batch = selectEntitiesForTickDecision(world, 3);
    expect(batch).toHaveLength(3);
    // Critical supply-chain roles (dorn, anna, bram) go first
    expect(batch.map((e) => e.role).toSorted()).toEqual(["baker", "farmer", "innkeeper"]);

    // Urgent hunger overrides role criticality
    const pip = getEntityById(world, "pip")!;
    pip.needs.hunger = 0.85;
    const urgentBatch = selectEntitiesForTickDecision(world, 3);
    expect(urgentBatch[0]?.id).toBe("pip");

    // Entities on cooldown are skipped
    const anna = getEntityById(world, "anna")!;
    anna.decisionCooldown = 1;
    const afterCooldown = selectEntitiesForTickDecision(world, 3);
    expect(afterCooldown.some((e) => e.id === "anna")).toBe(false);
  });

  it("caps tick provider batches at maxBatch while keeping dawn call intact and economy alive", async () => {
    server = await startFakeSystemOne({ latencyMs: 5 });
    const provider = new SystemOneProvider({
      endpoint: server.endpoint,
      model: "kev-latest",
      timeoutMs: 5000,
      batch: "auto",
      retryBaseMs: 5,
    });

    const sim = new VillageSimulation(
      { ...DEFAULT_CONFIG, provider: "systemone", endpoint: server.endpoint, days: 1, seed: 7 },
      provider,
    );
    const result = await sim.runAllDays();
    const day1 = result.summaries[0]!;

    // Call 0 is dawn (8 entities); all subsequent tick sweeps must be <= maxBatch (3)
    expect(server.calls[0]?.questionCount).toBe(8);
    const tickCalls = server.calls.slice(1);
    expect(tickCalls.length).toBeGreaterThan(10);
    expect(Math.max(...tickCalls.map((c) => c.questionCount))).toBeLessThanOrEqual(
      DEFAULT_CONFIG.maxBatch,
    );

    // Living economy (A3) still holds under LoD cadence + bounded batches
    expect(day1.trades).toBeGreaterThanOrEqual(8);
    expect(day1.breadProduced).toBeGreaterThanOrEqual(4);
    expect(day1.minMealsPerEntity).toBeGreaterThanOrEqual(2);
  });

  it("supports DECISION_MAX_BATCH via env and config resolution", () => {
    const env = configFromEnv({ DECISION_MAX_BATCH: "4" });
    const cfg = resolveConfig({ env });
    expect(cfg.maxBatch).toBe(4);
  });
});
