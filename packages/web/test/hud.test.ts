import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, type TickSnapshot } from "@village/core";
import type { ClientStatus } from "../src/api.ts";
import { VillageHud, type HudCallbacks } from "../src/ui/hud.ts";

const WEB_ROOT = resolve(import.meta.dirname, "..");
const INDEX_HTML = readFileSync(resolve(WEB_ROOT, "index.html"), "utf8");
const STYLES_CSS = readFileSync(resolve(WEB_ROOT, "src/styles.css"), "utf8");

class MockClassList {
  private readonly classes = new Set<string>();

  toggle(token: string, force?: boolean): boolean {
    if (force === undefined) {
      if (this.classes.has(token)) {
        this.classes.delete(token);
        return false;
      }
      this.classes.add(token);
      return true;
    }
    if (force) {
      this.classes.add(token);
      return true;
    }
    this.classes.delete(token);
    return false;
  }

  contains(token: string): boolean {
    return this.classes.has(token);
  }
}

class MockElement {
  readonly tagName: string;
  readonly id: string;
  readonly classList = new MockClassList();
  readonly attributes = new Map<string, string>();
  readonly style: Record<string, string> = {};
  readonly children: MockElement[] = [];
  hidden = false;
  textContent = "";
  title = "";
  className = "";
  value = "";
  type = "";
  returnValue = "";

  constructor(tagName: string, id = "") {
    this.tagName = tagName;
    this.id = id;
  }

  addEventListener(_event: string, _handler: (...args: unknown[]) => void): void {}

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  replaceChildren(...nodes: MockElement[]): void {
    this.children.length = 0;
    this.children.push(...nodes);
  }

  append(...nodes: MockElement[]): void {
    this.children.push(...nodes);
  }

  showModal(): void {}
  close(): void {}
}

function createMockHudDom(): Map<string, MockElement> {
  const elements = new Map<string, MockElement>();
  const idMatches = INDEX_HTML.matchAll(/\bid="([^"]+)"/g);
  for (const match of idMatches) {
    const id = match[1];
    if (id) {
      elements.set(id, new MockElement("div", id));
    }
  }
  const viewInspector = elements.get("view-inspector");
  if (viewInspector) viewInspector.hidden = true;
  const reopenBtn = elements.get("btn-reopen-panel");
  if (reopenBtn) reopenBtn.hidden = true;
  return elements;
}

function createNoopCallbacks(): HudCallbacks {
  return {
    onTogglePlay: vi.fn(),
    onStep: vi.fn(),
    onSpeedChange: vi.fn(),
    onToggleBubbles: vi.fn(),
    onToggleGraph: vi.fn(),
    onSelectEntity: vi.fn(),
    onFocusEntity: vi.fn(),
    onReset: vi.fn(),
    onRefreshRuns: vi.fn(async () => []),
    onReplayRun: vi.fn(),
  };
}

function makeStatus(overrides: Partial<ClientStatus> = {}): ClientStatus {
  return {
    running: true,
    finished: false,
    tickMs: 850,
    mode: "live",
    config: {
      provider: DEFAULT_CONFIG.provider,
      endpoint: DEFAULT_CONFIG.endpoint,
      model: DEFAULT_CONFIG.model,
      seed: 7,
      days: 7,
      sample: DEFAULT_CONFIG.sample,
      minConf: DEFAULT_CONFIG.minConf,
      batch: DEFAULT_CONFIG.batch,
    },
    warnings: [],
    ...overrides,
  };
}

function makeSnapshot(stateHash: string): TickSnapshot {
  return {
    day: 1,
    tick: 4,
    time: "07:00",
    weather: "clear",
    prosperity: "steady",
    prosperityScore: 0.62,
    stateHash,
    entities: [
      {
        id: "anna",
        name: "Anna",
        role: "baker",
        location: "bakery",
        gold: 24,
        mealsToday: 1,
        focus: "duty",
        needs: { hunger: 0.2, energy: 0.85, social: 0.7 },
        inventory: { wheat: 0, bread: 3, stew: 0, wood: 1, herb: 0 },
        affinity: {},
        rumors: [],
        memory: [],
        goal: null,
        lastDecision: null,
      },
    ],
    events: [],
    decisions: [],
    stats: {
      tradesToday: 2,
      tradesTotal: 5,
      breadProducedToday: 4,
      stewProducedToday: 1,
      mealsToday: 3,
      totalGold: 120,
      providerCalls: 6,
      fallbackRate: 0,
    },
  };
}

describe("Viewer HUD layout & polish (Issue #5)", () => {
  it("enforces panel-body [hidden] safety and explicit z-index layering in CSS", () => {
    expect(STYLES_CSS).toMatch(/\.panel-body\[hidden\]\s*\{[^}]*display:\s*none\s*!important/s);
    expect(STYLES_CSS).toMatch(/\[hidden\]\s*\{[^}]*display:\s*none\s*!important/s);
    expect(STYLES_CSS).toMatch(/#viewport\s*\{[^}]*z-index:\s*0/s);
    expect(STYLES_CSS).toMatch(/\.panel-tabs\s*\{[^}]*z-index:\s*2/s);
    expect(STYLES_CSS).toMatch(/\.panel-body\s*\{[^}]*z-index:\s*1/s);
    expect(STYLES_CSS).toMatch(/\.hud-panel\s*\{[^}]*z-index:\s*18/s);
    expect(STYLES_CSS).toMatch(/\.hud-topbar\s*\{[^}]*z-index:\s*20/s);
    expect(STYLES_CSS).toMatch(/\.hud-bottombar\s*\{[^}]*z-index:\s*16/s);
  });

  it("applies graceful ellipsis truncation rules to flexible bottom-bar items", () => {
    expect(STYLES_CSS).toMatch(
      /\.stat-provider,\s*\.stat-hash\s*\{[^}]*min-width:\s*0;[^}]*overflow:\s*hidden;/s,
    );
    expect(STYLES_CSS).toMatch(
      /\.stat-provider strong,\s*\.stat-hash code\s*\{[^}]*min-width:\s*0;[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;/s,
    );
    expect(INDEX_HTML).toMatch(/class="stat-item stat-provider"/);
    expect(INDEX_HTML).toMatch(/id="stat-provider"[^>]*title="/);
    expect(INDEX_HTML).toMatch(/id="stat-hash"[^>]*title="/);
  });

  it("keeps timeline and inspector tabs mutually exclusive and sets full title tooltips", () => {
    const dom = createMockHudDom();
    const prevDocument = globalThis.document;
    const prevDialog = globalThis.HTMLDialogElement;

    globalThis.document = {
      getElementById: (id: string) => dom.get(id) ?? null,
      querySelector: () => null,
      createElement: (tag: string) => new MockElement(tag),
    } as unknown as Document;
    globalThis.HTMLDialogElement = {
      prototype: { closedBy: "any" },
    } as unknown as typeof HTMLDialogElement;

    try {
      const hud = new VillageHud(createNoopCallbacks());
      const viewTimeline = dom.get("view-timeline")!;
      const viewInspector = dom.get("view-inspector")!;
      const tabTimeline = dom.get("tab-timeline")!;
      const tabInspector = dom.get("tab-inspector")!;
      const sidePanel = dom.get("side-panel")!;
      const statHash = dom.get("stat-hash")!;
      const statProvider = dom.get("stat-provider")!;

      // Switching to inspector hides timeline and exposes inspector exclusively
      hud.selectEntity("anna", true);
      expect(sidePanel.hidden).toBe(false);
      expect(viewTimeline.hidden).toBe(true);
      expect(viewInspector.hidden).toBe(false);
      expect(tabTimeline.getAttribute("aria-selected")).toBe("false");
      expect(tabInspector.getAttribute("aria-selected")).toBe("true");

      // Switching back to timeline hides inspector exclusively
      hud.setActiveTab("timeline");
      expect(viewTimeline.hidden).toBe(false);
      expect(viewInspector.hidden).toBe(true);
      expect(tabTimeline.getAttribute("aria-selected")).toBe("true");
      expect(tabInspector.getAttribute("aria-selected")).toBe("false");

      // Full 64-char SHA-256 hash is set on #stat-hash title while text is 12-char prefix
      const fullHash = "a1b2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef0123456789abcdef0";
      hud.updateSnapshot(makeSnapshot(fullHash), makeStatus());
      expect(statHash.textContent).toBe(fullHash.slice(0, 12));
      expect(statHash.title).toBe(fullHash);
      expect(statProvider.textContent).toBe("scripted · seed 7");
      expect(statProvider.title).toBe("scripted · seed 7");

      // Replay mode also populates full provider title tooltip
      hud.setStatus(
        makeStatus({
          mode: "replay",
          replayFile: "village-seed-7-long-recorded-session.jsonl",
        }),
      );
      expect(statProvider.textContent).toBe("replay (village-seed-7-long-recorded-session.jsonl)");
      expect(statProvider.title).toBe("replay (village-seed-7-long-recorded-session.jsonl)");
    } finally {
      globalThis.document = prevDocument;
      globalThis.HTMLDialogElement = prevDialog;
    }
  });
});
