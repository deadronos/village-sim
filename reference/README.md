# village-sim

An autonomous village where every NPC's next move is a **typed decision** from a
local System One model (Jared Palmer's [Kev](https://github.com/jaredpalmer/kev)
serving TypeSafe's `/v1/systemone` contract). No chat model, no LLM prose — the
model returns probabilities over a fixed set of actions and the simulation acts
on them.

```
$ python -m village --seed 11
=== day 1 · weather clear ===
  dawn plans: anna=duty, bram=earn, cilla=duty, dorn=duty, elin=socialize, fenn=earn, gus=duty, hale=duty
  06:40  dorn harvests 4 wheat
  07:00  anna draws water at the well
  07:20  anna bakes 2 loaves
  08:00  fenn buys bread from anna for 4g
  ...
--- day 1 (clear) ---
name    gold  meals  stock
anna      19      2  water:1, wheat:1
bram       3      3  -
cilla     14      2  -
dorn      27      2  wheat:18
...
total trades: 22 · model calls: 48 · fallbacks: 0
```

## How it works

Three layers, cheapest to most expensive:

1. **Dawn plan (once per day, one batched call).** Each NPC picks a focus —
   `duty`, `earn`, `socialize`, `rest` — which becomes context for the day.
2. **Action decisions (on demand, one batched call per tick).** Every NPC without
   a current goal gets one question in a single request:
   `work / buy_food / restock / socialize / rest / patrol / wander`.
   The model sees that NPC's role, place, gold, stock, needs, memory and focus.
3. **Micro-steering (free).** Walking, production, eating, trades and payroll are
   plain Python. No model calls between decisions.

A day is 06:00–22:00 in 20-minute ticks. With 8 NPCs a full day costs **48 model
calls** and runs in about 80 seconds against a 4B model on an M4.

## The one rule that matters

**The model picks intent; code owns arithmetic, constraints and gating.**

- Choices are sampled from the returned distribution (not `argmax`), so two
  identical villagers still diverge.
- The economy layer rejects unaffordable purchases, applies stock caps and
  executes the transaction. The model never adds or subtracts.
- **Action gating is essential.** With all six actions always offered, the model
  collapsed into `wander` (59) and `rest` (52) out of ~150 decisions and the town
  idled. Offering only currently-meaningful actions (`rest` when energy < 0.45,
  `restock` only when someone actually has stock, `buy_food` forced above
  hunger 0.8) turned the same model into a working village: 61 work decisions and
  13–22 trades per day.

## Economy

```
dorn (farmer) --wheat 4g--> anna (baker) --bread 4g--> fenn (innkeeper) --stew 7g--> villagers
                                  |                        ^
                                  +--water (well)---------+
gus (wood) --> bram (smithy), hale (herbs) --> town, cilla (guard wage), elin (child allowance)
```

Trades are person-to-person: the buyer walks to the seller's workplace, pays,
and stock moves. Institutional demand at noon and 18:00 keeps the secondary
trades (wood, herbs) alive.

## Run it

```bash
# needs a System One server on 127.0.0.1:8009 (see below)
python3 -m village --seed 7 --days 1

# no model at all — scripted utility fallback, good for testing logic
python3 -m village --seed 7 --no-llm

# other seeds / multiple days / custom endpoint
python3 -m village --seed 3 --days 3 --url http://127.0.0.1:8009/v1/systemone
```

Stdlib only. Every decision is appended to `runs/seed-<n>.jsonl` with the full
probability distribution, so a run is auditable and replayable.

Starting the model server (Kev, open weights):

```bash
python -m kev.serve --run models/kev-4b-qwen3 --port 8009
```

## Scope

Included: needs, roles, production, person-to-person trade, wages, memory
strings, affinity, day planning, decision log, deterministic seeding.

Not included: a spatial map (travel is one tick to a named place), save/load,
relationship persistence across days, price discovery, dialogue text.

## Numbers behind the design

Measured on the local 4B Kev server while building this:

| Workload | Latency | Throughput |
|---|---|---|
| 1 NPC, 5 typed questions | 0.96 s | ~1.0 /s |
| 6 NPCs, one batched call | 1.35 s | 4.4 /s |
| 12 NPCs, one batched call | 1.86 s | 6.5 /s |
| 24 NPCs, one batched call | 3.48 s | 6.9 /s |

Batching is the whole game: throughput plateaus near 7 decisions/s, so a
40-NPC village re-deciding every 10 s fits comfortably on one M4.
