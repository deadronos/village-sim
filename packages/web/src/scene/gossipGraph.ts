import { getRelationshipTier, type Entity, type SimEvent } from "@village/core";
import * as THREE from "three/webgpu";

interface BondArc {
  key: string;
  aId: string;
  bId: string;
  tier: "warm" | "close";
  line: THREE.Line;
  geometry: THREE.BufferGeometry;
  material: THREE.LineBasicMaterial;
}

interface PulseArc {
  fromId: string;
  toId: string;
  line: THREE.Line;
  geometry: THREE.BufferGeometry;
  material: THREE.LineBasicMaterial;
  orb: THREE.Mesh;
  orbMaterial: THREE.MeshBasicMaterial;
  age: number;
  duration: number;
}

const ARC_SEGMENTS = 18;

function writeQuadraticArc(
  positions: Float32Array,
  from: THREE.Vector3,
  to: THREE.Vector3,
  peakHeight: number,
): void {
  const midX = (from.x + to.x) * 0.5;
  const midZ = (from.z + to.z) * 0.5;
  const dist = Math.hypot(to.x - from.x, to.z - from.z);
  const midY = Math.max(2.6, Math.min(8.5, peakHeight + dist * 0.22));
  const y0 = 1.65;

  for (let i = 0; i <= ARC_SEGMENTS; i++) {
    const t = i / ARC_SEGMENTS;
    const inv = 1 - t;
    const x = inv * inv * from.x + 2 * inv * t * midX + t * t * to.x;
    const y = inv * inv * y0 + 2 * inv * t * midY + t * t * y0;
    const z = inv * inv * from.z + 2 * inv * t * midZ + t * t * to.z;
    const idx = i * 3;
    positions[idx] = x;
    positions[idx + 1] = y;
    positions[idx + 2] = z;
  }
}

function sampleQuadraticPoint(
  out: THREE.Vector3,
  from: THREE.Vector3,
  to: THREE.Vector3,
  peakHeight: number,
  t: number,
): void {
  const midX = (from.x + to.x) * 0.5;
  const midZ = (from.z + to.z) * 0.5;
  const dist = Math.hypot(to.x - from.x, to.z - from.z);
  const midY = Math.max(2.6, Math.min(8.5, peakHeight + dist * 0.22));
  const y0 = 1.65;
  const inv = 1 - t;
  out.set(
    inv * inv * from.x + 2 * inv * t * midX + t * t * to.x,
    inv * inv * y0 + 2 * inv * t * midY + t * t * y0,
    inv * inv * from.z + 2 * inv * t * midZ + t * t * to.z,
  );
}

/**
 * Renders the 3D Villager Relationship & Gossip Graph:
 * - Toggleable persistent glowing curved arcs between warm & close friends.
 * - Animated gossip/gift pulse arcs with a traveling orb whenever rumors or gifts pass.
 */
export class RelationshipGraphLayer {
  readonly group = new THREE.Group();
  private readonly bondsGroup = new THREE.Group();
  private readonly pulsesGroup = new THREE.Group();
  private readonly bonds = new Map<string, BondArc>();
  private readonly pulses: PulseArc[] = [];
  private readonly orbGeo = new THREE.OctahedronGeometry(0.24, 0);
  private readonly tmpPoint = new THREE.Vector3();
  private graphVisible = false;

  constructor() {
    this.group.name = "relationship-graph-layer";
    this.bondsGroup.visible = this.graphVisible;
    this.group.add(this.bondsGroup, this.pulsesGroup);
  }

  setGraphVisible(visible: boolean): void {
    this.graphVisible = visible;
    this.bondsGroup.visible = visible;
  }

  isGraphVisible(): boolean {
    return this.graphVisible;
  }

  clearPulses(): void {
    for (const p of this.pulses) {
      this.disposePulse(p);
    }
    this.pulses.length = 0;
  }

  sync(
    entities: readonly Entity[],
    events: readonly SimEvent[],
    getPos: (entityId: string) => THREE.Vector3 | null,
  ): void {
    // 1. Reconcile persistent warm/close relationship bonds
    const activeKeys = new Set<string>();
    for (let i = 0; i < entities.length; i++) {
      const a = entities[i]!;
      for (let j = i + 1; j < entities.length; j++) {
        const b = entities[j]!;
        const avgAff = ((a.affinity[b.id] ?? 0.5) + (b.affinity[a.id] ?? 0.5)) * 0.5;
        const tier = getRelationshipTier(avgAff);
        if (tier !== "warm" && tier !== "close") continue;

        const key = a.id < b.id ? `${a.id}:${b.id}` : `${b.id}:${a.id}`;
        activeKeys.add(key);

        const existing = this.bonds.get(key);
        const color = tier === "close" ? 0xffd27a : 0x58d3b5;
        const opacity = tier === "close" ? 0.82 : 0.42;

        if (existing) {
          if (existing.tier !== tier) {
            existing.tier = tier;
            existing.material.color.setHex(color);
            existing.material.opacity = opacity;
          }
        } else {
          const positions = new Float32Array((ARC_SEGMENTS + 1) * 3);
          const geometry = new THREE.BufferGeometry();
          geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
          const material = new THREE.LineBasicMaterial({
            color,
            transparent: true,
            opacity,
            depthWrite: false,
          });
          const line = new THREE.Line(geometry, material);
          line.frustumCulled = false;
          this.bondsGroup.add(line);
          this.bonds.set(key, { key, aId: a.id, bId: b.id, tier, line, geometry, material });
        }
      }
    }

    for (const [key, bond] of this.bonds) {
      if (!activeKeys.has(key)) {
        this.bondsGroup.remove(bond.line);
        bond.geometry.dispose();
        bond.material.dispose();
        this.bonds.delete(key);
      }
    }

    // 2. Spawn animated pulse arcs on gossip, gift, or (when graph is open) trade events
    for (const ev of events) {
      if (!ev.entityId || !ev.otherEntityId) continue;
      if (
        ev.kind !== "gossip" &&
        ev.kind !== "gift" &&
        !(this.graphVisible && ev.kind === "trade")
      ) {
        continue;
      }

      const from = getPos(ev.entityId);
      const to = getPos(ev.otherEntityId);
      if (!from || !to) continue;

      const color = ev.kind === "gossip" ? 0x9b8cff : ev.kind === "gift" ? 0xff8fb3 : 0xffd257;
      const positions = new Float32Array((ARC_SEGMENTS + 1) * 3);
      writeQuadraticArc(positions, from, to, 3.2);
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      const material = new THREE.LineBasicMaterial({
        color,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
      });
      const line = new THREE.Line(geometry, material);
      line.frustumCulled = false;

      const orbMaterial = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.95,
      });
      const orb = new THREE.Mesh(this.orbGeo, orbMaterial);
      orb.position.copy(from);

      this.pulsesGroup.add(line, orb);
      this.pulses.push({
        fromId: ev.entityId,
        toId: ev.otherEntityId,
        line,
        geometry,
        material,
        orb,
        orbMaterial,
        age: 0,
        duration: 1.65,
      });
    }
  }

  update(dt: number, getPos: (entityId: string) => THREE.Vector3 | null): void {
    if (this.graphVisible) {
      for (const bond of this.bonds.values()) {
        const from = getPos(bond.aId);
        const to = getPos(bond.bId);
        if (!from || !to) continue;
        const posAttr = bond.geometry.getAttribute("position") as THREE.BufferAttribute;
        writeQuadraticArc(
          posAttr.array as Float32Array,
          from,
          to,
          bond.tier === "close" ? 2.8 : 2.1,
        );
        posAttr.needsUpdate = true;
      }
    }

    for (let i = this.pulses.length - 1; i >= 0; i--) {
      const p = this.pulses[i]!;
      p.age += dt;
      if (p.age >= p.duration) {
        this.disposePulse(p);
        this.pulses.splice(i, 1);
        continue;
      }

      const from = getPos(p.fromId);
      const to = getPos(p.toId);
      if (from && to) {
        const posAttr = p.geometry.getAttribute("position") as THREE.BufferAttribute;
        writeQuadraticArc(posAttr.array as Float32Array, from, to, 3.4);
        posAttr.needsUpdate = true;

        const progress = p.age / p.duration;
        const travelT = Math.min(1, progress * 1.25);
        sampleQuadraticPoint(this.tmpPoint, from, to, 3.4, travelT);
        p.orb.position.copy(this.tmpPoint);
        p.orb.rotation.y += dt * 5;

        const fade = progress > 0.65 ? Math.max(0, 1 - (progress - 0.65) / 0.35) : 1;
        p.material.opacity = 0.85 * fade;
        p.orbMaterial.opacity = 0.95 * fade;
      }
    }
  }

  private disposePulse(p: PulseArc): void {
    this.pulsesGroup.remove(p.line, p.orb);
    p.geometry.dispose();
    p.material.dispose();
    p.orbMaterial.dispose();
  }

  dispose(): void {
    this.clearPulses();
    for (const bond of this.bonds.values()) {
      this.bondsGroup.remove(bond.line);
      bond.geometry.dispose();
      bond.material.dispose();
    }
    this.bonds.clear();
    this.orbGeo.dispose();
  }
}
