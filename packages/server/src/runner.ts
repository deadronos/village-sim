import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
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

export interface LiveStatus {
  running: boolean;
  finished: boolean;
  tickMs: number;
  mode: "live" | "replay";
  replayFile?: string;
  config: Pick<
    SimConfig,
    "provider" | "endpoint" | "model" | "seed" | "days" | "sample" | "minConf" | "batch"
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
    this.tickMs = options.tickMs ?? 850;
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
    this.tickMs = Math.max(120, Math.min(4000, Math.round(tickMs)));
    this.broadcast({ type: "status", status: this.getStatus() });
  }

  async stepOnce(): Promise<TickSnapshot | null> {
    if (this.stepping || this.sim.isFinished) return null;
    this.stepping = true;
    try {
      const snap = await this.sim.stepTick();
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

  private scheduleNextTick(delayMs: number): void {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      this.timer = null;
      if (!this.running) return;
      const start = performance.now();
      await this.stepOnce();
      if (this.running && !this.sim.isFinished) {
        const elapsed = performance.now() - start;
        this.scheduleNextTick(Math.max(40, this.tickMs - elapsed));
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

    this.config = {
      ...this.config,
      ...overrides,
      provider:
        overrides.provider ??
        (this.config.provider === "replay" ? "scripted" : this.config.provider),
    };
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

    this.config = {
      ...this.config,
      seed: parsed.header.seed,
      days: parsed.header.days,
      sample: parsed.header.sample,
      minConf: parsed.header.minConf,
      ticksPerDay: parsed.header.ticksPerDay,
      minutesPerTick: parsed.header.minutesPerTick,
      provider: "replay",
    };

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
