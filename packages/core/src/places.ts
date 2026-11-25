import type { PlaceEdge, PlaceNode } from "./types.ts";

export const VILLAGE_PLACES: readonly PlaceNode[] = [
  { id: "well", name: "Village Well", kind: "well", x: 0, z: 0 },
  { id: "market", name: "Market Square", kind: "market", x: 0, z: -9.5 },
  { id: "bakery", name: "Anna's Bakery", kind: "bakery", x: -10, z: -4 },
  { id: "tavern", name: "Bram's Tavern", kind: "tavern", x: 10, z: -4 },
  { id: "smithy", name: "Torin's Smithy", kind: "smithy", x: 11.5, z: 7.5 },
  { id: "fields", name: "Wheat Fields", kind: "fields", x: -18, z: 6.5 },
  { id: "woods", name: "Pine Woods", kind: "woods", x: 20, z: -1.5 },
  { id: "garden", name: "Herb Garden", kind: "garden", x: -10, z: 12 },

  // Villager cottages tucked around the outer ring
  { id: "home_dorn", name: "Dorn's Cottage", kind: "home", x: -20, z: -2.5, ownerId: "dorn" },
  { id: "home_anna", name: "Anna's Cottage", kind: "home", x: -13.5, z: -12, ownerId: "anna" },
  { id: "home_bram", name: "Bram's Cottage", kind: "home", x: 13.5, z: -12, ownerId: "bram" },
  { id: "home_cora", name: "Cora's Cabin", kind: "home", x: 20.5, z: -10, ownerId: "cora" },
  { id: "home_torin", name: "Torin's Cottage", kind: "home", x: 16.5, z: 13.5, ownerId: "torin" },
  { id: "home_mira", name: "Mira's Cottage", kind: "home", x: -15, z: 17.5, ownerId: "mira" },
  { id: "home_garrick", name: "Guardhouse", kind: "home", x: 4.5, z: -16.5, ownerId: "garrick" },
  { id: "home_pip", name: "Pip's Loft", kind: "home", x: -3.5, z: 11, ownerId: "pip" },
] as const;

export const VILLAGE_EDGES: readonly PlaceEdge[] = [
  // Core village roads
  { from: "well", to: "market", cost: 1 },
  { from: "well", to: "bakery", cost: 1 },
  { from: "well", to: "tavern", cost: 1 },
  { from: "well", to: "smithy", cost: 1 },
  { from: "well", to: "garden", cost: 1 },
  { from: "market", to: "bakery", cost: 1 },
  { from: "market", to: "tavern", cost: 1 },
  { from: "bakery", to: "fields", cost: 1 },
  { from: "fields", to: "garden", cost: 1 },
  { from: "tavern", to: "smithy", cost: 1 },
  { from: "tavern", to: "woods", cost: 1 },
  { from: "smithy", to: "woods", cost: 2 },

  // Cottage lanes
  { from: "home_dorn", to: "fields", cost: 1 },
  { from: "home_dorn", to: "bakery", cost: 1 },
  { from: "home_anna", to: "bakery", cost: 1 },
  { from: "home_anna", to: "market", cost: 1 },
  { from: "home_bram", to: "tavern", cost: 1 },
  { from: "home_bram", to: "market", cost: 1 },
  { from: "home_cora", to: "woods", cost: 1 },
  { from: "home_cora", to: "tavern", cost: 1 },
  { from: "home_torin", to: "smithy", cost: 1 },
  { from: "home_mira", to: "garden", cost: 1 },
  { from: "home_garrick", to: "market", cost: 1 },
  { from: "home_pip", to: "well", cost: 1 },
  { from: "home_pip", to: "garden", cost: 1 },
] as const;

export const PLACE_MAP: ReadonlyMap<string, PlaceNode> = new Map(
  VILLAGE_PLACES.map((p) => [p.id, p]),
);

const ADJACENCY: Map<string, Array<{ to: string; cost: number }>> = new Map();
for (const place of VILLAGE_PLACES) {
  ADJACENCY.set(place.id, []);
}
for (const edge of VILLAGE_EDGES) {
  ADJACENCY.get(edge.from)?.push({ to: edge.to, cost: edge.cost });
  ADJACENCY.get(edge.to)?.push({ to: edge.from, cost: edge.cost });
}
for (const neighbors of ADJACENCY.values()) {
  neighbors.sort((a, b) => (a.to < b.to ? -1 : a.to > b.to ? 1 : 0));
}

export interface RoutePlan {
  /** Sequence of places to visit AFTER the starting location (ends with destination). */
  hops: string[];
  /** Total travel ticks along the shortest path. */
  totalCost: number;
}

/**
 * Deterministic Dijkstra shortest path on the village place graph.
 * Ties are broken lexicographically by place ID.
 */
export function findRoute(from: string, to: string): RoutePlan {
  if (from === to) return { hops: [], totalCost: 0 };
  if (!PLACE_MAP.has(from) || !PLACE_MAP.has(to)) {
    throw new Error(`Unknown place in findRoute: ${from} -> ${to}`);
  }

  const dist = new Map<string, number>();
  const prev = new Map<string, string>();
  const visited = new Set<string>();

  for (const place of VILLAGE_PLACES) {
    dist.set(place.id, Infinity);
  }
  dist.set(from, 0);

  while (visited.size < VILLAGE_PLACES.length) {
    let current: string | null = null;
    let bestDist = Infinity;

    for (const place of VILLAGE_PLACES) {
      if (visited.has(place.id)) continue;
      const d = dist.get(place.id) ?? Infinity;
      if (d < bestDist || (d === bestDist && current !== null && place.id < current)) {
        bestDist = d;
        current = place.id;
      }
    }

    if (current === null || !Number.isFinite(bestDist)) break;
    if (current === to) break;
    visited.add(current);

    const neighbors = ADJACENCY.get(current) ?? [];
    for (const edge of neighbors) {
      if (visited.has(edge.to)) continue;
      const candidate = bestDist + edge.cost;
      const existing = dist.get(edge.to) ?? Infinity;
      if (candidate < existing) {
        dist.set(edge.to, candidate);
        prev.set(edge.to, current);
      }
    }
  }

  const totalCost = dist.get(to) ?? Infinity;
  if (!Number.isFinite(totalCost)) {
    throw new Error(`No route found from ${from} to ${to}`);
  }

  const hops: string[] = [];
  let cursor: string | undefined = to;
  while (cursor && cursor !== from) {
    hops.push(cursor);
    cursor = prev.get(cursor);
  }
  hops.reverse();
  return { hops, totalCost };
}

export function getEdgeCost(from: string, to: string): number {
  if (from === to) return 0;
  const neighbors = ADJACENCY.get(from);
  const edge = neighbors?.find((n) => n.to === to);
  return edge?.cost ?? 1;
}

export function isValidPlace(placeId: string): boolean {
  return PLACE_MAP.has(placeId);
}

export function getPlaceName(placeId: string): string {
  return PLACE_MAP.get(placeId)?.name ?? placeId;
}

export const PATROL_ROUTE: readonly string[] = [
  "market",
  "bakery",
  "well",
  "tavern",
  "smithy",
  "garden",
];
