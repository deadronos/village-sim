import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  DEFAULT_CONFIG,
  ReplayProvider,
  VillageSimulation,
  cloneEntitiesForSnapshot,
  formatSimTime,
  hashWorldState,
  parseJsonl,
  serializeJsonl,
  type DaySummary,
  type DecisionProvider,
  type PartialSimConfig,
  type SimConfig,
  type SimEvent,
  type TickSnapshot,
} from "@village/core";
import { createProviderForConfig } from "./config-loader.ts";

export const DEFAULT_LIVE_TICK_MS = 850;
export const DEFAULT_SYSTEMONE_TICK_MS = 2000;
export const MIN_LIVE_TICK_MS = 120;
export const MAX_LIVE_TICK_MS = 6000;
const SYSTEMONE_BREATHING_GAP_MS = 150;

export function defaultTickMsForProvider(provider: SimConfig["provider"]): number {
  return provider === "systemone" ? DEFAULT_SYSTEMONE_TICK_MS : DEFAULT_LIVE_TICK_MS;
}

export interface LiveStatus {
  running: boolean;
  finished: boolean;
  tickMs: number;
  effectiveTickMs: number;
  lastTickMs: number;
  mode: "live" | "replay";
  replayFile?: string;
  config: Pick<
    SimConfig,
    | "provider"
    | "endpoint"
    | "model"
    | "seed"
    | "days"
    | "sample"
    | "minConf"
    | "batch"
    | "maxBatch"
  >;
  warnings: string[];
}

export type StreamMessage =
  | { type: "tick"; snapshot: TickSnapshot; status: LiveStatus }
  | { type: "status"; status: LiveStatus }
  | {
      type: "reset";
      snapshot: TickSnapshot;
      status: LiveStatus;
      events: SimEvent[];
      summaries: DaySummary[];
    };

export class LiveSimManager {
  private sim: VillageSimulation;
  private config: SimConfig;
  private running = false;
  private stepping = false;
  private tickMs: number;
  private effectiveTickMs: number;
  private lastTickDurationMs = 0;
  private emaTickDurationMs = 0;
  private customTickMs: boolean;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private mode: "live" | "replay" = "live";
  private replayFile?: string;
  private readonly warnings: string[] = [];
  private recentEvents: SimEvent[] = [];
  private latestSnapshot: TickSnapshot;
  private readonly listeners = new Set<(msg: StreamMessage) => void>();
  private readonly runsDir: string;

  constructor(initialConfig: SimConfig, options: { tickMs?: number; runsDir?: string } = {}) {
    this.config = { ...initialConfig };
    this.customTickMs = options.tickMs !== undefined;
    this.tickMs = options.tickMs ?? defaultTickMsForProvider(this.config.provider);
    this.effectiveTickMs = this.tickMs;
    this.runsDir = resolve(options.runsDir ?? join(process.cwd(), "runs"));
    this.sim = this.createSimulation(this.config);
    this.latestSnapshot = this.makeInitialSnapshot();
  }

  private createSimulation(
    config: SimConfig,
    customProvider?: DecisionProvider,
  ): VillageSimulation {
    const provider =
      customProvider ??
      createProviderForConfig(config, (msg) => {
        this.warnings.push(msg);
        this.broadcast({ type: "status", status: this.getStatus() });
      });

    return new VillageSimulation(config, provider, {
      onEvent: (ev) => {
        this.recentEvents.push(ev);
        if (this.recentEvents.length > 250) {
          this.recentEvents.shift();
        }
      },
      onDayEnd: () => {
        this.persistLiveLog();
      },
    });
  }

  private makeInitialSnapshot(): TickSnapshot {
    const w = this.sim.world;
    return {
      day: w.day,
      tick: w.tick,
      time: formatSimTime(w.tick, w.minutesPerTick, w.startHour),
      weather: w.weather,
      prosperity: w.prosperity,
      prosperityScore: w.prosperityScore,
      stateHash: hashWorldState(w),
      entities: cloneEntitiesForSnapshot(w.entities),
      events: [],
      decisions: [],
      stats: {
        tradesToday: w.tradesToday,
        tradesTotal: w.tradesTotal,
        breadProducedToday: w.breadProducedToday,
        stewProducedToday: w.stewProducedToday,
        mealsToday: w.mealsToday,
        totalGold: w.entities.reduce((s, e) => s + e.gold, 0),
        providerCalls: 0,
        fallbackRate: 0,
      },
    };
  }

  subscribe(listener: (msg: StreamMessage) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private broadcast(msg: StreamMessage): void {
    for (const listener of this.listeners) {
      listener(msg);
    }
  }

  getStatus(): LiveStatus {
    return {
      running: this.running,
      finished: this.sim.isFinished,
      tickMs: this.tickMs,
      effectiveTickMs: this.effectiveTickMs,
      lastTickMs: this.lastTickDurationMs,
      mode: this.mode,
      replayFile: this.replayFile,
      config: {
        provider: this.config.provider,
        endpoint: this.config.endpoint,
        model: this.config.model,
        seed: this.config.seed,
        days: this.config.days,
        sample: this.config.sample,
        minConf: this.config.minConf,
        batch: this.config.batch,
        maxBatch: this.config.maxBatch,
      },
      warnings: [...this.warnings],
    };
  }

  getFullState() {
    return {
      status: this.getStatus(),
      snapshot: this.latestSnapshot,
      events: [...this.recentEvents],
      summaries: [...this.sim.summaries],
      runs: this.listSavedRuns(),
    };
  }

  getDecisions() {
    return this.sim.decisions;
  }

  listSavedRuns(): string[] {
    try {
      mkdirSync(this.runsDir, { recursive: true });
      return readdirSync(this.runsDir)
        .filter((f) => f.endsWith(".jsonl"))
        .toSorted()
        .toReversed();
    } catch {
      return [];
    }
  }

  private persistLiveLog(): void {
    if (this.mode === "replay") return;
    try {
      mkdirSync(this.runsDir, { recursive: true });
      const file = join(this.runsDir, `seed-${this.config.seed}.jsonl`);
      writeFileSync(file, serializeJsonl(this.sim.records), "utf8");
    } catch {
      // Non-fatal in live mode
    }
  }

  play(): void {
    if (this.sim.isFinished) {
      this.reset({});
    }
    if (this.running) return;
    this.running = true;
    this.broadcast({ type: "status", status: this.getStatus() });
    this.scheduleNextTick(0);
  }

  pause(): void {
    if (!this.running && !this.timer) return;
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.broadcast({ type: "status", status: this.getStatus() });
  }

  setSpeed(tickMs: number): void {
    this.customTickMs = true;
    this.tickMs = Math.max(MIN_LIVE_TICK_MS, Math.min(MAX_LIVE_TICK_MS, Math.round(tickMs)));
    this.effectiveTickMs =
      this.config.provider === "systemone" && this.emaTickDurationMs > this.tickMs
        ? Math.min(MAX_LIVE_TICK_MS, Math.round(this.emaTickDurationMs * 1.15))
        : this.tickMs;
    this.broadcast({ type: "status", status: this.getStatus() });
  }

  async stepOnce(): Promise<TickSnapshot | null> {
    if (this.stepping || this.sim.isFinished) return null;
    this.stepping = true;
    const start = performance.now();
    try {
      const snap = await this.sim.stepTick();
      const elapsed = Math.round(performance.now() - start);
      this.recordTickTiming(elapsed);
      this.latestSnapshot = snap;
      if (this.sim.isFinished) {
        this.running = false;
        this.persistLiveLog();
      }
      this.broadcast({ type: "tick", snapshot: snap, status: this.getStatus() });
      return snap;
    } finally {
      this.stepping = false;
    }
  }

  private recordTickTiming(elapsedMs: number): void {
    this.lastTickDurationMs = elapsedMs;
    this.emaTickDurationMs =
      this.emaTickDurationMs === 0 ? elapsedMs : this.emaTickDurationMs * 0.65 + elapsedMs * 0.35;

    if (this.config.provider === "systemone") {
      // Adaptively stretch live cadence when model inference exceeds target tickMs
      // so SSE ticks stay smooth and never pile up or starve HTTP control requests.
      const adaptiveTarget = Math.round(this.emaTickDurationMs * 1.15);
      this.effectiveTickMs = Math.min(MAX_LIVE_TICK_MS, Math.max(this.tickMs, adaptiveTarget));
    } else {
      this.effectiveTickMs = this.tickMs;
    }
  }

  private scheduleNextTick(delayMs: number): void {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      this.timer = null;
      if (!this.running) return;
      await this.stepOnce();
      if (this.running && !this.sim.isFinished) {
        const minGap = this.config.provider === "systemone" ? SYSTEMONE_BREATHING_GAP_MS : 40;
        const nextDelay = Math.max(minGap, this.effectiveTickMs - this.lastTickDurationMs);
        this.scheduleNextTick(nextDelay);
      }
    }, delayMs);
  }

  reset(overrides: PartialSimConfig): void {
    const wasRunning = this.running;
    this.pause();
    this.warnings.length = 0;
    this.recentEvents = [];
    this.mode = "live";
    this.replayFile = undefined;
    this.lastTickDurationMs = 0;
    this.emaTickDurationMs = 0;

    this.config = {
      ...this.config,
      ...overrides,
      provider:
        overrides.provider ??
        (this.config.provider === "replay" ? "scripted" : this.config.provider),
    };
    if (!this.customTickMs) {
      this.tickMs = defaultTickMsForProvider(this.config.provider);
    }
    this.effectiveTickMs = this.tickMs;
    this.sim = this.createSimulation(this.config);
    this.latestSnapshot = this.makeInitialSnapshot();

    this.broadcast({
      type: "reset",
      snapshot: this.latestSnapshot,
      status: this.getStatus(),
      events: [],
      summaries: [],
    });

    if (wasRunning) {
      this.play();
    }
  }

  startReplay(filename: string): void {
    const safeName = basename(filename);
    const fullPath = join(this.runsDir, safeName);
    const raw = readFileSync(fullPath, "utf8");
    const parsed = parseJsonl(raw);
    if (!parsed.header) {
      throw new Error(`Replay file ${safeName} is missing a header record`);
    }

    this.pause();
    this.warnings.length = 0;
    this.recentEvents = [];
    this.mode = "replay";
    this.replayFile = safeName;
    this.lastTickDurationMs = 0;
    this.emaTickDurationMs = 0;

    this.config = {
      ...this.config,
      seed: parsed.header.seed,
      days: parsed.header.days,
      sample: parsed.header.sample,
      minConf: parsed.header.minConf,
      maxBatch: parsed.header.maxBatch ?? DEFAULT_CONFIG.maxBatch,
      ticksPerDay: parsed.header.ticksPerDay,
      minutesPerTick: parsed.header.minutesPerTick,
      provider: "replay",
    };
    if (!this.customTickMs) {
      this.tickMs = defaultTickMsForProvider("replay");
    }
    this.effectiveTickMs = this.tickMs;

    const provider = new ReplayProvider(parsed.decisions);
    this.sim = this.createSimulation(this.config, provider);
    this.latestSnapshot = this.makeInitialSnapshot();

    this.broadcast({
      type: "reset",
      snapshot: this.latestSnapshot,
      status: this.getStatus(),
      events: [],
      summaries: [],
    });
    this.play();
  }
}
