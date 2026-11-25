import {
  getRelationshipTier,
  type Entity,
  type ItemKind,
  type PartialSimConfig,
  type SimEvent,
  type TickSnapshot,
} from "@village/core";
import type { ClientStatus } from "../api.ts";
import { ROLE_COLORS } from "../scene/villagers.ts";

export interface HudCallbacks {
  onTogglePlay(): void;
  onStep(): void;
  onSpeedChange(tickMs: number): void;
  onToggleBubbles(enabled: boolean): void;
  onToggleGraph(enabled: boolean): void;
  onSelectEntity(entityId: string): void;
  onFocusEntity(entityId: string): void;
  onReset(config: PartialSimConfig): void;
  onRefreshRuns(): Promise<string[]>;
  onReplayRun(filename: string): void;
}

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing HUD element #${id}`);
  return node as T;
}

export class VillageHud {
  private readonly callbacks: HudCallbacks;
  private selectedEntityId: string | null = null;
  private latestSnapshot: TickSnapshot | null = null;
  private latestStatus: ClientStatus | null = null;
  private events: SimEvent[] = [];

  private readonly rendererBadge = el<HTMLSpanElement>("renderer-badge");
  private readonly connectionBadge = el<HTMLSpanElement>("connection-badge");
  private readonly clockDay = el<HTMLSpanElement>("clock-day");
  private readonly clockTime = el<HTMLSpanElement>("clock-time");
  private readonly weatherPill = el<HTMLSpanElement>("weather-pill");
  private readonly prosperityPill = el<HTMLSpanElement>("prosperity-pill");
  private readonly btnPlay = el<HTMLButtonElement>("btn-play");
  private readonly btnStep = el<HTMLButtonElement>("btn-step");
  private readonly speedSlider = el<HTMLInputElement>("speed-slider");
  private readonly btnBubbles = el<HTMLButtonElement>("btn-bubbles");
  private readonly btnGraph = el<HTMLButtonElement>("btn-graph");
  private readonly btnSettings = el<HTMLButtonElement>("btn-settings");
  private bubblesEnabled = true;
  private graphEnabled = false;

  private readonly rosterList = el<HTMLDivElement>("roster-list");
  private readonly sidePanel = el<HTMLElement>("side-panel");
  private readonly btnTogglePanel = el<HTMLButtonElement>("btn-toggle-panel");
  private readonly btnReopenPanel = el<HTMLButtonElement>("btn-reopen-panel");
  private readonly tabTimeline = el<HTMLButtonElement>("tab-timeline");
  private readonly tabInspector = el<HTMLButtonElement>("tab-inspector");
  private readonly viewTimeline = el<HTMLElement>("view-timeline");
  private readonly viewInspector = el<HTMLElement>("view-inspector");
  private readonly warningBanner = el<HTMLDivElement>("warning-banner");
  private readonly eventFeed = el<HTMLUListElement>("event-feed");

  private readonly inspectorEmpty = el<HTMLDivElement>("inspector-empty");
  private readonly inspectorContent = el<HTMLDivElement>("inspector-content");
  private readonly inspName = el<HTMLHeadingElement>("insp-name");
  private readonly inspSubtitle = el<HTMLParagraphElement>("insp-subtitle");
  private readonly btnFocusCam = el<HTMLButtonElement>("btn-focus-cam");
  private readonly inspLocation = el<HTMLElement>("insp-location");
  private readonly inspGold = el<HTMLElement>("insp-gold");
  private readonly inspMeals = el<HTMLElement>("insp-meals");
  private readonly inspGoal = el<HTMLElement>("insp-goal");
  private readonly barHunger = el<HTMLDivElement>("bar-hunger");
  private readonly barEnergy = el<HTMLDivElement>("bar-energy");
  private readonly barSocial = el<HTMLDivElement>("bar-social");
  private readonly valHunger = el<HTMLSpanElement>("val-hunger");
  private readonly valEnergy = el<HTMLSpanElement>("val-energy");
  private readonly valSocial = el<HTMLSpanElement>("val-social");
  private readonly inspInventory = el<HTMLDivElement>("insp-inventory");
  private readonly inspProvider = el<HTMLSpanElement>("insp-provider");
  private readonly inspProbs = el<HTMLDivElement>("insp-probs");
  private readonly inspBonds = el<HTMLDivElement>("insp-bonds");
  private readonly inspRumors = el<HTMLUListElement>("insp-rumors");
  private readonly inspMemory = el<HTMLUListElement>("insp-memory");
  private readonly inspPrompt = el<HTMLPreElement>("insp-prompt");

  private readonly statTrades = el<HTMLElement>("stat-trades");
  private readonly statBread = el<HTMLElement>("stat-bread");
  private readonly statStew = el<HTMLElement>("stat-stew");
  private readonly statMeals = el<HTMLElement>("stat-meals");
  private readonly statGold = el<HTMLElement>("stat-gold");
  private readonly statProvider = el<HTMLElement>("stat-provider");
  private readonly statFallback = el<HTMLElement>("stat-fallback");
  private readonly statEscalated = el<HTMLElement>("stat-escalated");
  private readonly statHash = el<HTMLElement>("stat-hash");

  private readonly settingsDialog = el<HTMLDialogElement>("settings-dialog");
  private readonly btnCloseDialog = el<HTMLButtonElement>("btn-close-dialog");
  private readonly resetForm = el<HTMLFormElement>("reset-form");
  private readonly cfgSeed = el<HTMLInputElement>("cfg-seed");
  private readonly cfgDays = el<HTMLInputElement>("cfg-days");
  private readonly cfgProvider = el<HTMLSelectElement>("cfg-provider");
  private readonly cfgSample = el<HTMLSelectElement>("cfg-sample");
  private readonly cfgEndpoint = el<HTMLInputElement>("cfg-endpoint");
  private readonly cfgModel = el<HTMLInputElement>("cfg-model");
  private readonly savedRunsList = el<HTMLDivElement>("saved-runs-list");

  constructor(callbacks: HudCallbacks) {
    this.callbacks = callbacks;
    this.bindEvents();
    this.observeTopbarHeight();
  }

  private observeTopbarHeight(): void {
    const topbar = document.querySelector<HTMLElement>(".hud-topbar");
    if (!topbar || typeof ResizeObserver === "undefined") return;
    const syncOffset = () => {
      const topPx = Math.ceil(topbar.getBoundingClientRect().bottom + 12);
      document.documentElement.style.setProperty("--hud-top", `${topPx}px`);
    };
    const ro = new ResizeObserver(syncOffset);
    ro.observe(topbar);
    syncOffset();
  }

  private bindEvents(): void {
    this.btnPlay.addEventListener("click", () => this.callbacks.onTogglePlay());
    this.btnStep.addEventListener("click", () => this.callbacks.onStep());
    this.speedSlider.addEventListener("input", () => {
      const val = Number.parseInt(this.speedSlider.value, 10);
      if (Number.isFinite(val)) this.callbacks.onSpeedChange(val);
    });

    this.btnBubbles.addEventListener("click", () => {
      this.bubblesEnabled = !this.bubblesEnabled;
      this.btnBubbles.classList.toggle("active", this.bubblesEnabled);
      this.btnBubbles.setAttribute("aria-pressed", String(this.bubblesEnabled));
      this.callbacks.onToggleBubbles(this.bubblesEnabled);
    });

    this.btnGraph.addEventListener("click", () => {
      this.graphEnabled = !this.graphEnabled;
      this.btnGraph.classList.toggle("active", this.graphEnabled);
      this.btnGraph.setAttribute("aria-pressed", String(this.graphEnabled));
      this.callbacks.onToggleGraph(this.graphEnabled);
    });

    this.tabTimeline.addEventListener("click", () => this.setActiveTab("timeline"));
    this.tabInspector.addEventListener("click", () => this.setActiveTab("inspector"));

    this.btnTogglePanel.addEventListener("click", () => {
      this.sidePanel.hidden = true;
      this.btnReopenPanel.hidden = false;
    });
    this.btnReopenPanel.addEventListener("click", () => {
      this.sidePanel.hidden = false;
      this.btnReopenPanel.hidden = true;
    });

    this.btnFocusCam.addEventListener("click", () => {
      if (this.selectedEntityId) {
        this.callbacks.onFocusEntity(this.selectedEntityId);
      }
    });

    this.btnSettings.addEventListener("click", async () => {
      this.syncDialogFields();
      this.settingsDialog.showModal();
      const runs = await this.callbacks.onRefreshRuns();
      this.renderRunsList(runs);
    });

    this.btnCloseDialog.addEventListener("click", () => {
      this.settingsDialog.close();
    });

    this.settingsDialog.addEventListener("close", () => {
      // Clear returnValue per modern-web-guidance dialog spec
      this.settingsDialog.returnValue = "";
    });

    // Pointer-position light-dismiss fallback when closedby="any" is unsupported (e.g. Safari)
    if (!("closedBy" in HTMLDialogElement.prototype)) {
      const isOutside = (e: PointerEvent) => {
        const r = this.settingsDialog.getBoundingClientRect();
        return (
          e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom
        );
      };
      let pressedOutside = false;
      this.settingsDialog.addEventListener("pointerdown", (e) => {
        pressedOutside = isOutside(e);
      });
      this.settingsDialog.addEventListener("pointerup", (e) => {
        if (pressedOutside && isOutside(e)) {
          this.settingsDialog.close();
        }
      });
    }

    this.resetForm.addEventListener("submit", (e) => {
      e.preventDefault();
      this.callbacks.onReset({
        seed: Number.parseInt(this.cfgSeed.value, 10) || 7,
        days: Number.parseInt(this.cfgDays.value, 10) || 7,
        provider: this.cfgProvider.value as PartialSimConfig["provider"],
        sample: this.cfgSample.value as PartialSimConfig["sample"],
        endpoint: this.cfgEndpoint.value.trim(),
        model: this.cfgModel.value.trim(),
      });
      this.settingsDialog.close();
    });
  }

  setRendererBadge(label: string): void {
    this.rendererBadge.textContent = label;
  }

  setConnectionBadge(mode: "backend" | "local"): void {
    this.connectionBadge.textContent = mode === "backend" ? "Live Backend" : "Browser Sim";
  }

  setActiveTab(tab: "timeline" | "inspector"): void {
    const isTimeline = tab === "timeline";
    this.tabTimeline.classList.toggle("active", isTimeline);
    this.tabTimeline.setAttribute("aria-selected", String(isTimeline));
    this.tabInspector.classList.toggle("active", !isTimeline);
    this.tabInspector.setAttribute("aria-selected", String(!isTimeline));
    this.viewTimeline.hidden = !isTimeline;
    this.viewInspector.hidden = isTimeline;
  }

  selectEntity(entityId: string | null, openInspector = true): void {
    this.selectedEntityId = entityId;
    if (entityId && openInspector) {
      this.sidePanel.hidden = false;
      this.btnReopenPanel.hidden = true;
      this.setActiveTab("inspector");
    }
    this.renderRoster();
    this.renderInspector();
  }

  setStatus(status: ClientStatus): void {
    this.latestStatus = status;
    this.btnPlay.textContent = status.running ? "Pause" : status.finished ? "Restart" : "Play";
    this.speedSlider.value = String(status.tickMs);
    const effMs = status.effectiveTickMs ?? status.tickMs;
    const lastMs = status.lastTickMs ?? 0;
    this.speedSlider.title =
      effMs > status.tickMs
        ? `Target ${status.tickMs}ms · adaptive ${effMs}ms (last tick ${lastMs}ms)`
        : `Tick interval ${status.tickMs}ms`;
    const provider = status.fallbackActive ? "scripted fallback" : status.config.provider;
    const providerLabel =
      status.mode === "replay"
        ? `replay (${status.replayFile ?? "jsonl"})`
        : `${provider} · seed ${status.config.seed}`;
    this.statProvider.textContent = providerLabel;
    this.statProvider.title = providerLabel;

    const latestWarning =
      status.config.provider === "systemone" && status.fallbackActive === false
        ? undefined
        : status.warnings.at(-1);
    this.warningBanner.hidden = !latestWarning;
    this.warningBanner.textContent = latestWarning ?? "";
  }

  resetEvents(initialEvents: SimEvent[]): void {
    this.events = initialEvents.filter((e) => e.kind !== "move").slice(-160);
    this.renderEvents();
  }

  updateSnapshot(snapshot: TickSnapshot, status: ClientStatus): void {
    this.latestSnapshot = snapshot;
    this.setStatus(status);

    this.clockDay.textContent = `Day ${snapshot.day}`;
    this.clockTime.textContent = snapshot.time;
    this.weatherPill.textContent = snapshot.weather;
    this.prosperityPill.textContent = snapshot.prosperity;
    this.prosperityPill.className = `pill pill-${snapshot.prosperity}`;
    this.prosperityPill.title = `Village prosperity: ${snapshot.prosperity} (${Math.round(snapshot.prosperityScore * 100)}%)`;

    this.statTrades.textContent = `${snapshot.stats.tradesToday} (${snapshot.stats.tradesTotal})`;
    this.statBread.textContent = String(snapshot.stats.breadProducedToday);
    this.statStew.textContent = String(snapshot.stats.stewProducedToday);
    this.statMeals.textContent = String(snapshot.stats.mealsToday);
    this.statGold.textContent = `${snapshot.stats.totalGold}g`;
    this.statFallback.textContent = `${(snapshot.stats.fallbackRate * 100).toFixed(1)}%`;
    this.statEscalated.textContent =
      status.config.provider === "scripted" && status.mode !== "replay"
        ? "n/a"
        : `${snapshot.stats.escalatedDecisions} (${(snapshot.stats.escalationRate * 100).toFixed(1)}%)`;
    this.statHash.textContent = snapshot.stateHash.slice(0, 12);
    this.statHash.title = snapshot.stateHash;

    const notable = snapshot.events.filter((e) => e.kind !== "move");
    if (notable.length > 0) {
      this.events.push(...notable);
      if (this.events.length > 160) {
        this.events = this.events.slice(-160);
      }
      this.renderEvents();
    }

    this.renderRoster();
    this.renderInspector();
  }

  private renderRoster(): void {
    const entities = this.latestSnapshot?.entities ?? [];
    this.rosterList.replaceChildren();

    for (const entity of entities) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `roster-item${entity.id === this.selectedEntityId ? " selected" : ""}`;
      btn.addEventListener("click", () => {
        this.callbacks.onSelectEntity(entity.id);
        this.callbacks.onFocusEntity(entity.id);
      });

      const left = document.createElement("span");
      left.className = "roster-left";

      const swatch = document.createElement("span");
      swatch.className = "role-swatch";
      swatch.style.background = ROLE_COLORS[entity.role];

      const textWrap = document.createElement("span");
      const nameSpan = document.createElement("span");
      nameSpan.className = "roster-name";
      nameSpan.textContent = entity.name;
      const roleSpan = document.createElement("span");
      roleSpan.className = "roster-role";
      roleSpan.textContent = `${entity.role} · ${entity.location}`;

      textWrap.append(nameSpan, roleSpan);
      left.append(swatch, textWrap);

      const goldSpan = document.createElement("span");
      goldSpan.className = "roster-gold";
      goldSpan.textContent = `${entity.gold}g`;

      btn.append(left, goldSpan);
      this.rosterList.append(btn);
    }
  }

  private renderEvents(): void {
    this.eventFeed.replaceChildren();
    const recent = this.events.toReversed();
    for (const ev of recent) {
      const li = document.createElement("li");
      li.className = `event-row kind-${ev.kind}`;
      li.textContent = ev.message;
      if (ev.entityId) {
        const entityId = ev.entityId;
        li.addEventListener("click", () => {
          this.callbacks.onSelectEntity(entityId);
          this.callbacks.onFocusEntity(entityId);
        });
      }
      this.eventFeed.append(li);
    }
  }

  private renderInspector(): void {
    const entity = this.latestSnapshot?.entities.find((e) => e.id === this.selectedEntityId);
    if (!entity) {
      this.inspectorEmpty.hidden = false;
      this.inspectorContent.hidden = true;
      return;
    }

    this.inspectorEmpty.hidden = true;
    this.inspectorContent.hidden = false;

    this.inspName.textContent = entity.name;
    this.inspSubtitle.textContent = `${entity.role} · focus: ${entity.focus}`;
    this.inspLocation.textContent = entity.location;
    this.inspGold.textContent = `${entity.gold}g`;
    this.inspMeals.textContent = String(entity.mealsToday);
    this.inspGoal.textContent = entity.goal
      ? `${entity.goal.kind} → ${entity.goal.targetPlace}`
      : "deciding";

    this.setNeedBar(this.barHunger, this.valHunger, entity.needs.hunger);
    this.setNeedBar(this.barEnergy, this.valEnergy, entity.needs.energy);
    this.setNeedBar(this.barSocial, this.valSocial, entity.needs.social);

    this.renderInventory(entity);
    this.renderDecision(entity);
    this.renderBonds(entity);
    this.renderRumors(entity);
    this.renderMemory(entity);
  }

  private setNeedBar(bar: HTMLDivElement, label: HTMLSpanElement, val: number): void {
    bar.style.width = `${Math.round(val * 100)}%`;
    label.textContent = val.toFixed(2);
  }

  private renderInventory(entity: Entity): void {
    this.inspInventory.replaceChildren();
    const entries = (Object.entries(entity.inventory) as Array<[ItemKind, number]>).filter(
      ([, qty]) => qty > 0,
    );
    if (entries.length === 0) {
      const chip = document.createElement("span");
      chip.className = "chip muted";
      chip.textContent = "empty";
      this.inspInventory.append(chip);
      return;
    }
    for (const [item, qty] of entries) {
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.textContent = `${qty} ${item}`;
      this.inspInventory.append(chip);
    }
  }

  private renderDecision(entity: Entity): void {
    const dec = entity.lastDecision;
    this.inspProbs.replaceChildren();
    if (!dec) {
      this.inspProvider.textContent = "—";
      this.inspPrompt.textContent = "Awaiting first tick decision…";
      return;
    }

    this.inspProvider.textContent = dec.escalated ? `${dec.provider} · escalated` : dec.provider;

    const sorted = Object.entries(dec.probabilities).toSorted(([, a], [, b]) => b - a);
    for (const [action, prob] of sorted) {
      const row = document.createElement("div");
      row.className = `prob-row${action === dec.action ? " chosen" : ""}`;

      const name = document.createElement("span");
      name.textContent = action;

      const track = document.createElement("div");
      track.className = "prob-bar-track";
      const fill = document.createElement("div");
      fill.className = "prob-bar-fill";
      fill.style.width = `${Math.round(prob * 100)}%`;
      track.append(fill);

      const pct = document.createElement("span");
      pct.className = "mono";
      pct.textContent = `${Math.round(prob * 100)}%`;

      row.append(name, track, pct);
      this.inspProbs.append(row);
    }

    this.inspPrompt.textContent = `STATE:\n${dec.worldStateSummary}\n\nINSTRUCTIONS:\n${dec.instructions}`;
  }

  private renderBonds(entity: Entity): void {
    this.inspBonds.replaceChildren();
    const others = (this.latestSnapshot?.entities ?? []).filter((e) => e.id !== entity.id);
    const ranked = others
      .map((other) => {
        const aff = entity.affinity[other.id] ?? 0.5;
        return { other, aff, tier: getRelationshipTier(aff) };
      })
      .toSorted((a, b) => b.aff - a.aff)
      .slice(0, 4);

    for (const { other, aff, tier } of ranked) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `bond-row tier-${tier}`;
      btn.addEventListener("click", () => {
        this.callbacks.onSelectEntity(other.id);
        this.callbacks.onFocusEntity(other.id);
      });

      const name = document.createElement("span");
      name.textContent = other.name;

      const track = document.createElement("div");
      track.className = "bond-bar-track";
      const fill = document.createElement("div");
      fill.className = "bond-bar-fill";
      fill.style.width = `${Math.round(aff * 100)}%`;
      track.append(fill);

      const badge = document.createElement("span");
      badge.className = "bond-tier";
      badge.textContent = `${tier} ${Math.round(aff * 100)}%`;

      btn.append(name, track, badge);
      this.inspBonds.append(btn);
    }
  }

  private renderRumors(entity: Entity): void {
    this.inspRumors.replaceChildren();
    if (entity.rumors.length === 0) {
      const li = document.createElement("li");
      li.className = "muted";
      li.textContent = "No active rumors heard yet.";
      this.inspRumors.append(li);
      return;
    }

    const sorted = entity.rumors.toSorted((a, b) => {
      if (b.originDay !== a.originDay) return b.originDay - a.originDay;
      return b.originTick - a.originTick;
    });

    for (const r of sorted) {
      const li = document.createElement("li");
      li.className = "rumor-item";
      li.textContent = `"${r.summary}"`;

      const meta = document.createElement("span");
      meta.className = "rumor-meta";
      meta.textContent =
        r.hops === 0
          ? `firsthand · Day ${r.originDay}`
          : `from ${r.sourceId} · ${r.hops} ${r.hops === 1 ? "hop" : "hops"} · Day ${r.originDay}`;
      li.append(meta);
      this.inspRumors.append(li);
    }
  }

  private renderMemory(entity: Entity): void {
    this.inspMemory.replaceChildren();
    if (entity.memory.length === 0) {
      const li = document.createElement("li");
      li.className = "muted";
      li.textContent = "No recent memories yet.";
      this.inspMemory.append(li);
      return;
    }
    for (const item of entity.memory.toReversed()) {
      const li = document.createElement("li");
      li.textContent = item;
      this.inspMemory.append(li);
    }
  }

  private syncDialogFields(): void {
    const cfg = this.latestStatus?.config;
    if (!cfg) return;
    this.cfgSeed.value = String(cfg.seed);
    this.cfgDays.value = String(cfg.days);
    this.cfgProvider.value = cfg.provider === "systemone" ? "systemone" : "scripted";
    this.cfgSample.value = cfg.sample;
    this.cfgEndpoint.value = cfg.endpoint;
    this.cfgModel.value = cfg.model;
  }

  private renderRunsList(runs: string[]): void {
    this.savedRunsList.replaceChildren();
    if (runs.length === 0) {
      const p = document.createElement("p");
      p.className = "muted";
      p.textContent = "No saved JSONL runs yet. Run a day or `pnpm village run` to generate one.";
      this.savedRunsList.append(p);
      return;
    }
    for (const file of runs) {
      const row = document.createElement("div");
      row.className = "run-item";

      const name = document.createElement("code");
      name.textContent = file;

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn btn-sm";
      btn.textContent = "Replay 3D";
      btn.addEventListener("click", () => {
        this.callbacks.onReplayRun(file);
        this.settingsDialog.close();
      });

      row.append(name, btn);
      this.savedRunsList.append(row);
    }
  }
}
