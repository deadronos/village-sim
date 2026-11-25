# Village Sim

An autonomous, deterministic village simulation where 8 inhabitants (farmer, baker, innkeeper, woodcutter, smith, herbalist, guard, child) run their daily lives through a pluggable **typed-decision provider** (System One or offline scripted fallback) while deterministic TypeScript owns the place graph, economy, inventory, gating, and invariants — paired with an interactive **low-poly WebGPU Three.js** 3D village viewer.

## Stack

- **TypeScript 7** (`tsc` native compiler), **pnpm** workspaces
- **Oxlint** + **Oxfmt** for linting and formatting
- **Vitest** for unit, contract, property, and determinism/replay tests
- **Node 26** headless CLI & live SSE/REST backend (`@village/server`)
- **Vite 8** + **Three.js `WebGPURenderer`** (automatic WebGL2 fallback) low-poly 3D diorama (`@village/web`)

## Quick Start

```bash
pnpm install

# Launch both the live simulation backend (port 4173) and Vite 3D viewer (port 5173)
pnpm dev
```

Open **http://localhost:5173** to watch the low-poly village live, click any villager to inspect their live probability distribution and serialized `--explain` prompt, adjust speed/seed/provider, or replay saved `.jsonl` runs in 3D.

## CLI Usage

```bash
# Run 3 simulated days offline with the zero-dependency scripted provider
# (writes runs/seed-7.jsonl relative to your current directory; override with --out)
pnpm village run --seed 7 --days 3 --provider scripted

# Run against a local System One endpoint (e.g. Kev / Jev)
pnpm village run --seed 7 --days 3 --provider systemone --endpoint http://127.0.0.1:8009/v1/systemone

# Verify deterministic replay reproduces every per-tick SHA-256 state hash
pnpm village replay runs/seed-7.jsonl

# Inspect the exact serialized instruction & probability distribution for an entity
pnpm village explain --run runs/seed-7.jsonl --entity anna

# Start only the live simulation backend server
pnpm village serve --port 4173 --seed 7 --days 7
```

## Configuration Precedence

`CLI flags > Environment variables > village.config.json > Defaults`

Supported environment variables:

```bash
DECISION_PROVIDER=scripted        # scripted | systemone | replay
DECISION_ENDPOINT=http://127.0.0.1:8009/v1/systemone
DECISION_MODEL=kev-latest
DECISION_TIMEOUT_MS=120000
DECISION_BATCH=auto               # auto | always | never
DECISION_SAMPLE=weighted          # weighted | argmax
DECISION_MIN_CONF=0.34
DECISION_API_KEY=                 # optional bearer token
```

## Verification Commands

```bash
pnpm typecheck   # TypeScript 7 project-reference typecheck
pnpm lint        # Oxlint
pnpm fmt:check   # Oxfmt check
pnpm test        # Vitest (gating, economy, 1000-tick invariants, System One fixture, determinism & replay, CLI & server)
pnpm build       # Build core, server, and Vite web bundle
```

## Architecture

- [`packages/core`](packages/core/src): Portable deterministic simulation engine (place graph with Dijkstra shortest paths, recipes/trades/wages/caps/invariants, data-driven gating table, compact prompt serializer, per-entity seeded PRNG, synchronous SHA-256 canonical state hashing, `ScriptedProvider`, `SystemOneProvider`, `ReplayProvider`).
- [`packages/server`](packages/server/src): CLI (`run`, `replay`, `explain`, `serve`) and zero-dependency Node HTTP + SSE live backend server.
- [`packages/web`](packages/web/src): Vite + Three.js `WebGPURenderer` low-poly floating island diorama with procedural landmarks, cobblestone roads matching the place graph, animated villagers, dynamic day/night lighting & weather, and an interactive inspector HUD.
