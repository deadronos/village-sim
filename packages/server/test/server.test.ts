import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "@village/core";
import {
  getInvocationCwd,
  resolveFromInvocationCwd,
  runCli,
  startVillageServer,
  type LiveServerHandle,
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
});
