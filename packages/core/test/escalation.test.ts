import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIG,
  ReplayProvider,
  ScriptedProvider,
  SystemOneProvider,
  VillageSimulation,
  configFromEnv,
  formatDaySummaryTable,
  parseJsonl,
  resolveConfig,
  serializeJsonl,
} from "../src/index.ts";
import { startFakeSystemOne } from "./fake_systemone.ts";

describe("System One confidence escalation", () => {
  it.each(["sampled", "margin", "entropy"] as const)(
    "escalates a flat model response with %s, executes the scripted choice, and replays it",
    async (escalateOn) => {
      const server = await startFakeSystemOne({
        choiceWeights: Array.from({ length: 10 }, () => 1),
      });
      try {
        const config = {
          ...DEFAULT_CONFIG,
          provider: "systemone",
          sample: "argmax",
          escalateOn,
          minConf: 0.6,
          days: 1,
          ticksPerDay: 3,
        } as const;
        const provider = new SystemOneProvider({ ...config, endpoint: server.endpoint });
        const run = await new VillageSimulation(config, provider).runAllDays();
        const scripted = await new VillageSimulation(
          { ...config, provider: "scripted" },
          new ScriptedProvider(),
        ).runAllDays();
        const scriptedFirstTick = new Map(
          scripted.decisions.filter((d) => d.tick <= 0).map((d) => [d.question_id, d.action]),
        );
        const dawn = run.decisions.filter((d) => d.tick === -1);
        expect(dawn).toHaveLength(8);
        for (const decision of dawn) {
          expect(decision).toMatchObject({
            provider: "systemone",
            confidence: 0.25,
            escalated: true,
            action: scriptedFirstTick.get(decision.question_id),
          });
        }
        const firstTickEscalations = run.decisions.filter((d) => d.tick === 0 && d.escalated);
        expect(firstTickEscalations.length).toBeGreaterThan(0);
        for (const decision of firstTickEscalations) {
          expect(decision.action).toBe(scriptedFirstTick.get(decision.question_id));
        }
        const summary = run.summaries[0]!;
        const escalated = run.decisions.filter((d) => d.escalated).length;
        const percent = ((escalated / run.decisions.length) * 100).toFixed(1);
        expect(formatDaySummaryTable(summary)).toContain(`Escalated: ${escalated} (${percent}%)`);

        const parsed = parseJsonl(serializeJsonl(run.records));
        expect(parsed.header?.escalateOn).toBe(escalateOn);
        const replay = await new VillageSimulation(
          { ...config, provider: "replay", escalateOn: "sampled" },
          new ReplayProvider(parsed.decisions, parsed.header!.version),
        ).runAllDays();
        expect(replay.tickHashes).toEqual(run.tickHashes);
        expect(replay.decisions.map((d) => d.escalated)).toEqual(
          run.decisions.map((d) => d.escalated),
        );
      } finally {
        await server.close();
      }
    },
  );

  it("distinguishes a small lead from a concentrated distribution over four gated options", async () => {
    const server = await startFakeSystemOne({ choiceWeights: [0.6, 0.4] });
    try {
      const config = {
        ...DEFAULT_CONFIG,
        provider: "systemone",
        sample: "argmax",
        days: 1,
        ticksPerDay: 1,
      } as const;
      const provider = new SystemOneProvider({ ...config, endpoint: server.endpoint });
      const outcomes: boolean[] = [];
      for (const escalateOn of ["sampled", "margin", "entropy"] as const) {
        const snap = await new VillageSimulation({ ...config, escalateOn }, provider).stepTick();
        outcomes.push(snap.decisions[0]!.escalated);
      }
      expect(outcomes).toEqual([false, true, false]);
    } finally {
      await server.close();
    }
  });

  it("validates the configured escalation metric and defaults to margin", () => {
    expect(resolveConfig({}).escalateOn).toBe("margin");
    expect(
      resolveConfig({ env: configFromEnv({ DECISION_ESCALATE_ON: "sampled" }) }).escalateOn,
    ).toBe("sampled");
    expect(
      resolveConfig({ env: configFromEnv({ DECISION_ESCALATE_ON: "entropy" }) }).escalateOn,
    ).toBe("entropy");
    expect(() => configFromEnv({ DECISION_ESCALATE_ON: "unknown" })).toThrow(
      "DECISION_ESCALATE_ON",
    );
  });

  it("does not escalate a confident distribution under weighted sampling with the default margin metric", async () => {
    const server = await startFakeSystemOne({ choiceWeights: [0.96, 0.04] });
    try {
      const baseConfig = {
        ...DEFAULT_CONFIG,
        provider: "systemone",
        sample: "weighted",
        minConf: 0.34,
        days: 1,
        ticksPerDay: 8,
      } as const;
      const provider = new SystemOneProvider({ ...baseConfig, endpoint: server.endpoint });

      // Find a seed where weighted sampling draws a 4% tail branch under sampled escalation
      let sawTailDraw = false;
      for (let seed = 1; seed <= 30; seed++) {
        const marginRun = await new VillageSimulation(
          { ...baseConfig, seed },
          provider,
        ).runAllDays();
        const sampledRun = await new VillageSimulation(
          { ...baseConfig, seed, escalateOn: "sampled" },
          provider,
        ).runAllDays();

        const tailDecisions = marginRun.decisions.filter((d) => d.confidence < 0.1);
        if (tailDecisions.length > 0) {
          sawTailDraw = true;
          expect(tailDecisions.every((d) => d.escalated === false)).toBe(true);
          expect(sampledRun.decisions.some((d) => d.confidence < 0.1 && d.escalated)).toBe(true);
          break;
        }
      }
      expect(sawTailDraw).toBe(true);
    } finally {
      await server.close();
    }
  });
});
