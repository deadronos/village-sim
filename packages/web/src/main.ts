import "./styles.css";
import { VillageApiClient, type ClientStatus } from "./api.ts";
import { VillageScene } from "./scene/VillageScene.ts";
import { VillageHud } from "./ui/hud.ts";

let scene: VillageScene | null = null;
let currentStatus: ClientStatus | null = null;

const hud = new VillageHud({
  onTogglePlay: () => {
    if (currentStatus?.running) {
      void api.pause();
    } else {
      void api.play();
    }
  },
  onStep: () => {
    void api.step();
  },
  onSpeedChange: (tickMs) => {
    void api.setSpeed(tickMs);
  },
  onSelectEntity: (entityId) => {
    scene?.setSelectedEntity(entityId);
    hud.selectEntity(entityId, true);
  },
  onFocusEntity: (entityId) => {
    scene?.focusOnEntity(entityId);
  },
  onReset: (overrides) => {
    void api.reset(overrides);
  },
  onRefreshRuns: () => api.listRuns(),
  onReplayRun: (filename) => {
    void api.replayRun(filename);
  },
});

const api = new VillageApiClient({
  onInit: async (payload) => {
    currentStatus = payload.status;
    hud.setConnectionBadge(payload.connectionMode);
    hud.resetEvents(payload.events);
    hud.updateSnapshot(payload.snapshot, payload.status);

    const viewport = document.getElementById("viewport")!;
    if (!scene) {
      scene = new VillageScene({
        container: viewport,
        places: payload.places,
        edges: payload.edges,
        onSelectEntity: (entityId) => {
          scene?.setSelectedEntity(entityId);
          hud.selectEntity(entityId, true);
        },
      });
      try {
        const backend = await scene.init();
        hud.setRendererBadge(backend);
      } catch (err) {
        hud.setRendererBadge("Renderer Err");
        console.error("Failed to initialize Three.js WebGPURenderer:", err);
      }
    }

    scene.syncWorld(
      payload.snapshot.entities,
      payload.snapshot.time,
      payload.snapshot.weather,
      payload.status.tickMs,
    );
  },

  onTick: (snapshot, status) => {
    currentStatus = status;
    hud.updateSnapshot(snapshot, status);
    scene?.syncWorld(
      snapshot.entities,
      snapshot.time,
      snapshot.weather,
      status.tickMs,
      snapshot.events,
    );
  },

  onStatus: (status) => {
    currentStatus = status;
    hud.setStatus(status);
  },

  onReset: (snapshot, status, events) => {
    currentStatus = status;
    hud.resetEvents(events);
    hud.updateSnapshot(snapshot, status);
    scene?.syncWorld(snapshot.entities, snapshot.time, snapshot.weather, status.tickMs);
  },
});

void api.connect();
