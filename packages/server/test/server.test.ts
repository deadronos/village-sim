import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "@village/core";
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

describe("CLI and live backend server", () => {
  let server: LiveServerHandle | null = null;
  let tempDir: string | null = null;

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
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
});
