import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIG,
  ReplayProvider,
  ScriptedProvider,
  VillageSimulation,
  explainLastDecision,
  formatExplainReport,
  parseJsonl,
  serializeJsonl,
} from "../src/index.ts";

async function runSeed(seed: number) {
  const sim = new VillageSimulation(
    { ...DEFAULT_CONFIG, seed, days: 3, provider: "scripted" },
    new ScriptedProvider(),
  );
  return sim.runAllDays();
}

describe("Determinism, living economy, replay, and auditability (A1, A3, A4, A7, A8)", () => {
  it("completes 3 offline days with a living economy every day (A1, A3)", async () => {
    const sim = new VillageSimulation(
      { ...DEFAULT_CONFIG, seed: 7, days: 3, provider: "scripted" },
      new ScriptedProvider(),
    );
    const result = await sim.runAllDays();

    expect(result.summaries).toHaveLength(3);
    for (const day of result.summaries) {
      expect(day.trades).toBeGreaterThanOrEqual(8);
      expect(day.breadProduced).toBeGreaterThanOrEqual(4);
      expect(day.minMealsPerEntity).toBeGreaterThanOrEqual(2);
    }
  });

  it("reproduces identical state-hash sequences for the same seed and diverges >=10% across seeds (A4)", async () => {
    const runA = await runSeed(7);
    const runB = await runSeed(7);
    expect(runA.tickHashes.map((h) => h.state_hash)).toEqual(
      runB.tickHashes.map((h) => h.state_hash),
    );
    expect(runA.finalStateHash).toBe(runB.finalStateHash);

    // Compare against several distinct seeds — trade counts must vary meaningfully (>=10%)
    const otherRuns = await Promise.all([runSeed(19), runSeed(42), runSeed(101), runSeed(2026)]);
    const baseTrades = runA.world.tradesTotal;
    const maxRelativeDiff = Math.max(
      ...otherRuns.map((r) => Math.abs(r.world.tradesTotal - baseTrades) / Math.max(1, baseTrades)),
    );
    expect(maxRelativeDiff).toBeGreaterThanOrEqual(0.1);
  });

  it("replays a serialized JSONL log to reproduce the exact per-tick and final hash sequence (A7)", async () => {
    const original = new VillageSimulation(
      { ...DEFAULT_CONFIG, seed: 7, days: 2, provider: "scripted" },
      new ScriptedProvider(),
    );
    const origResult = await original.runAllDays();

    const jsonl = serializeJsonl(origResult.records);
    const parsed = parseJsonl(jsonl);

    expect(parsed.header?.seed).toBe(7);
    expect(parsed.decisions.length).toBeGreaterThan(0);

    const replaySim = new VillageSimulation(
      {
        ...DEFAULT_CONFIG,
        seed: parsed.header!.seed,
        days: parsed.header!.days,
        sample: parsed.header!.sample,
        minConf: parsed.header!.minConf,
        maxBatch: parsed.header!.maxBatch ?? DEFAULT_CONFIG.maxBatch,
        provider: "replay",
      },
      new ReplayProvider(parsed.decisions),
    );
    const replayResult = await replaySim.runAllDays();

    expect(replayResult.tickHashes.map((h) => h.state_hash)).toEqual(
      parsed.tickHashes.map((h) => h.state_hash),
    );
    expect(replayResult.finalStateHash).toBe(origResult.finalStateHash);
  });

  it("records full probability distributions and explains exact instructions sent (A8)", async () => {
    const sim = new VillageSimulation(
      { ...DEFAULT_CONFIG, seed: 7, days: 1, provider: "scripted" },
      new ScriptedProvider(),
    );
    const result = await sim.runAllDays();

    for (const dec of result.decisions) {
      expect(Object.keys(dec.probabilities).length).toBeGreaterThan(0);
      const sum = Object.values(dec.probabilities).reduce((a, b) => a + b, 0);
      expect(sum).toBeGreaterThan(0.98);
      expect(sum).toBeLessThan(1.02);
      expect(dec.instructions.length).toBeGreaterThan(20);
      expect(dec.state_hash).toHaveLength(64);
    }

    const annaLast = explainLastDecision(result.decisions, "anna");
    expect(annaLast).toBeDefined();
    const report = formatExplainReport(annaLast!);
    expect(report).toContain("anna the baker");
    expect(report).toContain("Probability Distribution:");
    expect(report).toContain("<-- chosen");
  });
});
