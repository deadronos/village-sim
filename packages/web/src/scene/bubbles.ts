import type { Entity, ItemKind, PlaceNode, SimEvent, Weather } from "@village/core";
import * as THREE from "three/webgpu";

interface BubbleSpec {
  entityId?: string;
  fallbackPlace?: string;
  text: string;
  accent: string;
  delay: number;
  duration: number;
}

interface ActiveBubble {
  entityId?: string;
  anchorPos: THREE.Vector3;
  sprite: THREE.Sprite;
  texture: THREE.CanvasTexture;
  material: THREE.SpriteMaterial;
  age: number;
  delay: number;
  duration: number;
  baseScaleX: number;
  baseScaleY: number;
}

const ACCENT_BY_KIND: Record<SimEvent["kind"], string> = {
  trade: "#f3b552",
  produce: "#58d3b5",
  eat: "#ff9c5e",
  socialize: "#6fb7ff",
  gossip: "#a88cff",
  gift: "#ff8fb3",
  wage: "#c79bff",
  demand: "#c79bff",
  rest: "#93a4ff",
  deadlock: "#f27474",
  patrol: "#6fb7ff",
  wander: "#a7bacf",
  dawn: "#ffe38f",
  move: "#98a9be",
  decision: "#98a9be",
  system: "#98a9be",
};

const PRODUCE_VERBS: Record<ItemKind, [string, string]> = {
  bread: ["🥖", "Baked"],
  stew: ["🍲", "Cooked"],
  wheat: ["🌾", "Harvested"],
  wood: ["🪵", "Chopped"],
  tool: ["⚒️", "Forged"],
  herbs: ["🌿", "Gathered"],
  water: ["💧", "Drew"],
};

const SOCIAL_GREETINGS = [
  (name: string) => `Good to see you, ${name}!`,
  (name: string) => `How's trade, ${name}?`,
  (name: string) => `Busy day, ${name}!`,
  (name: string) => `Fine village air, ${name}.`,
  (name: string) => `Any news, ${name}?`,
];

const RAIN_GREETINGS = [
  (name: string) => `Stay dry, ${name}!`,
  (name: string) => `Rain's good for wheat, ${name}.`,
  (name: string) => `Cozy weather for stew, ${name}!`,
];

const SOCIAL_REPLIES = ["Doing well!", "Keeping busy!", "Cheers!", "Same to you!", "Always!"];

function hashString(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function drawSpeechBubble(
  text: string,
  accent: string,
): { texture: THREE.CanvasTexture; aspect: number } {
  const canvas = document.createElement("canvas");
  canvas.width = 560;
  canvas.height = 144;
  const ctx = canvas.getContext("2d")!;

  ctx.font = '700 34px "Inter", -apple-system, BlinkMacSystemFont, sans-serif';
  const measured = ctx.measureText(text).width;
  const padX = 32;
  const boxW = Math.max(180, Math.min(532, Math.ceil(measured + padX * 2)));
  const boxH = 78;
  const x = (canvas.width - boxW) / 2;
  const y = 18;
  const tailY = y + boxH;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Subtle shadow
  ctx.save();
  ctx.shadowColor = "rgba(0, 0, 0, 0.5)";
  ctx.shadowBlur = 14;
  ctx.shadowOffsetY = 6;

  // Rounded speech bubble + bottom comic pointer tail
  ctx.fillStyle = "rgba(14, 21, 34, 0.94)";
  ctx.beginPath();
  ctx.roundRect(x, y, boxW, boxH, 22);
  ctx.fill();
  ctx.restore();

  // Speech tail triangle
  ctx.fillStyle = "rgba(14, 21, 34, 0.94)";
  ctx.beginPath();
  ctx.moveTo(canvas.width / 2 - 14, tailY - 2);
  ctx.lineTo(canvas.width / 2 + 14, tailY - 2);
  ctx.lineTo(canvas.width / 2, tailY + 20);
  ctx.closePath();
  ctx.fill();

  // Crisp accent border
  ctx.strokeStyle = accent;
  ctx.lineWidth = 4.5;
  ctx.beginPath();
  ctx.roundRect(x, y, boxW, boxH, 22);
  ctx.stroke();

  // Tail accent V-stroke
  ctx.beginPath();
  ctx.moveTo(canvas.width / 2 - 13, tailY);
  ctx.lineTo(canvas.width / 2, tailY + 19);
  ctx.lineTo(canvas.width / 2 + 13, tailY);
  ctx.stroke();

  // Bubble label text
  ctx.fillStyle = "#f5f8fc";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, canvas.width / 2, y + boxH / 2 + 1, boxW - 28);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return { texture, aspect: canvas.width / canvas.height };
}

function buildBubblesForEvent(
  ev: SimEvent,
  entitiesById: ReadonlyMap<string, Entity>,
  weather: Weather,
): BubbleSpec[] {
  const accent = ACCENT_BY_KIND[ev.kind];

  switch (ev.kind) {
    case "trade": {
      const item = ev.item ?? "goods";
      const gold = ev.gold ?? 0;
      const qtyPrefix = ev.qty && ev.qty > 1 ? `${ev.qty} ` : "";
      const specs: BubbleSpec[] = [];
      if (ev.entityId) {
        specs.push({
          entityId: ev.entityId,
          fallbackPlace: ev.place,
          text: `🪙 Bought ${qtyPrefix}${item} (-${gold}g)`,
          accent,
          delay: 0,
          duration: 2.8,
        });
      }
      if (ev.otherEntityId) {
        specs.push({
          entityId: ev.otherEntityId,
          fallbackPlace: ev.place,
          text: `💰 +${gold}g sold ${qtyPrefix}${item}`,
          accent: "#ffd27a",
          delay: 0.22,
          duration: 2.6,
        });
      }
      return specs;
    }

    case "produce": {
      if (!ev.entityId || !ev.item) return [];
      const [icon, verb] = PRODUCE_VERBS[ev.item];
      const qty = ev.qty ?? 1;
      const label = qty > 1 ? `${icon} ${verb} ${qty} ${ev.item}` : `${icon} ${verb} ${ev.item}`;
      return [
        {
          entityId: ev.entityId,
          fallbackPlace: ev.place,
          text: label,
          accent,
          delay: 0,
          duration: 2.4,
        },
      ];
    }

    case "eat": {
      if (!ev.entityId) return [];
      const icon = ev.item === "stew" ? "🍲" : "🥖";
      return [
        {
          entityId: ev.entityId,
          fallbackPlace: ev.place,
          text: `${icon} Eating ${ev.item ?? "meal"}`,
          accent,
          delay: 0,
          duration: 2.3,
        },
      ];
    }

    case "socialize": {
      if (!ev.entityId) return [];
      const other = ev.otherEntityId ? entitiesById.get(ev.otherEntityId) : undefined;
      const seedIdx = hashString(`${ev.day}:${ev.tick}:${ev.entityId}`);

      if (other) {
        const pool = weather === "rain" ? RAIN_GREETINGS : SOCIAL_GREETINGS;
        const greeting = pool[seedIdx % pool.length]!(other.name);
        const reply = SOCIAL_REPLIES[(seedIdx >>> 4) % SOCIAL_REPLIES.length]!;
        return [
          {
            entityId: ev.entityId,
            fallbackPlace: ev.place,
            text: `💬 "${greeting}"`,
            accent,
            delay: 0,
            duration: 2.7,
          },
          {
            entityId: other.id,
            fallbackPlace: ev.place,
            text: `💬 "${reply}"`,
            accent: "#9ad0ff",
            delay: 0.32,
            duration: 2.3,
          },
        ];
      }

      return [
        {
          entityId: ev.entityId,
          fallbackPlace: ev.place,
          text: "💬 Taking in the square",
          accent,
          delay: 0,
          duration: 2.1,
        },
      ];
    }

    case "gossip": {
      if (!ev.entityId || !ev.rumorSummary) return [];
      const specs: BubbleSpec[] = [
        {
          entityId: ev.entityId,
          fallbackPlace: ev.place,
          text: `🗣️ "${ev.rumorSummary}"`,
          accent,
          delay: 0,
          duration: 2.9,
        },
      ];
      if (ev.otherEntityId) {
        specs.push({
          entityId: ev.otherEntityId,
          fallbackPlace: ev.place,
          text: '💬 "Good to know!"',
          accent: "#c4b0ff",
          delay: 0.35,
          duration: 2.2,
        });
      }
      return specs;
    }

    case "gift": {
      if (!ev.entityId || !ev.item) return [];
      const other = ev.otherEntityId ? entitiesById.get(ev.otherEntityId) : undefined;
      const specs: BubbleSpec[] = [
        {
          entityId: ev.entityId,
          fallbackPlace: ev.place,
          text: `🎁 Shared ${ev.item}${other ? ` with ${other.name}` : ""}`,
          accent,
          delay: 0,
          duration: 2.8,
        },
      ];
      if (ev.otherEntityId) {
        specs.push({
          entityId: ev.otherEntityId,
          fallbackPlace: ev.place,
          text: '💖 "Thank you!"',
          accent: "#ffc2d6",
          delay: 0.28,
          duration: 2.4,
        });
      }
      return specs;
    }

    case "wage": {
      if (!ev.entityId || !ev.gold) return [];
      const entity = entitiesById.get(ev.entityId);
      const label = entity?.role === "child" ? "allowance" : "guard wage";
      return [
        {
          entityId: ev.entityId,
          fallbackPlace: ev.place,
          text: `💰 +${ev.gold}g ${label}`,
          accent,
          delay: 0,
          duration: 2.6,
        },
      ];
    }

    case "demand": {
      if (!ev.entityId || !ev.gold) return [];
      return [
        {
          entityId: ev.entityId,
          fallbackPlace: ev.place,
          text: `🏛️ Town bought ${ev.item ?? "goods"} (+${ev.gold}g)`,
          accent,
          delay: 0,
          duration: 2.7,
        },
      ];
    }

    case "rest": {
      if (!ev.entityId) return [];
      return [
        {
          entityId: ev.entityId,
          fallbackPlace: ev.place,
          text: "💤 Resting",
          accent,
          delay: 0,
          duration: 2.0,
        },
      ];
    }

    case "deadlock": {
      if (!ev.entityId) return [];
      const text = ev.gold ? `🏦 +${ev.gold}g credit` : "🥣 Pantry ration";
      return [
        {
          entityId: ev.entityId,
          fallbackPlace: ev.place,
          text,
          accent,
          delay: 0,
          duration: 2.5,
        },
      ];
    }

    default:
      return [];
  }
}

export class SpeechBubbleLayer {
  readonly group = new THREE.Group();
  private readonly placeMap: Map<string, PlaceNode>;
  private readonly active: ActiveBubble[] = [];
  private enabled = true;

  constructor(places: readonly PlaceNode[]) {
    this.group.name = "speech-bubbles-layer";
    this.placeMap = new Map(places.map((p) => [p.id, p]));
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.group.visible = enabled;
    if (!enabled) {
      this.clearAll();
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  clearAll(): void {
    for (const b of this.active) {
      this.disposeBubble(b);
    }
    this.active.length = 0;
  }

  spawnFromEvents(
    events: readonly SimEvent[],
    entities: readonly Entity[],
    weather: Weather,
    getEntityPos: (entityId: string) => THREE.Vector3 | null,
  ): void {
    if (!this.enabled || events.length === 0) return;

    const entitiesById = new Map(entities.map((e) => [e.id, e]));
    // Track entities who already traded this tick so a same-tick eat doesn't overwrite the trade callout
    const tradedThisTick = new Set<string>();
    for (const ev of events) {
      if (ev.kind === "trade" && ev.entityId) tradedThisTick.add(ev.entityId);
    }

    for (const ev of events) {
      if (ev.kind === "eat" && ev.entityId && tradedThisTick.has(ev.entityId)) {
        continue;
      }
      const specs = buildBubblesForEvent(ev, entitiesById, weather);
      for (const spec of specs) {
        const anchor = this.resolveAnchor(spec, getEntityPos);
        if (!anchor) continue;

        // Replace any existing bubble on the same entity so bubbles never pile up
        if (spec.entityId) {
          for (let i = this.active.length - 1; i >= 0; i--) {
            if (this.active[i]!.entityId === spec.entityId) {
              this.disposeBubble(this.active[i]!);
              this.active.splice(i, 1);
            }
          }
        }

        const { texture, aspect } = drawSpeechBubble(spec.text, spec.accent);
        const material = new THREE.SpriteMaterial({
          map: texture,
          transparent: true,
          opacity: 0,
          depthWrite: false,
          depthTest: false,
        });
        const sprite = new THREE.Sprite(material);
        sprite.renderOrder = 20;
        const baseScaleY = 1.52;
        const baseScaleX = baseScaleY * aspect;
        sprite.scale.set(0.01, 0.01, 1);
        sprite.position.set(anchor.x, anchor.y + 3.65, anchor.z);
        sprite.visible = spec.delay <= 0;
        this.group.add(sprite);

        this.active.push({
          entityId: spec.entityId,
          anchorPos: anchor,
          sprite,
          texture,
          material,
          age: -spec.delay,
          delay: spec.delay,
          duration: spec.duration,
          baseScaleX,
          baseScaleY,
        });
      }
    }
  }

  private resolveAnchor(
    spec: BubbleSpec,
    getEntityPos: (entityId: string) => THREE.Vector3 | null,
  ): THREE.Vector3 | null {
    if (spec.entityId) {
      const p = getEntityPos(spec.entityId);
      if (p) return p;
    }
    if (spec.fallbackPlace) {
      const place = this.placeMap.get(spec.fallbackPlace);
      if (place) return new THREE.Vector3(place.x, 0, place.z);
    }
    return null;
  }

  update(dt: number, getEntityPos: (entityId: string) => THREE.Vector3 | null): void {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const b = this.active[i]!;
      b.age += dt;

      if (b.age < 0) {
        b.sprite.visible = false;
        continue;
      }

      if (b.age >= b.duration) {
        this.disposeBubble(b);
        this.active.splice(i, 1);
        continue;
      }

      b.sprite.visible = true;

      // Follow the villager smoothly while walking
      if (b.entityId) {
        const live = getEntityPos(b.entityId);
        if (live) b.anchorPos.copy(live);
      }

      const progress = b.age / b.duration;
      // Snappy pop-in spring over first 14%, hold crisp, fade out over final 26%
      let scaleFactor = 1;
      let opacity = 1;
      if (progress < 0.14) {
        const t = progress / 0.14;
        // Slight overshoot pop
        scaleFactor = 0.55 + Math.sin(t * Math.PI * 0.65) * 0.52;
        opacity = Math.min(1, t * 1.4);
      } else if (progress > 0.74) {
        const t = (progress - 0.74) / 0.26;
        opacity = Math.max(0, 1 - t);
        scaleFactor = 1 - t * 0.08;
      }

      const floatOffset = 3.65 + progress * 0.85;
      b.sprite.position.set(b.anchorPos.x, floatOffset, b.anchorPos.z);
      b.sprite.scale.set(b.baseScaleX * scaleFactor, b.baseScaleY * scaleFactor, 1);
      b.material.opacity = opacity;
    }
  }

  private disposeBubble(b: ActiveBubble): void {
    this.group.remove(b.sprite);
    b.material.dispose();
    b.texture.dispose();
  }

  dispose(): void {
    this.clearAll();
  }
}
