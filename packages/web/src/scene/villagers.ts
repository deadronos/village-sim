import type { Entity, PlaceNode, Role, SimEvent } from "@village/core";
import * as THREE from "three/webgpu";

export const ROLE_COLORS: Record<Role, string> = {
  farmer: "#85b84b",
  baker: "#f0a657",
  innkeeper: "#c95b6c",
  woodcutter: "#3fa38f",
  smith: "#7e8a9c",
  herbalist: "#a67ee8",
  guard: "#5496e8",
  child: "#f7d44c",
};

interface VillagerRig {
  id: string;
  role: Role;
  root: THREE.Group;
  bodyGroup: THREE.Group;
  hitMesh: THREE.Mesh;
  fromPos: THREE.Vector3;
  toPos: THREE.Vector3;
  currentPos: THREE.Vector3;
  progress: number;
  labelCanvas: HTMLCanvasElement;
  labelTexture: THREE.CanvasTexture;
  lastLabelText: string;
}

interface BurstParticle {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  age: number;
  maxAge: number;
}

function drawVillagerBadge(
  canvas: HTMLCanvasElement,
  name: string,
  subtitle: string,
  roleColor: string,
): void {
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = "rgba(14, 21, 33, 0.84)";
  ctx.beginPath();
  ctx.roundRect(8, 8, canvas.width - 16, canvas.height - 16, 16);
  ctx.fill();
  ctx.strokeStyle = roleColor;
  ctx.lineWidth = 3;
  ctx.stroke();

  ctx.fillStyle = "#f4f7fb";
  ctx.font = "700 22px Inter, -apple-system, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(name, canvas.width / 2, 29);

  ctx.fillStyle = "#b9c7da";
  ctx.font = "500 16px Inter, -apple-system, sans-serif";
  ctx.fillText(subtitle, canvas.width / 2, 52);
}

function buildRoleCharacter(role: Role): THREE.Group {
  const g = new THREE.Group();
  const color = new THREE.Color(ROLE_COLORS[role]);
  const scale = role === "child" ? 0.76 : 1.0;

  const tunicMat = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.75,
    flatShading: true,
  });
  const skinMat = new THREE.MeshStandardMaterial({
    color: 0xf4cfb2,
    roughness: 0.8,
    flatShading: true,
  });

  // Low-poly tapered cloak/tunic body
  const body = new THREE.Mesh(new THREE.ConeGeometry(0.42, 1.15, 7), tunicMat);
  body.position.y = 0.6;
  body.castShadow = true;
  g.add(body);

  // Faceted head
  const head = new THREE.Mesh(new THREE.IcosahedronGeometry(0.3, 1), skinMat);
  head.position.y = 1.35;
  head.castShadow = true;
  g.add(head);

  // Distinct role headgear / accessory
  switch (role) {
    case "farmer": {
      const brim = new THREE.Mesh(
        new THREE.CylinderGeometry(0.54, 0.54, 0.08, 8),
        new THREE.MeshStandardMaterial({ color: 0xe3c068, roughness: 0.9, flatShading: true }),
      );
      brim.position.y = 1.56;
      g.add(brim);
      const crown = new THREE.Mesh(
        new THREE.ConeGeometry(0.28, 0.34, 7),
        new THREE.MeshStandardMaterial({ color: 0xd8b153, roughness: 0.9, flatShading: true }),
      );
      crown.position.y = 1.74;
      g.add(crown);
      break;
    }
    case "baker": {
      const toque = new THREE.Mesh(
        new THREE.DodecahedronGeometry(0.28, 0),
        new THREE.MeshStandardMaterial({ color: 0xf8f6f0, roughness: 0.85, flatShading: true }),
      );
      toque.position.y = 1.72;
      g.add(toque);
      break;
    }
    case "guard": {
      const helm = new THREE.Mesh(
        new THREE.ConeGeometry(0.32, 0.36, 6),
        new THREE.MeshStandardMaterial({
          color: 0xb5c2d1,
          metalness: 0.6,
          roughness: 0.35,
          flatShading: true,
        }),
      );
      helm.position.y = 1.72;
      g.add(helm);
      const spear = new THREE.Mesh(
        new THREE.CylinderGeometry(0.035, 0.035, 1.85, 5),
        new THREE.MeshStandardMaterial({ color: 0x7a5031, roughness: 0.85, flatShading: true }),
      );
      spear.position.set(0.4, 1.0, 0.08);
      g.add(spear);
      break;
    }
    case "herbalist": {
      const hood = new THREE.Mesh(
        new THREE.ConeGeometry(0.36, 0.48, 6),
        new THREE.MeshStandardMaterial({ color: 0x8e67cf, roughness: 0.8, flatShading: true }),
      );
      hood.position.y = 1.7;
      g.add(hood);
      break;
    }
    default: {
      const cap = new THREE.Mesh(
        new THREE.CylinderGeometry(0.24, 0.31, 0.2, 7),
        new THREE.MeshStandardMaterial({
          color: color.clone().multiplyScalar(0.65),
          roughness: 0.85,
          flatShading: true,
        }),
      );
      cap.position.y = 1.62;
      g.add(cap);
    }
  }

  g.scale.setScalar(scale);
  return g;
}

export class VillagerLayer {
  readonly group = new THREE.Group();
  private readonly placeMap: Map<string, PlaceNode>;
  private readonly rigs = new Map<string, VillagerRig>();
  private readonly selectionRing: THREE.Mesh;
  private readonly bursts: BurstParticle[] = [];
  private selectedId: string | null = null;
  private transitionDuration = 0.8;

  constructor(places: readonly PlaceNode[]) {
    this.group.name = "villagers-layer";
    this.placeMap = new Map(places.map((p) => [p.id, p]));

    const ringGeo = new THREE.RingGeometry(0.68, 0.92, 18);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xffd27a,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.92,
    });
    this.selectionRing = new THREE.Mesh(ringGeo, ringMat);
    this.selectionRing.rotation.x = -Math.PI / 2;
    this.selectionRing.position.y = 0.12;
    this.selectionRing.visible = false;
    this.group.add(this.selectionRing);
  }

  setTransitionDuration(tickMs: number): void {
    this.transitionDuration = Math.max(0.14, Math.min(2.0, (tickMs / 1000) * 0.92));
  }

  setSelected(entityId: string | null): void {
    this.selectedId = entityId;
    this.selectionRing.visible = entityId !== null && this.rigs.has(entityId);
  }

  getHitMeshes(): THREE.Object3D[] {
    return Array.from(this.rigs.values()).map((r) => r.hitMesh);
  }

  getEntityWorldPosition(entityId: string): THREE.Vector3 | null {
    const rig = this.rigs.get(entityId);
    return rig ? rig.currentPos.clone() : null;
  }

  private getSlotPosition(placeId: string, slotIndex: number, slotCount: number): THREE.Vector3 {
    const p = this.placeMap.get(placeId);
    if (!p) return new THREE.Vector3(0, 0, 0);
    // Offset villagers nicely in front/around buildings so they never overlap
    const radius = p.kind === "home" ? 1.85 : 2.55;
    const angle = (slotIndex / Math.max(1, slotCount)) * Math.PI * 2 + 0.6;
    return new THREE.Vector3(p.x + Math.cos(angle) * radius, 0, p.z + Math.sin(angle) * radius);
  }

  syncEntities(entities: readonly Entity[], events: readonly SimEvent[] = []): void {
    // Group entities by location for clean non-overlapping circular slots
    const occupants = new Map<string, string[]>();
    for (const e of entities) {
      const list = occupants.get(e.location) ?? [];
      list.push(e.id);
      occupants.set(e.location, list);
    }

    for (const entity of entities) {
      const slotList = occupants.get(entity.location) ?? [entity.id];
      const slotIdx = slotList.indexOf(entity.id);
      const targetPos = this.getSlotPosition(entity.location, slotIdx, slotList.length);
      const badgeSub = entity.goal?.kind ?? entity.lastDecision?.action ?? "idle";

      let rig = this.rigs.get(entity.id);
      if (!rig) {
        const root = new THREE.Group();
        const bodyGroup = buildRoleCharacter(entity.role);
        root.add(bodyGroup);

        // Invisible generous raycast target for effortless clicking
        const hitMesh = new THREE.Mesh(
          new THREE.CylinderGeometry(0.65, 0.65, 2.2, 8),
          new THREE.MeshBasicMaterial({ visible: false }),
        );
        hitMesh.position.y = 1.0;
        hitMesh.userData.entityId = entity.id;
        root.add(hitMesh);

        const labelCanvas = document.createElement("canvas");
        labelCanvas.width = 220;
        labelCanvas.height = 76;
        drawVillagerBadge(labelCanvas, entity.name, badgeSub, ROLE_COLORS[entity.role]);
        const labelTexture = new THREE.CanvasTexture(labelCanvas);
        labelTexture.colorSpace = THREE.SRGBColorSpace;
        const sprite = new THREE.Sprite(
          new THREE.SpriteMaterial({ map: labelTexture, transparent: true, depthWrite: false }),
        );
        sprite.scale.set(2.35, 0.82, 1);
        sprite.position.y = entity.role === "child" ? 2.1 : 2.55;
        root.add(sprite);

        root.position.copy(targetPos);
        this.group.add(root);

        rig = {
          id: entity.id,
          role: entity.role,
          root,
          bodyGroup,
          hitMesh,
          fromPos: targetPos.clone(),
          toPos: targetPos.clone(),
          currentPos: targetPos.clone(),
          progress: 1,
          labelCanvas,
          labelTexture,
          lastLabelText: badgeSub,
        };
        this.rigs.set(entity.id, rig);
      } else {
        rig.fromPos.copy(rig.currentPos);
        rig.toPos.copy(targetPos);
        rig.progress = rig.fromPos.distanceTo(rig.toPos) > 0.05 ? 0 : 1;

        if (rig.lastLabelText !== badgeSub) {
          drawVillagerBadge(rig.labelCanvas, entity.name, badgeSub, ROLE_COLORS[entity.role]);
          rig.labelTexture.needsUpdate = true;
          rig.lastLabelText = badgeSub;
        }
      }
    }

    // Spawn sparkling bursts on trades, bakes, and meals
    for (const ev of events) {
      if (ev.kind === "trade" || ev.kind === "produce" || ev.kind === "eat") {
        const place = ev.place ? this.placeMap.get(ev.place) : undefined;
        if (!place) continue;
        const color = ev.kind === "trade" ? 0xffd257 : ev.kind === "produce" ? 0x58d3b5 : 0xff9452;
        this.spawnBurst(new THREE.Vector3(place.x, 1.8, place.z), color);
      }
    }
  }

  private spawnBurst(origin: THREE.Vector3, color: number): void {
    const mat = new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 0.7,
      roughness: 0.4,
      flatShading: true,
    });
    for (let i = 0; i < 5; i++) {
      const mesh = new THREE.Mesh(new THREE.OctahedronGeometry(0.18, 0), mat);
      mesh.position.copy(origin);
      this.group.add(mesh);
      const angle = (i / 5) * Math.PI * 2;
      this.bursts.push({
        mesh,
        vel: new THREE.Vector3(
          Math.cos(angle) * 1.4,
          2.5 + Math.random() * 1.2,
          Math.sin(angle) * 1.4,
        ),
        age: 0,
        maxAge: 0.9,
      });
    }
  }

  update(dt: number, elapsed: number): void {
    for (const rig of this.rigs.values()) {
      if (rig.progress < 1) {
        rig.progress = Math.min(1, rig.progress + dt / this.transitionDuration);
        // Smoothstep easing
        const t = rig.progress * rig.progress * (3 - 2 * rig.progress);
        rig.currentPos.lerpVectors(rig.fromPos, rig.toPos, t);

        const dx = rig.toPos.x - rig.fromPos.x;
        const dz = rig.toPos.z - rig.fromPos.z;
        if (Math.hypot(dx, dz) > 0.05) {
          rig.bodyGroup.rotation.y = Math.atan2(dx, dz);
        }

        // Cheerful low-poly walking hop
        rig.bodyGroup.position.y = Math.abs(Math.sin(rig.progress * Math.PI * 4)) * 0.24;
      } else {
        // Gentle idle breathing bob
        rig.bodyGroup.position.y = Math.sin(elapsed * 2.4 + rig.currentPos.x) * 0.03;
      }

      rig.root.position.copy(rig.currentPos);
    }

    if (this.selectedId) {
      const sel = this.rigs.get(this.selectedId);
      if (sel) {
        this.selectionRing.visible = true;
        this.selectionRing.position.set(sel.currentPos.x, 0.12, sel.currentPos.z);
        const pulse = 1 + Math.sin(elapsed * 4.5) * 0.08;
        this.selectionRing.scale.setScalar(pulse);
      }
    }

    // Update particle bursts
    for (let i = this.bursts.length - 1; i >= 0; i--) {
      const p = this.bursts[i]!;
      p.age += dt;
      if (p.age >= p.maxAge) {
        this.group.remove(p.mesh);
        p.mesh.geometry.dispose();
        this.bursts.splice(i, 1);
        continue;
      }
      p.vel.y -= 4.2 * dt;
      p.mesh.position.addScaledVector(p.vel, dt);
      p.mesh.rotation.x += dt * 4;
      p.mesh.rotation.y += dt * 5;
      p.mesh.scale.setScalar(1 - p.age / p.maxAge);
    }
  }
}
