#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  DEFAULT_CONFIG,
  ReplayProvider,
  SystemOneProvider,
  VillageSimulation,
  explainLastDecision,
  formatDaySummaryTable,
  formatExplainReport,
  parseJsonl,
  serializeJsonl,
  type EventLogRecord,
  type SimEvent,
  type StartupHealthProbe,
} from "@village/core";
import {
  buildResolvedConfig,
  createProviderForConfig,
  getInvocationCwd,
  parseCliArgs,
  resolveEffectiveEnv,
  resolveFromInvocationCwd,
} from "./config-loader.ts";
import { startVillageServer } from "./server.ts";

function printHelp(): void {
  console.log(`
village — Autonomous village that thinks on a timer

Usage:
  village run [options]
  village replay <path/to/run.jsonl> [--quiet]
  village explain --run <path/to/run.jsonl> --entity <id>
  village serve [--port 4173] [--tick-ms 850] [--seed 7] [--days 7]

Options (CLI > env > .env > village.config.json > defaults):
  --seed <n>            PRNG seed (default: ${DEFAULT_CONFIG.seed})
  --days <n>            Simulated days (default: ${DEFAULT_CONFIG.days})
  --provider <kind>     scripted | systemone | replay (env: DECISION_PROVIDER)
  --endpoint <url>      System One endpoint (env: DECISION_ENDPOINT)
  --model <name>        Model alias (env: DECISION_MODEL)
  --batch <mode>        auto | always | never (env: DECISION_BATCH)
  --max-batch <n>       Max entities decided per tick (env: DECISION_MAX_BATCH, default: ${DEFAULT_CONFIG.maxBatch})
  --sample <mode>       weighted | argmax (env: DECISION_SAMPLE)
  --escalate-on <mode>  sampled | margin | entropy (env: DECISION_ESCALATE_ON)
  --min-conf <0..1>     Escalation threshold (env: DECISION_MIN_CONF)
  --timeout-ms <ms>     Request timeout (env: DECISION_TIMEOUT_MS)
  --api-key <token>     Optional bearer token (env: DECISION_API_KEY)
  --out <path>          JSONL output path (default: runs/seed-<seed>.jsonl, relative to cwd)
  --explain <entity>    Print explain report for entity after run
  --allow-degraded      Continue in scripted fallback mode if System One health check fails
  --quiet               Suppress per-event timeline output (JSONL still written)
`);
}

async function cmdRun(flags: Record<string, string | boolean>): Promise<number> {
  const config = buildResolvedConfig(flags);
  const provider = createProviderForConfig(config);
  const quiet = Boolean(config.quiet);
  let startupHealth: StartupHealthProbe | undefined;

  if (provider instanceof SystemOneProvider) {
    startupHealth = await provider.checkHealth(3000);
    if (!startupHealth.ok) {
      const detail =
        startupHealth.status !== undefined
          ? `HTTP ${startupHealth.status}`
          : (startupHealth.error ?? "unreachable");
      const allowDegraded = flags["allow-degraded"] === true || flags["allow-degraded"] === "true";
      if (!allowDegraded) {
        console.error(
          `[village] ERROR: System One health check failed for ${config.endpoint} (${detail}).\n` +
            `Start the System One server, switch to --provider scripted, or pass --allow-degraded to run in scripted fallback mode.`,
        );
        return 1;
      }
      console.warn(
        `[village] WARNING: System One health check failed for ${config.endpoint} (${detail}). ` +
          `Continuing in scripted fallback mode (--allow-degraded).`,
      );
      provider.activateFallback();
    }
  }

  const sim = new VillageSimulation(config, provider, {
    startupHealth,
    onEvent: (ev) => {
      if (!quiet && ev.kind !== "move") {
        console.log(ev.message);
      }
    },
    onDayEnd: (summary) => {
      if (!quiet) {
        console.log(formatDaySummaryTable(summary));
      }
    },
  });

  const result = await sim.runAllDays();

  const outPath =
    typeof flags.out === "string"
      ? resolveFromInvocationCwd(flags.out)
      : resolveFromInvocationCwd(join("runs", `seed-${config.seed}.jsonl`));

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, serializeJsonl(result.records), "utf8");

  if (!quiet) {
    console.log(`\nWrote JSONL log to ${outPath}`);
    console.log(`Final state hash: ${result.finalStateHash}`);
  }

  if (typeof flags.explain === "string") {
    const rec = explainLastDecision(result.decisions, flags.explain);
    if (!rec) {
      console.error(`No decision found for entity "${flags.explain}".`);
      return 1;
    }
    console.log(`\n${formatExplainReport(rec)}`);
  }

  return 0;
}

function firstEventDivergence(
  expected: readonly EventLogRecord[],
  actual: readonly SimEvent[],
): string | undefined {
  for (let i = 0; i < Math.max(expected.length, actual.length); i++) {
    const before = expected[i];
    const event = actual[i];
    // Compare the exact JSON representation, including payloads but ignoring key order.
    const after = event ? JSON.stringify({ ...event, recordType: "event" }) : undefined;
    if (before && after && isDeepStrictEqual(before, JSON.parse(after))) continue;

    const context = (before ?? event)!;
    const entities = [context.entityId, context.otherEntityId].filter(Boolean).join("→");
    const location = entities || context.place;
    return [
      `first divergence: day ${context.day} ${context.time} ${context.kind}${location ? ` ${location}` : ""} (tick ${context.tick})`,
      `  expected: ${before ? JSON.stringify(before) : "(end of events)"}`,
      `  actual:   ${after ?? "(end of events)"}`,
    ].join("\n");
  }
}

async function cmdReplay(
  positional: string[],
  flags: Record<string, string | boolean>,
): Promise<number> {
  const filePath = positional[0] ?? (typeof flags.run === "string" ? flags.run : undefined);
  if (!filePath) {
    console.error("Usage: village replay <path/to/decisions.jsonl>");
    return 1;
  }

  const raw = readFileSync(resolveFromInvocationCwd(filePath), "utf8");
  const parsed = parseJsonl(raw);
  if (!parsed.header) {
    console.error(`Missing header record in ${filePath}`);
    return 1;
  }

  const quiet = flags.quiet === true || flags.quiet === "true";
  const sim = new VillageSimulation(
    {
      ...DEFAULT_CONFIG,
      seed: parsed.header.seed,
      days: parsed.header.days,
      sample: parsed.header.sample,
      escalateOn: parsed.header.escalateOn ?? DEFAULT_CONFIG.escalateOn,
      minConf: parsed.header.minConf,
      rumorMaxAgeDays: parsed.header.rumorMaxAgeDays ?? DEFAULT_CONFIG.rumorMaxAgeDays,
      maxBatch: parsed.header.maxBatch ?? DEFAULT_CONFIG.maxBatch,
      ticksPerDay: parsed.header.ticksPerDay,
      minutesPerTick: parsed.header.minutesPerTick,
      startHour: parsed.header.startHour ?? DEFAULT_CONFIG.startHour,
      provider: "replay",
      quiet,
    },
    new ReplayProvider(parsed.decisions, parsed.header.version),
  );

  const result = await sim.runAllDays();
  const verifyEvents = parsed.header.eventsRecorded || parsed.events.length > 0;
  if (verifyEvents) {
    const divergence = firstEventDivergence(parsed.events, result.events);
    if (divergence) {
      console.error(`REPLAY MISMATCH — ${divergence}`);
      return 1;
    }
  }
  const expectedHashes = parsed.tickHashes.map((t) => t.state_hash);
  const actualHashes = result.tickHashes.map((t) => t.state_hash);

  let mismatchIdx = -1;
  for (let i = 0; i < Math.max(expectedHashes.length, actualHashes.length); i++) {
    if (expectedHashes[i] !== actualHashes[i]) {
      mismatchIdx = i;
      break;
    }
  }

  if (mismatchIdx !== -1) {
    console.error(
      `REPLAY MISMATCH at tick index ${mismatchIdx}: expected=${expectedHashes[mismatchIdx]} actual=${actualHashes[mismatchIdx]}`,
    );
    return 1;
  }

  if (!quiet) {
    console.log(
      `Replay verified (${actualHashes.length} ticks across ${parsed.header.days} day(s)).`,
    );
    if (verifyEvents) console.log(`Event sequence verified (${result.events.length} events).`);
    console.log(`Final state hash: ${result.finalStateHash}`);
  }
  return 0;
}

function cmdExplain(flags: Record<string, string | boolean>): number {
  const runPath = typeof flags.run === "string" ? flags.run : undefined;
  const entityId = typeof flags.entity === "string" ? flags.entity : undefined;
  if (!runPath || !entityId) {
    console.error("Usage: village explain --run <path/to/run.jsonl> --entity <id>");
    return 1;
  }

  const parsed = parseJsonl(readFileSync(resolveFromInvocationCwd(runPath), "utf8"));
  const rec = explainLastDecision(parsed.decisions, entityId);
  if (!rec) {
    console.error(`No decisions found for entity "${entityId}" in ${runPath}`);
    return 1;
  }

  console.log(formatExplainReport(rec));
  return 0;
}

async function cmdServe(flags: Record<string, string | boolean>): Promise<number> {
  const effectiveEnv = resolveEffectiveEnv();
  const config = buildResolvedConfig({ days: "7", ...flags }, effectiveEnv);
  const port =
    typeof flags.port === "string"
      ? Number.parseInt(flags.port, 10)
      : Number.parseInt(effectiveEnv.PORT ?? "4173", 10);
  const tickMs =
    typeof flags["tick-ms"] === "string" ? Number.parseInt(flags["tick-ms"], 10) : undefined;
  const autostart = flags.paused !== true;

  const handle = await startVillageServer({
    port,
    config,
    tickMs,
    autostart,
    runsDir: join(getInvocationCwd(), "runs"),
  });

  const status = handle.manager.getStatus();
  console.log(`[village] Live simulation backend listening on ${handle.url}`);
  console.log(
    `[village] Provider: ${config.provider} | Seed: ${config.seed} | Days: ${config.days} | Tick interval: ${status.tickMs}ms (maxBatch=${config.maxBatch})`,
  );

  // Keep alive until interrupted
  await new Promise<void>((resolveStop) => {
    const shutdown = async () => {
      await handle.close();
      resolveStop();
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });

  return 0;
}

export async function runCli(argv: readonly string[]): Promise<number> {
  const { command, positional, flags } = parseCliArgs(argv);

  switch (command) {
    case "run":
      return cmdRun(flags);
    case "replay":
      return cmdReplay(positional, flags);
    case "explain":
      return cmdExplain(flags);
    case "serve":
      return cmdServe(flags);
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return 0;
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      return 1;
  }
}

const isMain =
  process.argv[1] && (process.argv[1].endsWith("cli.ts") || process.argv[1].endsWith("cli.js"));

if (isMain) {
  runCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    });
}
