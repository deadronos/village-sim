"""World state and the deterministic economy that the decision model steers."""

from __future__ import annotations

import random
from collections import deque
from dataclasses import dataclass, field

from . import config


def clock(minute: int) -> str:
    return f"{minute // 60:02d}:{minute % 60:02d}"


@dataclass
class NPC:
    name: str
    title: str
    home: str
    workplace: str | None
    sells: str | None
    wage: int
    location: str
    gold: int
    inventory: dict[str, int] = field(default_factory=dict)
    hunger: float = 0.35
    energy: float = 0.8
    social: float = 0.5
    focus: str = "duty"
    goal: dict | None = None
    memory: deque = field(default_factory=lambda: deque(maxlen=4))
    affinity: dict[str, float] = field(default_factory=dict)
    meals: int = 0

    def stock(self, item: str) -> int:
        return self.inventory.get(item, 0)

    def take(self, item: str, n: int = 1) -> None:
        self.inventory[item] = max(0, self.stock(item) - n)

    def give(self, item: str, n: int = 1) -> None:
        self.inventory[item] = self.stock(item) + n

    def remember(self, text: str) -> None:
        self.memory.append(text)


@dataclass
class World:
    seed: int
    day: int = 1
    minute: int = config.DAY_START
    weather: str = "clear"
    npcs: dict[str, NPC] = field(default_factory=dict)
    events: list[dict] = field(default_factory=list)
    trades: int = 0

    def say(self, text: str, kind: str = "event", **kw) -> None:
        self.events.append({"tick_time": clock(self.minute), "kind": kind, "text": text, **kw})


def build_world(seed: int, day: int = 1) -> World:
    rng = random.Random(f"{seed}:{day}:weather")
    weather = rng.choices(["clear", "cloudy", "rain"], weights=[0.55, 0.3, 0.15])[0]
    world = World(seed=seed, day=day, weather=weather)
    for entry in config.ROSTER:
        name = entry["name"]
        npc = NPC(
            name=name,
            title=entry["title"],
            home=config.home_of(name),
            workplace=entry["workplace"],
            sells=entry["sells"],
            wage=entry["wage"],
            location=config.home_of(name),
            gold=2 if entry["title"] == "child" else 10,
            inventory={"bread": 1},
        )
        world.npcs[name] = npc
    return world


def supplier_for(world: World, item: str) -> NPC | None:
    for npc in world.npcs.values():
        if npc.sells == item and npc.stock(item) > 0:
            return npc
    return None


def try_trade(buyer: NPC, item: str, world: World) -> tuple[bool, str]:
    seller = supplier_for(world, item)
    if seller is None:
        return False, f"nobody sells {item}"
    if seller is buyer:
        return False, "self"
    price = config.PRICES[item]
    if buyer.gold < price:
        return False, f"needs {price}g, has {buyer.gold}g"
    buyer.gold -= price
    seller.gold += price
    seller.take(item)
    buyer.give(item)
    world.trades += 1
    world.say(
        f"{buyer.name} buys {item} from {seller.name} for {price}g",
        kind="trade",
        buyer=buyer.name,
        seller=seller.name,
        item=item,
        price=price,
    )
    buyer.remember(f"bought {item} from {seller.name} ({price}g)")
    seller.remember(f"sold {item} to {buyer.name} ({price}g)")
    for who in (buyer, seller):
        other = seller.name if who is buyer else buyer.name
        who.affinity[other] = who.affinity.get(other, 0.0) + 0.02
    return True, price


INPUTS = {
    "baker": ("wheat", "water"),
    "innkeeper": ("bread", "water"),
}


def missing_inputs(npc: NPC) -> list[str]:
    return [item for item in INPUTS.get(npc.title, ()) if npc.stock(item) == 0]


CAPS = {"wheat": 16, "wood": 12, "herbs": 10, "bread": 12, "stew": 8}


def produce(npc: NPC, world: World) -> tuple[bool, str]:
    if npc.title == "farmer":
        if npc.stock("wheat") >= CAPS["wheat"]:
            return True, "has enough wheat for now"
        npc.give("wheat", 4)
        return True, "harvests 4 wheat"
    if npc.title == "woodcutter":
        if npc.stock("wood") >= CAPS["wood"]:
            return True, "has enough wood for now"
        npc.give("wood", 3)
        return True, "cuts 3 wood"
    if npc.title == "herbalist":
        if npc.stock("herbs") >= CAPS["herbs"]:
            return True, "has enough herbs for now"
        npc.give("herbs", 2)
        return True, "gathers 2 herbs"
    if npc.title == "baker":
        if npc.stock("bread") >= CAPS["bread"]:
            return True, "has baked enough for now"
        if npc.stock("wheat") >= 1 and npc.stock("water") >= 1:
            npc.take("wheat")
            npc.take("water")
            npc.give("bread", 2)
            return True, "bakes 2 loaves"
        return False, "has nothing to bake with"
    if npc.title == "innkeeper":
        if npc.stock("bread") >= 1 and npc.stock("water") >= 1:
            npc.take("bread")
            npc.take("water")
            npc.give("stew", 1)
            return True, "cooks a pot of stew"
        return False, "has nothing to cook with"
    if npc.title == "blacksmith":
        npc.gold += 4
        return True, "repairs tools (+4g)"
    if npc.title == "guard":
        return True, "walks the market on watch"
    return True, "wanders about"
