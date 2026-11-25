/**
 * Deterministic PRNG keyed per (seed, day, tick, entityId) so adding or removing
 * entities never shifts another entity's random draws.
 */
export interface SeededRng {
  /** Returns a float in [0, 1). */
  next(): number;
  /** Returns an integer in [0, max). */
  nextInt(max: number): number;
  /** Picks a key from a probability distribution using weighted sampling. */
  sampleWeighted(probabilities: Record<string, number>): { key: string; prob: number };
}

function fnv1a32(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(initialSeed: number): () => number {
  let a = initialSeed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createStreamRng(
  seed: number,
  day: number,
  tick: number,
  entityId: string,
  salt = "",
): SeededRng {
  const key = `${seed}|${day}|${tick}|${entityId}|${salt}`;
  // Mix twice for extra avalanche across adjacent ticks/seeds
  const h1 = fnv1a32(key);
  const h2 = fnv1a32(`${h1}:${key}`);
  const gen = mulberry32((h1 ^ Math.imul(h2, 0x9e3779b1)) >>> 0);
  // Warm up two rounds
  gen();
  gen();

  return {
    next: () => gen(),
    nextInt: (max: number) => {
      if (max <= 1) return 0;
      return Math.floor(gen() * max);
    },
    sampleWeighted: (probabilities: Record<string, number>) => {
      const entries = Object.entries(probabilities)
        .filter(([, p]) => Number.isFinite(p) && p > 0)
        .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

      if (entries.length === 0) {
        const keys = Object.keys(probabilities).toSorted();
        const fallbackKey = keys[0] ?? "";
        return { key: fallbackKey, prob: 0 };
      }

      const total = entries.reduce((sum, [, p]) => sum + p, 0);
      const roll = gen() * total;
      let acc = 0;
      for (const [k, p] of entries) {
        acc += p;
        if (roll < acc) {
          return { key: k, prob: p / total };
        }
      }
      const last = entries[entries.length - 1]!;
      return { key: last[0], prob: last[1] / total };
    },
  };
}

export function pickArgmax(probabilities: Record<string, number>): { key: string; prob: number } {
  const entries = Object.entries(probabilities)
    .filter(([, p]) => Number.isFinite(p) && p >= 0)
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  if (entries.length === 0) return { key: "", prob: 0 };
  const total = entries.reduce((sum, [, p]) => sum + p, 0);
  let best = entries[0]!;
  for (const entry of entries) {
    if (entry[1] > best[1]) {
      best = entry;
    }
  }
  return { key: best[0], prob: total > 0 ? best[1] / total : 0 };
}
