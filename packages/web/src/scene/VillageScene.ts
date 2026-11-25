import type { Entity, PlaceEdge, PlaceNode, SimEvent, Weather } from "@village/core";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import * as THREE from "three/webgpu";
import { createVillageAtmosphere, type AtmosphereController } from "./atmosphere.ts";
import { buildVillageBuildings, type AnimatedBuildings } from "./buildings.ts";
import { buildVillageTerrain } from "./terrain.ts";
import { VillagerLayer } from "./villagers.ts";

export interface VillageSceneOptions {
  container: HTMLElement;
  places: readonly PlaceNode[];
  edges: readonly PlaceEdge[];
  onSelectEntity: (entityId: string | null) => void;
}

export class VillageScene {
  private readonly container: HTMLElement;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly renderer: THREE.WebGPURenderer;
  private readonly controls: OrbitControls;
  private readonly buildings: AnimatedBuildings;
  private readonly villagers: VillagerLayer;
  private readonly atmosphere: AtmosphereController;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly onSelectEntity: (entityId: string | null) => void;

  private simHour = 9.5;
  private weather: Weather = "clear";
  private focusTarget: THREE.Vector3 | null = null;
  private animId: number | null = null;
  private lastFrameTime = performance.now();
  private elapsed = 0;
  private pointerDownPos = { x: 0, y: 0 };
  private disposed = false;
  backendLabel = "WebGPU";

  constructor(options: VillageSceneOptions) {
    this.container = options.container;
    this.onSelectEntity = options.onSelectEntity;

    this.scene = new THREE.Scene();

    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.camera = new THREE.PerspectiveCamera(42, width / height, 0.5, 220);
    this.camera.position.set(0, 31, 37);

    this.renderer = new THREE.WebGPURenderer({
      antialias: true,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(width, height);
    this.renderer.shadowMap.enabled = true;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.07;
    this.controls.maxPolarAngle = Math.PI / 2.22;
    this.controls.minPolarAngle = 0.22;
    this.controls.minDistance = 12;
    this.controls.maxDistance = 76;
    this.controls.target.set(0, 0.5, 0);

    this.atmosphere = createVillageAtmosphere(this.scene);
    this.scene.add(buildVillageTerrain(options.places, options.edges));
    this.buildings = buildVillageBuildings(options.places);
    this.scene.add(this.buildings.group);
    this.villagers = new VillagerLayer(options.places);
    this.scene.add(this.villagers.group);

    this.bindEvents();
  }

  async init(): Promise<string> {
    await this.renderer.init();
    const backend = this.renderer.backend as { isWebGPUBackend?: boolean } | undefined;
    this.backendLabel = backend?.isWebGPUBackend ? "WebGPU" : "WebGL2";
    this.startLoop();
    return this.backendLabel;
  }

  private bindEvents(): void {
    window.addEventListener("resize", this.handleResize);
    this.renderer.domElement.addEventListener("pointerdown", this.handlePointerDown);
    this.renderer.domElement.addEventListener("pointerup", this.handlePointerUp);
  }

  private handleResize = (): void => {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  };

  private handlePointerDown = (e: PointerEvent): void => {
    this.pointerDownPos = { x: e.clientX, y: e.clientY };
    // Manual camera drag cancels automatic camera focus easing
    this.focusTarget = null;
  };

  private handlePointerUp = (e: PointerEvent): void => {
    const dist = Math.hypot(e.clientX - this.pointerDownPos.x, e.clientY - this.pointerDownPos.y);
    if (dist > 6) return;

    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.villagers.getHitMeshes(), false);
    const hitId = hits[0]?.object.userData.entityId as string | undefined;
    if (hitId) {
      this.onSelectEntity(hitId);
    }
  };

  syncWorld(
    entities: readonly Entity[],
    timeStr: string,
    weather: Weather,
    tickMs: number,
    events: readonly SimEvent[] = [],
  ): void {
    const [hStr, mStr] = timeStr.split(":");
    const h = Number.parseInt(hStr ?? "9", 10);
    const m = Number.parseInt(mStr ?? "0", 10);
    if (Number.isFinite(h) && Number.isFinite(m)) {
      this.simHour = h + m / 60;
    }
    this.weather = weather;
    this.villagers.setTransitionDuration(tickMs);
    this.villagers.syncEntities(entities, events);
  }

  setSelectedEntity(entityId: string | null): void {
    this.villagers.setSelected(entityId);
  }

  focusOnEntity(entityId: string): void {
    const pos = this.villagers.getEntityWorldPosition(entityId);
    if (pos) {
      this.focusTarget = pos;
    }
  }

  private startLoop(): void {
    const renderFrame = (now: number) => {
      if (this.disposed) return;
      this.animId = requestAnimationFrame(renderFrame);

      const dt = Math.min(0.08, Math.max(0.001, (now - this.lastFrameTime) / 1000));
      this.lastFrameTime = now;
      this.elapsed += dt;

      if (this.focusTarget) {
        this.controls.target.lerp(this.focusTarget, Math.min(1, dt * 4.5));
        if (this.controls.target.distanceTo(this.focusTarget) < 0.15) {
          this.focusTarget = null;
        }
      }

      this.controls.update();
      this.atmosphere.update(dt, this.simHour, this.weather);
      this.buildings.update(dt, this.elapsed, this.atmosphere.duskFactor, this.weather);
      this.villagers.update(dt, this.elapsed);

      void this.renderer.renderAsync(this.scene, this.camera);
    };

    this.lastFrameTime = performance.now();
    this.animId = requestAnimationFrame(renderFrame);
  }

  dispose(): void {
    this.disposed = true;
    if (this.animId !== null) cancelAnimationFrame(this.animId);
    window.removeEventListener("resize", this.handleResize);
    this.renderer.domElement.removeEventListener("pointerdown", this.handlePointerDown);
    this.renderer.domElement.removeEventListener("pointerup", this.handlePointerUp);
    this.controls.dispose();
    this.renderer.dispose();
  }
}
