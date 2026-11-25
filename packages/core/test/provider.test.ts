import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIG,
  SystemOneProvider,
  VillageSimulation,
  configFromEnv,
  resolveConfig,
} from "../src/index.ts";
import { startFakeSystemOne, type FakeSystemOneHandle } from "./fake_systemone.ts";

describe("System One provider contract, batching, resilience, and config (A2, A5)", () => {
  let server: FakeSystemOneHandle | null = null;

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
  });

  it("passes health check and answers >=95% of decisions in a full day run (A2)", async () => {
    server = await startFakeSystemOne({ authToken: "secret-key", latencyMs: 12 });
    const provider = new SystemOneProvider({
      endpoint: server.endpoint,
      model: "kev-latest",
      timeoutMs: 5000,
      batch: "auto",
      apiKey: "secret-key",
      retryBaseMs: 5,
    });

    const health = await provider.checkHealth();
    expect(health.ok).toBe(true);

    const sim = new VillageSimulation(
      { ...DEFAULT_CONFIG, provider: "systemone", endpoint: server.endpoint, days: 1, seed: 7 },
      provider,
    );
    const result = await sim.runAllDays();
    const day1 = result.summaries[0]!;

    expect(day1.fallbackRate).toBeLessThan(0.05);
    expect(day1.p95LatencyMs).toBeLessThan(2000);
    expect(day1.providerCalls).toBeGreaterThan(10);
    // Verify batching actually sent multi-question calls
    expect(server.calls.some((c) => c.questionCount >= 2)).toBe(true);
    // Verify bearer token was transmitted
    expect(server.calls.every((c) => c.auth === "Bearer secret-key")).toBe(true);
  });

  it("retries per-entity when a batched call returns HTTP 500", async () => {
    server = await startFakeSystemOne({ failNextBatchWith500: 1 });
    const provider = new SystemOneProvider({
      endpoint: server.endpoint,
      model: "kev-latest",
      timeoutMs: 5000,
      batch: "auto",
      retryBaseMs: 5,
    });

    const sim = new VillageSimulation(
      { ...DEFAULT_CONFIG, provider: "systemone", endpoint: server.endpoint, days: 1, seed: 3 },
      provider,
    );
    await sim.stepTick();

    // First batched dawn call failed with 500, followed by per-entity retries (qCount === 1)
    expect(server.calls[0]?.questionCount).toBe(8);
    expect(server.calls.slice(1, 9).every((c) => c.questionCount === 1)).toBe(true);
    expect(provider.isFallbackActive).toBe(false);
  });

  it("handles a malformed answer for one entity via escalation/fallback without crashing", async () => {
    server = await startFakeSystemOne({ malformedQuestionId: "act_anna" });
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
    const snap = await sim.stepTick();
    const annaDecision = snap.decisions.find((d) => d.question_id === "act_anna");
    expect(annaDecision).toBeDefined();
    expect(annaDecision?.provider).toBe("scripted");
    expect(annaDecision?.fallback).toBe(true);
  });

  it("switches permanently to scripted with a warning if endpoint is unreachable", async () => {
    const warnings: string[] = [];
    const provider = new SystemOneProvider({
      endpoint: "http://127.0.0.1:1/v1/systemone",
      model: "kev-latest",
      timeoutMs: 1000,
      batch: "auto",
      retryBaseMs: 1,
      onWarning: (msg) => warnings.push(msg),
    });

    const sim = new VillageSimulation(
      { ...DEFAULT_CONFIG, provider: "systemone", days: 1, seed: 7 },
      provider,
    );
    const res = await sim.runAllDays();
    expect(provider.isFallbackActive).toBe(true);
    expect(warnings.length).toBe(1);
    expect(res.summaries[0]?.trades).toBeGreaterThanOrEqual(8);
  });

  it("enforces config precedence CLI > env > file > defaults and swaps provider via env alone (A5)", () => {
    const env = configFromEnv({
      DECISION_PROVIDER: "systemone",
      DECISION_ENDPOINT: "http://10.0.0.5:8009/v1/systemone",
      DECISION_MODEL: "jev-v2",
      DECISION_BATCH: "always",
      DECISION_SAMPLE: "argmax",
      DECISION_MIN_CONF: "0.42",
      DECISION_TIMEOUT_MS: "45000",
      DECISION_API_KEY: "tok-123",
    });

    const resolved = resolveConfig({
      file: { provider: "scripted", model: "file-model", minConf: 0.25 },
      env,
      cli: { model: "cli-model" },
    });

    expect(resolved.provider).toBe("systemone");
    expect(resolved.endpoint).toBe("http://10.0.0.5:8009/v1/systemone");
    expect(resolved.model).toBe("cli-model");
    expect(resolved.batch).toBe("always");
    expect(resolved.sample).toBe("argmax");
    expect(resolved.minConf).toBe(0.42);
    expect(resolved.timeoutMs).toBe(45000);
    expect(resolved.apiKey).toBe("tok-123");
  });
});
