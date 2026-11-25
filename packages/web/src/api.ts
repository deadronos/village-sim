import {
  DEFAULT_CONFIG,
  ScriptedProvider,
  VILLAGE_EDGES,
  VILLAGE_PLACES,
  VillageSimulation,
  cloneEntitiesForSnapshot,
  formatSimTime,
  hashWorldState,
  type DaySummary,
  type PartialSimConfig,
  type PlaceEdge,
  type PlaceNode,
  type SimConfig,
  type SimEvent,
  type TickSnapshot,
} from "@village/core";

export interface ClientStatus {
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

export interface ClientInitPayload {
  places: readonly PlaceNode[];
  edges: readonly PlaceEdge[];
  status: ClientStatus;
  snapshot: TickSnapshot;
  events: SimEvent[];
  summaries: DaySummary[];
  runs: string[];
  connectionMode: "backend" | "local";
}

export interface VillageClientCallbacks {
  onInit(payload: ClientInitPayload): void;
  onTick(snapshot: TickSnapshot, status: ClientStatus): void;
  onStatus(status: ClientStatus): void;
  onReset(snapshot: TickSnapshot, status: ClientStatus, events: SimEvent[]): void;
}

/**
 * Connects to the Node live backend over SSE + REST. If the backend is not
 * reachable (e.g., static preview), transparently runs `@village/core` locally
 * in the browser so the 3D village still animates seamlessly.
 */
export class VillageApiClient {
  private callbacks: VillageClientCallbacks;
  private eventSource: EventSource | null = null;
  private localSim: VillageSimulation | null = null;
  private localConfig: SimConfig = { ...DEFAULT_CONFIG, days: 7 };
  private localRunning = false;
  private localTickMs = 850;
  private localTimer: number | null = null;
  private mode: "backend" | "local" = "backend";

  constructor(callbacks: VillageClientCallbacks) {
    this.callbacks = callbacks;
  }

  async connect(): Promise<void> {
    try {
      const res = await fetch("/api/state", { signal: AbortSignal.timeout(1800) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as Omit<ClientInitPayload, "connectionMode">;
      this.mode = "backend";
      this.callbacks.onInit({ ...data, connectionMode: "backend" });
      this.openEventStream();
    } catch {
      this.startLocalFallback();
    }
  }

  private openEventStream(): void {
    this.eventSource?.close();
    const es = new EventSource("/api/stream");
    this.eventSource = es;

    es.addEventListener("message", (ev) => {
      try {
        const msg = JSON.parse(ev.data) as {
          type: string;
          snapshot?: TickSnapshot;
          status?: ClientStatus;
          events?: SimEvent[];
        };
        if (msg.type === "tick" && msg.snapshot && msg.status) {
          this.callbacks.onTick(msg.snapshot, msg.status);
        } else if (msg.type === "status" && msg.status) {
          this.callbacks.onStatus(msg.status);
        } else if (msg.type === "reset" && msg.snapshot && msg.status) {
          this.callbacks.onReset(msg.snapshot, msg.status, msg.events ?? []);
        }
      } catch {
        // Ignore malformed SSE packets
      }
    });
  }

  private startLocalFallback(): void {
    this.mode = "local";
    this.localSim = new VillageSimulation(this.localConfig, new ScriptedProvider());
    this.localRunning = true;

    const initialSnap = this.makeLocalSnapshot();
    this.callbacks.onInit({
      places: VILLAGE_PLACES,
      edges: VILLAGE_EDGES,
      status: this.getLocalStatus(),
      snapshot: initialSnap,
      events: [],
      summaries: [],
      runs: [],
      connectionMode: "local",
    });

    this.scheduleLocalTick();
  }

  private getLocalStatus(): ClientStatus {
    return {
      running: this.localRunning,
      finished: this.localSim?.isFinished ?? false,
      tickMs: this.localTickMs,
      mode: "live",
      config: {
        provider: this.localConfig.provider,
        endpoint: this.localConfig.endpoint,
        model: this.localConfig.model,
        seed: this.localConfig.seed,
        days: this.localConfig.days,
        sample: this.localConfig.sample,
        minConf: this.localConfig.minConf,
        batch: this.localConfig.batch,
      },
      warnings: ["Running in standalone browser mode (Node backend not detected)."],
    };
  }

  private makeLocalSnapshot(): TickSnapshot {
    const w = this.localSim!.world;
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

  private scheduleLocalTick(): void {
    if (this.localTimer !== null) {
      window.clearTimeout(this.localTimer);
      this.localTimer = null;
    }
    if (!this.localRunning || !this.localSim || this.localSim.isFinished) return;

    this.localTimer = window.setTimeout(async () => {
      if (!this.localRunning || !this.localSim || this.localSim.isFinished) return;
      const snap = await this.localSim.stepTick();
      if (this.localSim.isFinished) this.localRunning = false;
      this.callbacks.onTick(snap, this.getLocalStatus());
      this.scheduleLocalTick();
    }, this.localTickMs);
  }

  async play(): Promise<void> {
    if (this.mode === "backend") {
      await fetch("/api/control/play", { method: "POST" });
      return;
    }
    if (this.localSim?.isFinished) {
      await this.reset({});
    }
    this.localRunning = true;
    this.callbacks.onStatus(this.getLocalStatus());
    this.scheduleLocalTick();
  }

  async pause(): Promise<void> {
    if (this.mode === "backend") {
      await fetch("/api/control/pause", { method: "POST" });
      return;
    }
    this.localRunning = false;
    if (this.localTimer !== null) {
      window.clearTimeout(this.localTimer);
      this.localTimer = null;
    }
    this.callbacks.onStatus(this.getLocalStatus());
  }

  async step(): Promise<void> {
    if (this.mode === "backend") {
      await fetch("/api/control/step", { method: "POST" });
      return;
    }
    if (!this.localSim || this.localSim.isFinished) return;
    const snap = await this.localSim.stepTick();
    this.callbacks.onTick(snap, this.getLocalStatus());
  }

  async setSpeed(tickMs: number): Promise<void> {
    if (this.mode === "backend") {
      await fetch("/api/control/speed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tickMs }),
      });
      return;
    }
    this.localTickMs = tickMs;
    this.callbacks.onStatus(this.getLocalStatus());
  }

  async reset(overrides: PartialSimConfig): Promise<void> {
    if (this.mode === "backend") {
      await fetch("/api/control/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(overrides),
      });
      return;
    }
    const wasRunning = this.localRunning;
    this.localConfig = { ...this.localConfig, ...overrides, provider: "scripted" };
    this.localSim = new VillageSimulation(this.localConfig, new ScriptedProvider());
    this.localRunning = wasRunning;
    this.callbacks.onReset(this.makeLocalSnapshot(), this.getLocalStatus(), []);
    if (wasRunning) this.scheduleLocalTick();
  }

  async listRuns(): Promise<string[]> {
    if (this.mode !== "backend") return [];
    const res = await fetch("/api/runs");
    if (!res.ok) return [];
    const data = (await res.json()) as { runs?: string[] };
    return data.runs ?? [];
  }

  async replayRun(filename: string): Promise<void> {
    if (this.mode !== "backend") return;
    await fetch("/api/runs/replay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename }),
    });
  }

  dispose(): void {
    this.eventSource?.close();
    if (this.localTimer !== null) window.clearTimeout(this.localTimer);
  }
}
