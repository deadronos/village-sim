"""Tick loop: needs, goals, movement, production, trades, logging."""

from __future__ import annotations

import json
import random
from pathlib import Path

from . import config
from .decide import KevClient
from . import world as W

GOAL_SHAPE = {
    "work": (2, "workplace"),
    "buy_food": (1, "bakery"),
    "restock": (1, "supply"),
    "socialize": (2, "tavern"),
    "rest": (2, "home"),
    "patrol": (2, "random"),
    "wander": (1, "random"),
}


def _target(npc, kind: str, w: W.World) -> str:
    if kind == "work":
        return npc.workplace or npc.home
    if kind == "rest":
        return npc.home
    if kind == "buy_food":
        if W.supplier_for(w, "bread"):
            return "bakery"
        if W.supplier_for(w, "stew"):
            return "tavern"
        return "market"
    if kind == "restock":
        missing = W.missing_inputs(npc)
        if "water" in missing:
            return "well"
        if missing:
            supplier = W.supplier_for(w, missing[0])
            if supplier and supplier.workplace:
                return supplier.workplace
        return npc.workplace or npc.home
    if kind == "socialize":
        return "tavern"
    return random.choice(list(config.PLACES))


def _scripted(npc, w: W.World) -> str:
    if npc.hunger > 0.55 and (npc.stock("bread") or npc.gold >= 3):
        return "buy_food"
    if npc.energy < 0.25:
        return "rest"
    if npc.social < 0.3:
        return "socialize"
    if npc.title == "guard":
        return "patrol"
    return "wander" if npc.title == "child" else "work"


def _eat(npc, item: str, w: W.World) -> None:
    npc.take(item)
    npc.hunger = max(0.0, npc.hunger - config.FOOD_VALUE[item])
    npc.meals += 1
    w.say(f"{npc.name} eats {item}", kind="meal", npc=npc.name, item=item)


def _complete(npc, goal: dict, w: W.World) -> None:
    kind = goal["kind"]
    if kind == "work":
        ok, msg = W.produce(npc, w)
        npc.remember(msg)
        w.say(f"{npc.name} {msg}", kind="work", npc=npc.name)
        if not ok:
            missing = W.missing_inputs(npc)
            available = "water" in missing or any(W.supplier_for(w, i) for i in missing)
            if available:
                npc.remember("went to fetch supplies")
                npc.goal = {"kind": "restock", "target": _target(npc, "restock", w), "left": 1}
            else:
                npc.remember("nothing to restock with")
    elif kind == "restock":
        if npc.location == "well" and "water" in W.missing_inputs(npc):
            npc.give("water", 3)
            npc.remember("fetched water")
            w.say(f"{npc.name} draws water at the well", kind="water", npc=npc.name)
            return
        missing = W.missing_inputs(npc)
        item = missing[0] if missing else "wheat"
        ok, detail = W.try_trade(npc, item, w)
        if not ok:
            w.say(f"{npc.name} cannot buy {item} ({detail})", kind="fail", npc=npc.name)
            npc.remember(f"could not buy {item}")
    elif kind == "buy_food":
        if npc.stock("bread"):
            _eat(npc, "bread", w)
            return
        for item in ("bread", "stew"):
            ok, detail = W.try_trade(npc, item, w)
            if ok:
                _eat(npc, item, w)
                npc.remember(f"ate {item}")
                return
        w.say(f"{npc.name} cannot get food ({detail})", kind="fail", npc=npc.name)
        npc.remember("could not get food")
    elif kind == "socialize":
        npc.social = min(1.0, npc.social + 0.4)
        others = [o for o in w.npcs.values() if o is not npc and o.location == npc.location]
        if others:
            other = random.choice(others)
            npc.affinity[other.name] = npc.affinity.get(other.name, 0.0) + 0.1
            other.affinity[npc.name] = other.affinity.get(npc.name, 0.0) + 0.1
            npc.remember(f"talked with {other.name}")
            other.remember(f"talked with {npc.name}")
            w.say(f"{npc.name} and {other.name} talk", kind="social", npc=npc.name, with_=other.name)
        else:
            w.say(f"{npc.name} finds nobody to talk to", kind="social", npc=npc.name)
    elif kind == "rest":
        npc.energy = min(1.0, npc.energy + 0.5)
        w.say(f"{npc.name} rests at home", kind="rest", npc=npc.name)
    elif kind == "fetch_water":
        npc.give("water", 3)
        npc.remember("fetched water")
        w.say(f"{npc.name} draws water at the well", kind="water", npc=npc.name)
    else:
        w.say(f"{npc.name} wanders", kind="idle", npc=npc.name)


def _assign(npc, kind: str, w: W.World) -> None:
    ticks, shape = GOAL_SHAPE.get(kind, (1, "random"))
    npc.goal = {"kind": kind, "target": _target(npc, kind, w), "left": ticks}


def _execute(npc, w: W.World) -> None:
    goal = npc.goal
    if npc.location != goal["target"]:
        npc.location = goal["target"]
        return
    goal["left"] -= 1
    if goal["left"] > 0:
        return
    npc.goal = None
    _complete(npc, goal, w)


def _decay(w: W.World) -> None:
    for npc in w.npcs.values():
        npc.hunger = min(1.0, npc.hunger + 0.035)
        npc.energy = max(0.0, npc.energy - 0.02)
        npc.social = max(0.0, npc.social - 0.015)


def _market_day(w: W.World) -> None:
    """Institutional demand that keeps the secondary trades alive."""
    if w.minute not in (12 * 60, 18 * 60):
        return
    smith = w.npcs.get("bram")
    gus = w.npcs.get("gus")
    if smith and gus and gus.stock("wood") and smith.gold >= config.PRICES["wood"]:
        price = config.PRICES["wood"]
        smith.gold -= price
        gus.gold += price
        gus.take("wood")
        w.trades += 1
        w.say(f"bram buys firewood from gus ({price}g)", kind="trade")
    hale = w.npcs.get("hale")
    if hale and hale.stock("herbs"):
        bought = min(2, hale.stock("herbs"))
        hale.take("herbs", bought)
        hale.gold += config.PRICES["herbs"] * bought
        w.trades += 1
        w.say(f"the town buys {bought} herbs from hale", kind="trade")


def _payroll(w: W.World) -> None:
    if w.minute != 12 * 60:
        return
    for npc in w.npcs.values():
        if npc.wage:
            npc.gold += npc.wage
            w.say(f"the town pays {npc.name} {npc.wage}g", kind="pay", npc=npc.name)
    child = w.npcs.get("elin")
    dorn = w.npcs.get("dorn")
    if child and dorn and dorn.gold >= 3:
        dorn.gold -= 3
        child.gold += 3
        w.say("dorn gives elin 3g pocket money", kind="pay", npc="elin")


def _log_decision(handle, w: W.World, npc, action: str, probs: dict, fallback: bool) -> None:
    if not handle:
        return
    handle.write(json.dumps({
        "day": w.day, "time": W.clock(w.minute), "npc": npc.name,
        "action": action, "p": probs, "fallback": fallback,
    }, ensure_ascii=False) + "\n")


def run(seed: int = 7, days: int = 1, use_llm: bool = True, verbose: bool = True,
        log_path: str | Path | None = None) -> dict:
    client = KevClient(enabled=use_llm)
    handle = open(log_path, "w", encoding="utf-8") if log_path else None
    stats = {"days": days, "trades": 0, "calls": 0, "failures": 0, "days_data": []}
    try:
        for day in range(1, days + 1):
            w = W.build_world(seed, day)
            rng = random.Random(f"{seed}:{day}")
            focus = client.plan(w, list(w.npcs.values()), rng)
            for name, value in focus.items():
                w.npcs[name].focus = value
            if verbose:
                print(f"\n=== day {day} · weather {w.weather} ===")
                if focus:
                    prints = ", ".join(f"{n}={f}" for n, f in sorted(focus.items()))
                    print(f"  dawn plans: {prints}")
            while w.minute < config.DAY_END:
                _decay(w)
                _payroll(w)
                _market_day(w)
                pending = [n for n in w.npcs.values() if n.goal is None]
                decided = client.decide(w, pending, rng) if pending else {}
                for npc in pending:
                    if npc.name in decided:
                        action, probs = decided[npc.name]
                        fallback = False
                    else:
                        action, probs = _scripted(npc, w), {}
                        fallback = True
                    _assign(npc, action, w)
                    _log_decision(handle, w, npc, action, probs, fallback)
                for npc in w.npcs.values():
                    if npc.goal is not None:
                        _execute(npc, w)
                if verbose and w.events:
                    for event in w.events:
                        print(f"  {event['tick_time']}  {event['text']}")
                    w.events.clear()
                w.minute += config.TICK_MINUTES
            stats["days_data"].append({
                "day": day,
                "weather": w.weather,
                "npcs": {n: {"gold": p.gold, "stock": dict(p.inventory), "meals": p.meals}
                         for n, p in w.npcs.items()},
            })
            stats["trades"] += w.trades
        stats["calls"] = client.calls
        stats["failures"] = client.failures
    finally:
        if handle:
            handle.close()
    return stats


def summarize(stats: dict) -> None:
    for day in stats["days_data"]:
        print(f"\n--- day {day['day']} ({day['weather']}) ---")
        print(f"{'name':6} {'gold':>5}  {'meals':>5}  stock")
        for name, row in day["npcs"].items():
            stock = ", ".join(f"{k}:{v}" for k, v in row["stock"].items() if v) or "-"
            print(f"{name:6} {row['gold']:>5}  {row['meals']:>5}  {stock}")
    print(f"\ntotal trades: {stats['trades']} · model calls: {stats['calls']} · "
          f"fallbacks: {stats['failures']}")
