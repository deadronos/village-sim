import { PLACE_MAP } from "./places.ts";
import { createStreamRng } from "./rng.ts";
import type { Entity, ItemKind, Role, SimConfig, Weather, WorldState } from "./types.ts";

export const WEATHER_OPTIONS: readonly Weather[] = ["clear", "breezy", "overcast", "rain"] as const;

export const MEMORY_LIMIT = 4;

export function clamp01(value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return Math.round(value * 1000) / 1000;
}

export function formatSimTime(tick: number, minutesPerTick = 15, startHour = 6): string {
  const totalMinutes = startHour * 60 + tick * minutesPerTick;
  const hours = Math.floor(totalMinutes / 60) % 24;
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

export function getStock(entity: Entity, item: ItemKind): number {
  return entity.inventory[item] ?? 0;
}

export function setStock(entity: Entity, item: ItemKind, qty: number): void {
  if (qty <= 0) {
    delete entity.inventory[item];
  } else {
    entity.inventory[item] = qty;
  }
}

export function addStock(entity: Entity, item: ItemKind, delta: number): void {
  setStock(entity, item, getStock(entity, item) + delta);
}

export function pushMemory(entity: Entity, entry: string): void {
  entity.memory.push(entry);
  while (entity.memory.length > MEMORY_LIMIT) {
    entity.memory.shift();
  }
}

export function pickWeatherForDay(seed: number, day: number): Weather {
  const rng = createStreamRng(seed, day, -2, "__world__", "weather");
  const roll = rng.next();
  if (roll < 0.45) return "clear";
  if (roll < 0.7) return "breezy";
  if (roll < 0.88) return "overcast";
  return "rain";
}

interface EntityTemplate {
  id: string;
  name: string;
  role: Role;
  duty: string;
  workplace: string;
  gold: number;
  inventory: Partial<Record<ItemKind, number>>;
  hunger: number;
  energy: number;
  social: number;
}

const INITIAL_TEMPLATES: readonly EntityTemplate[] = [
  {
    id: "dorn",
    name: "Dorn",
    role: "farmer",
    duty: "harvest wheat",
    workplace: "fields",
    gold: 18,
    inventory: { wheat: 4, bread: 1 },
    hunger: 0.24,
    energy: 0.88,
    social: 0.62,
  },
  {
    id: "anna",
    name: "Anna",
    role: "baker",
    duty: "bake bread",
    workplace: "bakery",
    gold: 20,
    inventory: { wheat: 2, water: 2, bread: 3 },
    hunger: 0.22,
    energy: 0.86,
    social: 0.65,
  },
  {
    id: "bram",
    name: "Bram",
    role: "innkeeper",
    duty: "cook stew",
    workplace: "tavern",
    gold: 24,
    inventory: { bread: 3, water: 2, stew: 3 },
    hunger: 0.2,
    energy: 0.84,
    social: 0.7,
  },
  {
    id: "cora",
    name: "Cora",
    role: "woodcutter",
    duty: "chop wood",
    workplace: "woods",
    gold: 16,
    inventory: { wood: 3, bread: 1 },
    hunger: 0.26,
    energy: 0.9,
    social: 0.58,
  },
  {
    id: "torin",
    name: "Torin",
    role: "smith",
    duty: "forge tools",
    workplace: "smithy",
    gold: 18,
    inventory: { wood: 2, tool: 1, bread: 1 },
    hunger: 0.25,
    energy: 0.85,
    social: 0.56,
  },
  {
    id: "mira",
    name: "Mira",
    role: "herbalist",
    duty: "gather herbs",
    workplace: "garden",
    gold: 18,
    inventory: { herbs: 2, bread: 1 },
    hunger: 0.22,
    energy: 0.87,
    social: 0.64,
  },
  {
    id: "garrick",
    name: "Garrick",
    role: "guard",
    duty: "patrol the village",
    workplace: "market",
    gold: 22,
    inventory: { bread: 1 },
    hunger: 0.24,
    energy: 0.88,
    social: 0.6,
  },
  {
    id: "pip",
    name: "Pip",
    role: "child",
    duty: "help neighbors and play",
    workplace: "well",
    gold: 14,
    inventory: { bread: 1 },
    hunger: 0.28,
    energy: 0.92,
    social: 0.68,
  },
];

export function createInitialWorld(
  config: Pick<SimConfig, "seed" | "ticksPerDay" | "minutesPerTick" | "startHour">,
): WorldState {
  const entities: Entity[] = INITIAL_TEMPLATES.map((tpl) => {
    const home = `home_${tpl.id}`;
    if (!PLACE_MAP.has(home) || !PLACE_MAP.has(tpl.workplace)) {
      throw new Error(`Invalid home/workplace for ${tpl.id}`);
    }
    const affinity: Record<string, number> = {};
    for (const other of INITIAL_TEMPLATES) {
      if (other.id !== tpl.id) {
        affinity[other.id] = 0.5;
      }
    }
    return {
      id: tpl.id,
      name: tpl.name,
      role: tpl.role,
      title: `${tpl.name} the ${tpl.role}`,
      duty: tpl.duty,
      home,
      workplace: tpl.workplace,
      location: home,
      prevLocation: home,
      gold: tpl.gold,
      inventory: { ...tpl.inventory },
      needs: {
        hunger: tpl.hunger,
        energy: tpl.energy,
        social: tpl.social,
      },
      focus: "duty",
      goal: null,
      memory: [],
      affinity,
      mealsToday: 0,
      tradesToday: 0,
    };
  });

  const initialTotalGold = entities.reduce((sum, e) => sum + e.gold, 0);

  return {
    seed: config.seed,
    day: 1,
    tick: 0,
    minutesPerTick: config.minutesPerTick,
    ticksPerDay: config.ticksPerDay,
    startHour: config.startHour,
    weather: pickWeatherForDay(config.seed, 1),
    entities,
    initialTotalGold,
    totalGoldMinted: 0,
    tradesToday: 0,
    tradesTotal: 0,
    breadProducedToday: 0,
    stewProducedToday: 0,
    mealsToday: 0,
    deadlockCounter: {},
  };
}

export function getEntityById(world: WorldState, id: string): Entity | undefined {
  return world.entities.find((e) => e.id === id);
}

export function resetEntitiesForNewDay(world: WorldState, nextDay: number): void {
  world.day = nextDay;
  world.tick = 0;
  world.weather = pickWeatherForDay(world.seed, nextDay);
  world.tradesToday = 0;
  world.breadProducedToday = 0;
  world.stewProducedToday = 0;
  world.mealsToday = 0;
  world.deadlockCounter = {};

  for (const entity of world.entities) {
    // Overnight rest at home restores energy and sets morning hunger
    entity.prevLocation = entity.location;
    entity.location = entity.home;
    entity.goal = null;
    entity.needs.energy = clamp01(Math.max(entity.needs.energy + 0.55, 0.82));
    entity.needs.hunger = clamp01(Math.max(entity.needs.hunger * 0.6, 0.24));
    entity.needs.social = clamp01(Math.max(entity.needs.social, 0.5));
    entity.mealsToday = 0;
    entity.tradesToday = 0;
  }
}

export function cloneEntitiesForSnapshot(entities: Entity[]): Entity[] {
  return entities.map((e) => ({
    ...e,
    inventory: { ...e.inventory },
    needs: { ...e.needs },
    goal: e.goal ? { ...e.goal, route: [...e.goal.route] } : null,
    memory: [...e.memory],
    affinity: { ...e.affinity },
    lastDecision: e.lastDecision
      ? {
          ...e.lastDecision,
          probabilities: { ...e.lastDecision.probabilities },
          criteria: { ...e.lastDecision.criteria },
        }
      : undefined,
  }));
}
