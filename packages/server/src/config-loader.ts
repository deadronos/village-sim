import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ReplayProvider,
  ScriptedProvider,
  SystemOneProvider,
  configFromEnv,
  parseJsonl,
  resolveConfig,
  type BatchMode,
  type DecisionProvider,
  type PartialSimConfig,
  type ProviderKind,
  type SampleMode,
  type SimConfig,
} from "@village/core";

export interface ParsedCliArgs {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

export function parseCliArgs(argv: readonly string[]): ParsedCliArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token.startsWith("--")) {
      const eqIdx = token.indexOf("=");
      if (eqIdx !== -1) {
        flags[token.slice(2, eqIdx)] = token.slice(eqIdx + 1);
      } else {
        const key = token.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags[key] = next;
          i += 1;
        } else {
          flags[key] = true;
        }
      }
    } else {
      positional.push(token);
    }
  }

  const command = positional[0] ?? "help";
  return {
    command,
    positional: positional.slice(1),
    flags,
  };
}

export function getInvocationCwd(env: Record<string, string | undefined> = process.env): string {
  return env.INIT_CWD && env.INIT_CWD.trim().length > 0 ? env.INIT_CWD : process.cwd();
}

export function resolveFromInvocationCwd(
  targetPath: string,
  env: Record<string, string | undefined> = process.env,
): string {
  return resolve(getInvocationCwd(env), targetPath);
}

export function loadConfigFile(
  configPath?: string,
  env: Record<string, string | undefined> = process.env,
): PartialSimConfig {
  const candidate = configPath
    ? resolveFromInvocationCwd(configPath, env)
    : resolveFromInvocationCwd("village.config.json", env);
  if (!existsSync(candidate)) return {};
  const raw = readFileSync(candidate, "utf8");
  return JSON.parse(raw) as PartialSimConfig;
}

function stringFlag(flags: Record<string, string | boolean>, key: string): string | undefined {
  const val = flags[key];
  return typeof val === "string" ? val : undefined;
}

function numberFlag(flags: Record<string, string | boolean>, key: string): number | undefined {
  const str = stringFlag(flags, key);
  if (str === undefined) return undefined;
  const parsed = Number(str);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid number for --${key}: ${str}`);
  }
  return parsed;
}

export function configFromFlags(flags: Record<string, string | boolean>): PartialSimConfig {
  const out: PartialSimConfig = {};
  const provider = stringFlag(flags, "provider");
  if (provider) out.provider = provider as ProviderKind;

  const endpoint = stringFlag(flags, "endpoint");
  if (endpoint) out.endpoint = endpoint;

  const model = stringFlag(flags, "model");
  if (model) out.model = model;

  const timeoutMs = numberFlag(flags, "timeout-ms");
  if (timeoutMs !== undefined) out.timeoutMs = timeoutMs;

  const batch = stringFlag(flags, "batch");
  if (batch) out.batch = batch as BatchMode;

  const sample = stringFlag(flags, "sample");
  if (sample) out.sample = sample as SampleMode;

  const minConf = numberFlag(flags, "min-conf");
  if (minConf !== undefined) out.minConf = minConf;

  const apiKey = stringFlag(flags, "api-key");
  if (apiKey) out.apiKey = apiKey;

  const seed = numberFlag(flags, "seed");
  if (seed !== undefined) out.seed = seed;

  const days = numberFlag(flags, "days");
  if (days !== undefined) out.days = days;

  const replayPath = stringFlag(flags, "replay");
  if (replayPath) out.replayPath = replayPath;

  if (flags.quiet === true || flags.quiet === "true") {
    out.quiet = true;
  }

  return out;
}

export function buildResolvedConfig(
  flags: Record<string, string | boolean>,
  env: Record<string, string | undefined> = process.env,
): SimConfig {
  const fileConfig = loadConfigFile(stringFlag(flags, "config"), env);
  const envConfig = configFromEnv(env);
  const cliConfig = configFromFlags(flags);
  return resolveConfig({ file: fileConfig, env: envConfig, cli: cliConfig });
}

export function createProviderForConfig(
  config: SimConfig,
  onWarning?: (msg: string) => void,
  env: Record<string, string | undefined> = process.env,
): DecisionProvider {
  switch (config.provider) {
    case "scripted":
      return new ScriptedProvider();
    case "systemone":
      return new SystemOneProvider({
        endpoint: config.endpoint,
        model: config.model,
        timeoutMs: config.timeoutMs,
        batch: config.batch,
        apiKey: config.apiKey,
        onWarning:
          onWarning ??
          ((msg) => {
            console.warn(`[village] WARNING: ${msg}`);
          }),
      });
    case "replay": {
      if (!config.replayPath) {
        throw new Error(
          "DECISION_PROVIDER=replay requires --replay <path> or replayPath in config",
        );
      }
      const parsed = parseJsonl(
        readFileSync(resolveFromInvocationCwd(config.replayPath, env), "utf8"),
      );
      return new ReplayProvider(parsed.decisions);
    }
  }
}
