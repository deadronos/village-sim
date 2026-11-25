import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CONFIG,
  ScriptedProvider,
  VillageSimulation,
  parseJsonl,
  serializeJsonl,
  type JsonlRecord,
} from "@village/core";
import {
  DEFAULT_LIVE_TICK_MS,
  DEFAULT_SYSTEMONE_TICK_MS,
  LiveSimManager,
  buildResolvedConfig,
  getInvocationCwd,
  loadDotEnv,
  resolveEffectiveEnv,
  resolveFromInvocationCwd,
  runCli,
  startVillageServer,
  type LiveServerHandle,
  type StreamMessage,
} from "../src/index.ts";

const scriptedEventFixture = fileURLToPath(
  new URL("./fixtures/scripted-events.jsonl", import.meta.url),
);

function readScriptedEventFixture(): JsonlRecord[] {
  return readFileSync(scriptedEventFixture, "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as JsonlRecord);
}

describe("CLI and live backend server", () => {
  let server: LiveServerHandle | null = null;
  let tempDir: string | null = null;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (server) {
      await server.close();
      server = null;
    }
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("verifies the ordered events and hashes of the golden scripted run", async () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await runCli(["replay", scriptedEventFixture])).toBe(0);
    expect(output).toHaveBeenCalledWith("Replay verified (14 ticks across 2 day(s)).");
    expect(output).toHaveBeenCalledWith("Event sequence verified (103 events).");
  });

  it("replays event times from a run with a configured start hour", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "village-sim-start-hour-"));
    const config = join(tempDir, "village.config.json");
    const out = join(tempDir, "run.jsonl");
    writeFileSync(
      config,
      JSON.stringify({ provider: "scripted", startHour: 7, days: 1, ticksPerDay: 2 }),
      "utf8",
    );

    expect(
      await runCli(["run", "--provider", "scripted", "--config", config, "--out", out, "--quiet"]),
    ).toBe(0);
    expect(await runCli(["replay", out, "--quiet"])).toBe(0);
  });

  it("reconstructs live replay prompts with the saved rumor age limit", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "village-sim-rumor-replay-"));
    const config = { ...DEFAULT_CONFIG, days: 2, ticksPerDay: 7, rumorMaxAgeDays: 0 };
    const run = await new VillageSimulation(config, new ScriptedProvider()).runAllDays();
    writeFileSync(join(tempDir, "run.jsonl"), serializeJsonl(run.records), "utf8");
    const manager = new LiveSimManager(DEFAULT_CONFIG, { runsDir: tempDir });
    manager.startReplay("run.jsonl");
    manager.pause();
    for (let tick = 0; tick <= config.ticksPerDay; tick++) await manager.stepOnce();

    const isSecondDawn = (record: (typeof run.decisions)[number]) =>
      record.day === 2 && record.question_id === "dawn_anna";
    const original = run.decisions.find(isSecondDawn)!;
    const replayed = manager.getDecisions().find(isSecondDawn)!;
    expect(replayed.instructions).toBe(original.instructions);
    expect(replayed.instructions).not.toContain("Unverified rumor (day 1,");
  });

  it("reports the first changed trade even when all saved hashes match", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "village-sim-event-replay-"));
    const path = join(tempDir, "trade-price.jsonl");
    const records = readScriptedEventFixture();
    const trade = records.find(
      (record) => record.recordType === "event" && record.kind === "trade" && record.day === 2,
    );
    if (!trade || trade.recordType !== "event")
      throw new Error("Fixture is missing its day-two trade");
    trade.gold = trade.gold! + 1;
    trade.message = trade.message.replace("6g", "7g");
    writeFileSync(path, serializeJsonl(records), "utf8");

    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await runCli(["replay", path, "--quiet"])).toBe(1);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("first divergence: day 2 07:30 trade torin→cora (tick 6)"),
    );
    expect(error.mock.calls[0]?.[0]).toContain("for 7g");
    expect(error.mock.calls[0]?.[0]).toContain("for 6g");
  });

  it("detects missing event records and still verifies hashes in older logs", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "village-sim-legacy-replay-"));
    const path = join(tempDir, "run.jsonl");
    const records = readScriptedEventFixture().filter((record) => record.recordType !== "event");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    writeFileSync(path, serializeJsonl(records), "utf8");
    expect(await runCli(["replay", path, "--quiet"])).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("expected: (end of events)"));

    const header = records.find((record) => record.recordType === "header")!;
    delete header.eventsRecorded;
    writeFileSync(path, serializeJsonl(records), "utf8");
    expect(await runCli(["replay", path, "--quiet"])).toBe(0);

    const tick = records.find((record) => record.recordType === "tick")!;
    tick.state_hash = "changed";
    writeFileSync(path, serializeJsonl(records), "utf8");
    expect(await runCli(["replay", path, "--quiet"])).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("REPLAY MISMATCH at tick index 0"));
  });

  it("runs CLI run -> replay -> explain end-to-end with exact hash verification", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "village-sim-cli-"));
    const outFile = join(tempDir, "seed-7.jsonl");

    const runCode = await runCli([
      "run",
      "--seed",
      "7",
      "--days",
      "2",
      "--provider",
      "scripted",
      "--out",
      outFile,
      "--quiet",
    ]);
    expect(runCode).toBe(0);

    const replayCode = await runCli(["replay", outFile, "--quiet"]);
    expect(replayCode).toBe(0);

    const explainCode = await runCli(["explain", "--run", outFile, "--entity", "anna"]);
    expect(explainCode).toBe(0);
  });

  it("serves live simulation state, step control, and explain API over HTTP", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "village-sim-srv-"));
    server = await startVillageServer({
      port: 0,
      config: { ...DEFAULT_CONFIG, seed: 7, days: 2 },
      autostart: false,
      runsDir: tempDir,
    });

    const addr = server.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const base = `http://127.0.0.1:${port}`;

    const stateRes = await fetch(`${base}/api/state`);
    expect(stateRes.ok).toBe(true);
    const stateJson = (await stateRes.json()) as {
      places: unknown[];
      edges: unknown[];
      snapshot: { day: number; tick: number };
    };
    expect(stateJson.places.length).toBe(16);
    expect(stateJson.edges.length).toBeGreaterThan(20);
    expect(stateJson.snapshot.day).toBe(1);

    const stepRes = await fetch(`${base}/api/control/step`, { method: "POST" });
    expect(stepRes.ok).toBe(true);

    const explainRes = await fetch(`${base}/api/explain/anna`);
    expect(explainRes.ok).toBe(true);
    const explainJson = (await explainRes.json()) as { report: string };
    expect(explainJson.report).toContain("anna");
  });

  it("adapts default live tick pacing for systemone vs scripted providers", () => {
    tempDir = mkdtempSync(join(tmpdir(), "village-sim-pace-"));
    const scriptedMgr = new LiveSimManager(
      { ...DEFAULT_CONFIG, provider: "scripted" },
      { runsDir: tempDir },
    );
    expect(scriptedMgr.getStatus().tickMs).toBe(DEFAULT_LIVE_TICK_MS);
    expect(scriptedMgr.getStatus().effectiveTickMs).toBe(DEFAULT_LIVE_TICK_MS);

    // Switching provider via reset adapts default tick interval when user hasn't pinned speed
    scriptedMgr.reset({ provider: "systemone" });
    expect(scriptedMgr.getStatus().tickMs).toBe(DEFAULT_SYSTEMONE_TICK_MS);
    expect(scriptedMgr.getStatus().effectiveTickMs).toBe(DEFAULT_SYSTEMONE_TICK_MS);

    // Explicit setSpeed pins tickMs across resets
    scriptedMgr.setSpeed(1500);
    scriptedMgr.reset({ provider: "scripted" });
    expect(scriptedMgr.getStatus().tickMs).toBe(1500);
  });

  it("publishes actual provider fallback in live stream status", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "village-sim-fallback-"));
    const manager = new LiveSimManager(
      {
        ...DEFAULT_CONFIG,
        provider: "systemone",
        endpoint: "http://127.0.0.1:1/v1/systemone",
        batch: "never",
        timeoutMs: 100,
      },
      { runsDir: tempDir },
    );
    const messages: StreamMessage[] = [];
    const unsubscribe = manager.subscribe((msg) => messages.push(msg));
    try {
      expect(manager.getStatus().fallbackActive).toBe(false);
      await manager.stepOnce();
      expect(manager.getStatus().fallbackActive).toBe(true);
      expect(manager.getStatus().warnings).toHaveLength(0);
      await manager.stepOnce();
      expect(manager.getStatus().fallbackActive).toBe(true);
      expect(manager.getStatus().warnings).toHaveLength(1);
      expect(messages.findLast((msg) => msg.type === "tick")?.status.fallbackActive).toBe(true);
      manager.reset({ provider: "scripted" });
      expect(messages.at(-1)).toMatchObject({ type: "reset", status: { fallbackActive: false } });
    } finally {
      unsubscribe();
    }
  });

  it("isolates a reset from the previous simulation's in-flight fallback", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "village-sim-reset-"));
    const manager = new LiveSimManager(
      {
        ...DEFAULT_CONFIG,
        provider: "systemone",
        endpoint: "http://127.0.0.1:1/v1/systemone",
        batch: "never",
        timeoutMs: 100,
      },
      { runsDir: tempDir },
    );
    await manager.stepOnce();

    const messages: StreamMessage[] = [];
    const unsubscribe = manager.subscribe((msg) => messages.push(msg));
    try {
      const outdatedTick = manager.stepOnce();
      manager.reset({ provider: "scripted", seed: 123 });
      const [outdated, current] = await Promise.all([outdatedTick, manager.stepOnce()]);

      expect(outdated).toBeNull();
      expect(current).not.toBeNull();
      expect(messages.map((msg) => msg.type)).toEqual(["reset", "tick"]);
      expect(manager.getFullState()).toMatchObject({
        snapshot: { stateHash: current?.stateHash },
        status: { config: { seed: 123 }, fallbackActive: false, warnings: [] },
      });
    } finally {
      unsubscribe();
    }
  });

  it("resolves default and relative CLI paths against INIT_CWD without doubling workspace dirs", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "village-sim-init-cwd-"));
    const prevInitCwd = process.env.INIT_CWD;
    process.env.INIT_CWD = tempDir;

    try {
      expect(getInvocationCwd()).toBe(tempDir);
      expect(resolveFromInvocationCwd("runs/seed-7.jsonl")).toBe(
        resolve(tempDir, "runs/seed-7.jsonl"),
      );
      expect(resolveFromInvocationCwd("packages/server/runs/seed-7.jsonl")).toBe(
        resolve(tempDir, "packages/server/runs/seed-7.jsonl"),
      );

      const absPath = resolve(tempDir, "abs/custom.jsonl");
      expect(resolveFromInvocationCwd(absPath)).toBe(absPath);

      const runCode = await runCli([
        "run",
        "--seed",
        "7",
        "--days",
        "1",
        "--provider",
        "scripted",
        "--quiet",
      ]);
      expect(runCode).toBe(0);
      expect(existsSync(join(tempDir, "runs", "seed-7.jsonl"))).toBe(true);

      const replayCode = await runCli(["replay", "runs/seed-7.jsonl", "--quiet"]);
      expect(replayCode).toBe(0);

      const explainCode = await runCli([
        "explain",
        "--run",
        "runs/seed-7.jsonl",
        "--entity",
        "anna",
      ]);
      expect(explainCode).toBe(0);
    } finally {
      if (prevInitCwd === undefined) {
        delete process.env.INIT_CWD;
      } else {
        process.env.INIT_CWD = prevInitCwd;
      }
    }
  });

  it("loads .env and .env.local with precedence CLI > shell env > .env.local > .env > config file > defaults", () => {
    tempDir = mkdtempSync(join(tmpdir(), "village-sim-dotenv-"));
    writeFileSync(
      join(tempDir, "village.config.json"),
      JSON.stringify({
        provider: "scripted",
        model: "from-json",
        maxBatch: 5,
      }),
      "utf8",
    );
    writeFileSync(
      join(tempDir, ".env"),
      [
        "DECISION_PROVIDER=systemone",
        "DECISION_ENDPOINT=http://127.0.0.1:8009/v1/systemone",
        "DECISION_MODEL=from-dotenv",
        "DECISION_MAX_BATCH=4",
        "PORT=4200",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(tempDir, ".env.local"),
      ["DECISION_MODEL=from-dotenv-local", "PORT=4201"].join("\n"),
      "utf8",
    );

    const baseEnv = { INIT_CWD: tempDir };
    const effective = resolveEffectiveEnv(baseEnv);
    expect(effective.PORT).toBe("4201");
    expect(effective.DECISION_PROVIDER).toBe("systemone");

    // .env.local overrides .env, .env overrides village.config.json
    const fromFiles = buildResolvedConfig({}, baseEnv);
    expect(fromFiles.provider).toBe("systemone");
    expect(fromFiles.endpoint).toBe("http://127.0.0.1:8009/v1/systemone");
    expect(fromFiles.model).toBe("from-dotenv-local");
    expect(fromFiles.maxBatch).toBe(4);

    // Shell env overrides .env and .env.local
    const fromShell = buildResolvedConfig(
      {},
      { INIT_CWD: tempDir, DECISION_MODEL: "from-shell", PORT: "4300" },
    );
    expect(fromShell.model).toBe("from-shell");
    expect(resolveEffectiveEnv({ INIT_CWD: tempDir, PORT: "4300" }).PORT).toBe("4300");

    // CLI flags override shell env and .env files
    const fromCli = buildResolvedConfig(
      { provider: "scripted", model: "from-cli" },
      { INIT_CWD: tempDir, DECISION_MODEL: "from-shell" },
    );
    expect(fromCli.provider).toBe("scripted");
    expect(fromCli.model).toBe("from-cli");
  });

  it("discovers workspace-root .env when invoked from a nested package directory", () => {
    tempDir = mkdtempSync(join(tmpdir(), "village-sim-ws-dotenv-"));
    const nestedDir = join(tempDir, "packages", "server");
    mkdirSync(nestedDir, { recursive: true });
    writeFileSync(join(tempDir, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n", "utf8");
    writeFileSync(
      join(tempDir, ".env"),
      "DECISION_PROVIDER=systemone\nDECISION_MODEL=ws-root-model\n",
      "utf8",
    );

    const loaded = loadDotEnv({ INIT_CWD: nestedDir });
    expect(loaded.DECISION_PROVIDER).toBe("systemone");
    expect(loaded.DECISION_MODEL).toBe("ws-root-model");
  });

  it("fails fast on unreachable System One endpoint unless --allow-degraded is passed, and records startup health in the header", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "village-sim-health-"));
    const failedOut = join(tempDir, "failed.jsonl");
    const degradedOut = join(tempDir, "degraded.jsonl");
    const healthyOut = join(tempDir, "healthy.jsonl");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Without --allow-degraded, CLI refuses to start and writes no log
    const failCode = await runCli([
      "run",
      "--provider",
      "systemone",
      "--endpoint",
      "http://127.0.0.1:1/v1/systemone",
      "--days",
      "1",
      "--out",
      failedOut,
      "--quiet",
    ]);
    expect(failCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("http://127.0.0.1:1/v1/systemone"),
    );
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("--allow-degraded"));
    expect(existsSync(failedOut)).toBe(false);

    // With --allow-degraded, CLI warns, starts immediately in scripted fallback, and records probe in header
    const degradedCode = await runCli([
      "run",
      "--provider",
      "systemone",
      "--endpoint",
      "http://127.0.0.1:1/v1/systemone",
      "--days",
      "1",
      "--out",
      degradedOut,
      "--allow-degraded",
      "--quiet",
    ]);
    expect(degradedCode).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("--allow-degraded"));
    const degradedParsed = parseJsonl(readFileSync(degradedOut, "utf8"));
    expect(degradedParsed.header?.startupHealth?.ok).toBe(false);
    expect(degradedParsed.header?.initialFallbackActive).toBe(true);

    // Against a healthy endpoint, CLI records ok startupHealth and initialFallbackActive=false
    const mockEndpoint: Server = createServer((req, res) => {
      if (req.url === "/v1/models") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "kev-latest" }] }));
        return;
      }
      let raw = "";
      req.on("data", (chunk) => {
        raw += String(chunk);
      });
      req.on("end", () => {
        const body = JSON.parse(raw) as {
          questions: Record<string, { criteria: Record<string, string> }>;
        };
        const answers = Object.fromEntries(
          Object.entries(body.questions).map(([id, q]) => {
            const first = Object.keys(q.criteria)[0]!;
            return [id, { probabilities: { [first]: 1 } }];
          }),
        );
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ answers }));
      });
    });

    await new Promise<void>((r) => mockEndpoint.listen(0, "127.0.0.1", () => r()));
    const addr = mockEndpoint.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    try {
      const healthyCode = await runCli([
        "run",
        "--provider",
        "systemone",
        "--endpoint",
        `http://127.0.0.1:${port}/v1/systemone`,
        "--days",
        "1",
        "--out",
        healthyOut,
        "--quiet",
      ]);
      expect(healthyCode).toBe(0);
      const healthyParsed = parseJsonl(readFileSync(healthyOut, "utf8"));
      expect(healthyParsed.header?.startupHealth).toEqual({ ok: true, status: 200 });
      expect(healthyParsed.header?.initialFallbackActive).toBe(false);
    } finally {
      await new Promise<void>((r) => mockEndpoint.close(() => r()));
    }
  });

  it("exposes partial provider degradation in LiveSimManager status while keeping fallbackActive false", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "village-sim-degraded-"));
    const partialEndpoint: Server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => {
        raw += String(chunk);
      });
      req.on("end", () => {
        const body = JSON.parse(raw) as {
          questions: Record<string, { criteria: Record<string, string> }>;
        };
        const firstEntry = Object.entries(body.questions)[0];
        const answers: Record<string, unknown> = {};
        if (firstEntry) {
          const [id, q] = firstEntry;
          const firstAction = Object.keys(q.criteria)[0]!;
          answers[id] = { probabilities: { [firstAction]: 1 } };
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ answers }));
      });
    });

    await new Promise<void>((r) => partialEndpoint.listen(0, "127.0.0.1", () => r()));
    const addr = partialEndpoint.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    try {
      const manager = new LiveSimManager(
        {
          ...DEFAULT_CONFIG,
          provider: "systemone",
          endpoint: `http://127.0.0.1:${port}/v1/systemone`,
          batch: "always",
          timeoutMs: 2000,
        },
        { runsDir: tempDir },
      );

      await manager.stepOnce();
      await manager.stepOnce();
      const status = manager.getStatus();
      expect(status.fallbackActive).toBe(false);
      expect(status.degraded).toBe(true);
      expect(status.partialFallbackRate).toBeGreaterThan(0.5);
      expect(status.warnings.length).toBeGreaterThanOrEqual(1);
    } finally {
      await new Promise<void>((r) => partialEndpoint.close(() => r()));
    }
  });
});
