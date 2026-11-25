import type { BatchMode, ProviderKind, SampleMode, SimConfig } from "./types.ts";

export const DEFAULT_CONFIG: SimConfig = {
  provider: "scripted",
  endpoint: "http://127.0.0.1:8009/v1/systemone",
  model: "kev-latest",
  timeoutMs: 120_000,
  batch: "auto",
  maxBatch: 3,
  sample: "weighted",
  minConf: 0.34,
  seed: 7,
  days: 3,
  ticksPerDay: 64, // 06:00 to 22:00 at 15-minute ticks
  minutesPerTick: 15,
  startHour: 6,
  quiet: false,
};

export interface PartialSimConfig {
  provider?: ProviderKind;
  endpoint?: string;
  model?: string;
  timeoutMs?: number;
  batch?: BatchMode;
  maxBatch?: number;
  sample?: SampleMode;
  minConf?: number;
  apiKey?: string;
  seed?: number;
  days?: number;
  ticksPerDay?: number;
  minutesPerTick?: number;
  startHour?: number;
  replayPath?: string;
  quiet?: boolean;
}

const VALID_PROVIDERS = new Set<ProviderKind>(["systemone", "scripted", "replay"]);
const VALID_BATCH = new Set<BatchMode>(["auto", "always", "never"]);
const VALID_SAMPLE = new Set<SampleMode>(["weighted", "argmax"]);

function parseNumber(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid numeric value for ${name}: ${value}`);
  }
  return parsed;
}

export function configFromEnv(env: Record<string, string | undefined>): PartialSimConfig {
  const out: PartialSimConfig = {};

  if (env.DECISION_PROVIDER) {
    const p = env.DECISION_PROVIDER.trim() as ProviderKind;
    if (!VALID_PROVIDERS.has(p)) {
      throw new Error(`Invalid DECISION_PROVIDER: ${p}`);
    }
    out.provider = p;
  }
  if (env.DECISION_ENDPOINT) {
    out.endpoint = env.DECISION_ENDPOINT.trim();
  }
  if (env.DECISION_MODEL) {
    out.model = env.DECISION_MODEL.trim();
  }
  const timeoutMs = parseNumber(env.DECISION_TIMEOUT_MS, "DECISION_TIMEOUT_MS");
  if (timeoutMs !== undefined) out.timeoutMs = timeoutMs;

  if (env.DECISION_BATCH) {
    const b = env.DECISION_BATCH.trim() as BatchMode;
    if (!VALID_BATCH.has(b)) {
      throw new Error(`Invalid DECISION_BATCH: ${b}`);
    }
    out.batch = b;
  }
  const maxBatch = parseNumber(env.DECISION_MAX_BATCH, "DECISION_MAX_BATCH");
  if (maxBatch !== undefined) out.maxBatch = Math.floor(maxBatch);
  if (env.DECISION_SAMPLE) {
    const s = env.DECISION_SAMPLE.trim() as SampleMode;
    if (!VALID_SAMPLE.has(s)) {
      throw new Error(`Invalid DECISION_SAMPLE: ${s}`);
    }
    out.sample = s;
  }
  const minConf = parseNumber(env.DECISION_MIN_CONF, "DECISION_MIN_CONF");
  if (minConf !== undefined) out.minConf = minConf;

  if (env.DECISION_API_KEY) {
    out.apiKey = env.DECISION_API_KEY.trim();
  }

  return out;
}

function cleanPartial(input?: PartialSimConfig): PartialSimConfig {
  if (!input) return {};
  const cleaned: PartialSimConfig = {};
  for (const [k, v] of Object.entries(input)) {
    if (v !== undefined) {
      (cleaned as Record<string, unknown>)[k] = v;
    }
  }
  return cleaned;
}

/**
 * Config precedence: CLI > env > config file > defaults.
 */
export function resolveConfig(layers: {
  file?: PartialSimConfig;
  env?: PartialSimConfig;
  cli?: PartialSimConfig;
}): SimConfig {
  const merged: SimConfig = {
    ...DEFAULT_CONFIG,
    ...cleanPartial(layers.file),
    ...cleanPartial(layers.env),
    ...cleanPartial(layers.cli),
  };

  if (!VALID_PROVIDERS.has(merged.provider)) {
    throw new Error(`Invalid provider: ${String(merged.provider)}`);
  }
  if (!VALID_BATCH.has(merged.batch)) {
    throw new Error(`Invalid batch mode: ${String(merged.batch)}`);
  }
  if (!VALID_SAMPLE.has(merged.sample)) {
    throw new Error(`Invalid sample mode: ${String(merged.sample)}`);
  }
  if (merged.minConf < 0 || merged.minConf > 1) {
    throw new Error(`minConf must be between 0 and 1, got ${merged.minConf}`);
  }
  if (merged.days < 1) {
    throw new Error(`days must be >= 1, got ${merged.days}`);
  }
  if (!Number.isInteger(merged.maxBatch) || merged.maxBatch < 1) {
    throw new Error(`maxBatch must be an integer >= 1, got ${merged.maxBatch}`);
  }

  return merged;
}
