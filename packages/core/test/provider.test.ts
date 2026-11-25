import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIG,
  ReplayProvider,
  ScriptedProvider,
  SystemOneProvider,
  VillageSimulation,
  buildTickQuestion,
  configFromEnv,
  createInitialWorld,
  getEntityById,
  recordRumor,
  resolveConfig,
  type ChoiceQuestion,
  type Question,
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

  it.each([0.99, 5])(
    "derives choice and confidence from normalized probabilities when the provider claims %s",
    async (confidence) => {
      const provider = new SystemOneProvider({
        endpoint: DEFAULT_CONFIG.endpoint,
        model: DEFAULT_CONFIG.model,
        timeoutMs: 1000,
        batch: "never",
        fetchImpl: async () =>
          Response.json({
            answers: {
              act_anna: {
                choice: "rest",
                probabilities: { work: 9, rest: 1, invalid: 50 },
                confidence,
              },
            },
          }),
      });

      const result = await provider.decide(
        "",
        { act_anna: { type: "choice", instructions: "", criteria: { work: "", rest: "" } } },
        7,
      );
      expect(result.answers.act_anna).toEqual({
        type: "choice",
        choice: "work",
        probabilities: { work: 0.9, rest: 0.1 },
        confidence: 0.9,
      });
    },
  );

  it.each(["never", "always", "retry"] as const)(
    "counts only failed questions as fallback and replays mixed decisions (%s)",
    async (mode) => {
      const provider = new SystemOneProvider({
        endpoint: DEFAULT_CONFIG.endpoint,
        model: DEFAULT_CONFIG.model,
        timeoutMs: 1000,
        batch: mode === "retry" ? "auto" : mode,
        retryBaseMs: 0,
        fetchImpl: async (_url, init) => {
          const { questions } = JSON.parse(init?.body as string) as {
            questions: Record<string, Question>;
          };
          const ids = Object.keys(questions);
          if (
            (mode === "retry" && ids.length > 1) ||
            (mode !== "always" && ids[0]?.endsWith("_anna"))
          ) {
            return new Response(null, { status: 503 });
          }
          const answers = Object.fromEntries(
            Object.entries(questions).map(([id, question]) => {
              if (id.endsWith("_anna")) return [id, { probabilities: {} }];
              const keys = Object.keys(question.criteria);
              const choice = keys.includes("rest") ? "rest" : keys[0]!;
              return [id, { probabilities: { [choice]: 1 } }];
            }),
          );
          return Response.json({ answers });
        },
      });

      const question = { type: "choice", instructions: "", criteria: { rest: "" } } as const;
      const result = await provider.decide("", { act_anna: question, act_bram: question }, 7);
      expect(result.meta.fallbackUsed).toBe(true);
      expect(result.meta.fallbackQuestionIds).toEqual(["act_anna"]);
      expect(result.meta.provider).toBe("systemone");
      expect(Object.keys(result.answers)).toEqual(["act_bram"]);

      const config = { ...DEFAULT_CONFIG, provider: "systemone", days: 1, ticksPerDay: 3 } as const;
      const run = await new VillageSimulation(config, provider).runAllDays();
      for (const prefix of ["dawn", "act"]) {
        const action = prefix === "dawn" ? "rest" : "work";
        expect(
          run.decisions.find((decision) => decision.question_id === `${prefix}_anna`),
        ).toMatchObject({ fallback: true, provider: "scripted" });
        expect(
          run.decisions.find((decision) => decision.question_id === `${prefix}_bram`),
        ).toMatchObject({ provider: "systemone", action, probabilities: { [action]: 1 } });
      }
      const fallbacks = run.decisions.filter((decision) => decision.fallback);
      expect(fallbacks.every((decision) => decision.entity === "anna")).toBe(true);
      expect(run.summaries[0]?.fallbackDecisions).toBe(fallbacks.length);

      const replay = await new VillageSimulation(
        { ...config, provider: "replay" },
        new ReplayProvider(run.decisions),
      ).runAllDays();
      expect(replay.tickHashes).toEqual(run.tickHashes);
    },
  );

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

  it.each(["never", "always"] as const)(
    "recovers from transient failures and probes after a sustained outage (%s)",
    async (batch) => {
      let now = 0;
      let requests = 0;
      let response: "offline" | "unavailable" | "partial" | "healthy" = "offline";
      let holdResponse: Promise<void> | undefined;
      const warnings: string[] = [];
      const provider = new SystemOneProvider({
        endpoint: DEFAULT_CONFIG.endpoint,
        model: DEFAULT_CONFIG.model,
        timeoutMs: 1000,
        batch,
        retryBaseMs: 0,
        now: () => now,
        onWarning: (message) => warnings.push(message),
        fetchImpl: async (_url, init) => {
          requests += 1;
          if (response === "offline") throw new TypeError("fetch failed");
          if (response === "unavailable") return new Response(null, { status: 503 });
          if (holdResponse) await holdResponse;
          const { questions } = JSON.parse(init?.body as string) as {
            questions: Record<string, Question>;
          };
          const answers = Object.fromEntries(
            Object.keys(questions)
              .filter((id) => response !== "partial" || id === "act_bram")
              .map((id) => [id, { probabilities: { rest: 1 } }]),
          );
          return Response.json({ answers });
        },
      });
      const question = { type: "choice", instructions: "", criteria: { rest: "" } } as const;
      const decide = () => provider.decide("", { act_anna: question, act_bram: question }, 7);

      expect((await decide()).meta).toMatchObject({ provider: "scripted", fallbackUsed: true });
      expect(provider.isFallbackActive).toBe(true);
      expect(warnings).toHaveLength(0);
      response = "healthy";
      expect((await decide()).meta).toMatchObject({ provider: "systemone", fallbackUsed: false });
      expect(provider.isFallbackActive).toBe(false);

      response = "offline";
      await decide();
      await decide();
      expect(provider.isFallbackActive).toBe(true);
      expect(warnings).toHaveLength(0);
      response = "partial";
      expect((await decide()).meta).toMatchObject({
        provider: "systemone",
        fallbackUsed: true,
        fallbackQuestionIds: ["act_anna"],
      });
      expect(provider.isFallbackActive).toBe(false);

      response = "unavailable";
      await decide();
      await decide();
      expect(provider.isFallbackActive).toBe(true);
      expect(warnings).toHaveLength(0);
      expect((await decide()).meta).toMatchObject({ provider: "scripted", fallbackUsed: true });
      expect(provider.isFallbackActive).toBe(true);
      expect(warnings).toHaveLength(1);

      const requestsAtOutage = requests;
      now += 4_999;
      expect((await decide()).meta).toMatchObject({ provider: "scripted", fallbackUsed: true });
      expect(requests).toBe(requestsAtOutage);
      now += 1;
      expect((await decide()).meta).toMatchObject({ provider: "scripted", fallbackUsed: true });
      expect(requests).toBeGreaterThan(requestsAtOutage);
      expect(provider.isFallbackActive).toBe(true);
      expect(warnings).toHaveLength(1);

      const requestsAtFailedProbe = requests;
      response = "healthy";
      now += 4_999;
      await decide();
      expect(requests).toBe(requestsAtFailedProbe);
      now += 1;
      const probeGate = Promise.withResolvers<void>();
      holdResponse = probeGate.promise;
      const probe = decide();
      const requestsAtProbe = requests;
      const concurrent = decide();
      const requestsDuringProbe = requests;
      probeGate.resolve();
      expect((await concurrent).meta).toMatchObject({ provider: "scripted", fallbackUsed: true });
      expect(requestsDuringProbe).toBe(requestsAtProbe);
      expect((await probe).meta).toMatchObject({ provider: "systemone", fallbackUsed: false });
      expect(provider.isFallbackActive).toBe(false);
    },
  );

  it("tracks rolling partial degradation without activating full fallback when only 1 of 3 questions is answered", async () => {
    let mode: "partial" | "healthy" = "partial";
    const warnings: string[] = [];
    const provider = new SystemOneProvider({
      endpoint: DEFAULT_CONFIG.endpoint,
      model: DEFAULT_CONFIG.model,
      timeoutMs: 1000,
      batch: "always",
      retryBaseMs: 0,
      onWarning: (msg) => warnings.push(msg),
      fetchImpl: async (_url, init) => {
        const { questions } = JSON.parse(init?.body as string) as {
          questions: Record<string, Question>;
        };
        const answers = Object.fromEntries(
          Object.keys(questions)
            .filter((id) => mode === "healthy" || id === "act_bram")
            .map((id) => [id, { probabilities: { rest: 1 } }]),
        );
        return Response.json({ answers });
      },
    });

    const question = { type: "choice", instructions: "", criteria: { rest: "" } } as const;
    const batch = { act_anna: question, act_bram: question, act_cora: question };

    expect(provider.isDegraded).toBe(false);
    expect(provider.partialFallbackRate).toBe(0);

    for (let i = 0; i < 4; i++) {
      const res = await provider.decide("", batch, 7);
      expect(res.meta.provider).toBe("systemone");
      expect(res.meta.fallbackQuestionIds).toEqual(["act_anna", "act_cora"]);
      expect(provider.isFallbackActive).toBe(false);
      expect(provider.isDegraded).toBe(true);
      expect(provider.partialFallbackRate).toBeCloseTo(2 / 3, 5);
    }

    // Emits a single degraded warning once the consecutive partial sweep threshold is reached
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("degraded");

    // Recovers once the rolling window of 10 sweeps clears with healthy responses
    mode = "healthy";
    for (let i = 0; i < 10; i++) {
      await provider.decide("", batch, 7);
    }
    expect(provider.isFallbackActive).toBe(false);
    expect(provider.isDegraded).toBe(false);
    expect(provider.partialFallbackRate).toBe(0);
  });

  it("continues the simulation with a warning if the endpoint stays unreachable", async () => {
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

  it("preserves scriptedInstructions across clone/JSON boundaries and strips it on the HTTP wire (#35)", async () => {
    const world = createInitialWorld(DEFAULT_CONFIG);
    const anna = getEntityById(world, "anna")!;
    recordRumor(anna, {
      id: "shortage:1:dorn:wheat",
      kind: "shortage",
      subjectId: "dorn",
      summary: "dorn is short on wheat",
      day: 1,
      tick: 0,
    });
    // Make the rumor stale so model instructions omit it while scriptedInstructions retains it
    world.day = 5;

    const original = buildTickQuestion(world, anna, { work: "bake bread", rest: "rest" }, 0);
    expect(original.instructions).not.toContain("Heard:");
    expect(original.scriptedInstructions).toContain("Heard: dorn is short on wheat.");

    const structuredCloned = structuredClone(original);
    const jsonRoundTripped = JSON.parse(JSON.stringify(original)) as ChoiceQuestion;
    const spreadCopied: ChoiceQuestion = { ...original };

    expect(structuredCloned.scriptedInstructions).toBe(original.scriptedInstructions);
    expect(jsonRoundTripped.scriptedInstructions).toBe(original.scriptedInstructions);
    expect(spreadCopied.scriptedInstructions).toBe(original.scriptedInstructions);

    const scripted = new ScriptedProvider();
    const baseDecision = await scripted.decide("", { act_anna: original }, 7);
    const clonedDecision = await scripted.decide("", { act_anna: structuredCloned }, 7);
    const jsonDecision = await scripted.decide("", { act_anna: jsonRoundTripped }, 7);
    expect(clonedDecision.answers.act_anna).toEqual(baseDecision.answers.act_anna);
    expect(jsonDecision.answers.act_anna).toEqual(baseDecision.answers.act_anna);

    // SystemOneProvider strips scriptedInstructions before serializing to the HTTP wire
    let capturedWireBody: string | undefined;
    const systemOne = new SystemOneProvider({
      endpoint: DEFAULT_CONFIG.endpoint,
      model: DEFAULT_CONFIG.model,
      timeoutMs: 1000,
      batch: "never",
      fetchImpl: async (_url, init) => {
        capturedWireBody = init?.body as string;
        return Response.json({ answers: { act_anna: { probabilities: { work: 1 } } } });
      },
    });
    await systemOne.decide("Day 5", { act_anna: original }, 7);
    expect(capturedWireBody).toBeDefined();
    const parsedWire = JSON.parse(capturedWireBody!) as {
      questions: Record<string, Record<string, unknown>>;
    };
    expect(parsedWire.questions.act_anna).not.toHaveProperty("scriptedInstructions");
    expect(parsedWire.questions.act_anna?.instructions).toBe(original.instructions);
  });
});
