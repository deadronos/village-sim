"""Batched typed decisions against the local System One model."""

from __future__ import annotations

import json
import random
import urllib.request

from . import config
from . import world as W

WORK_LABEL = {
    "baker": "bake bread at the bakery",
    "farmer": "work the wheat fields",
    "woodcutter": "cut wood in the woods",
    "herbalist": "gather herbs in the garden",
    "blacksmith": "do repairs at the smithy",
    "innkeeper": "cook and serve at the tavern",
    "guard": "keep watch",
    "child": "help out or play",
}


def _criteria(npc, world) -> dict[str, str]:
    """Only offer actions that are meaningful right now (state-gated)."""
    if npc.hunger > 0.8:
        return {"buy_food": "find food now, they are starving"}
    out: dict[str, str] = {"work": WORK_LABEL.get(npc.title, "do their trade")}
    if npc.hunger > 0.4 or npc.stock("bread") or npc.stock("stew"):
        out["buy_food"] = "find food and eat"
    missing = W.missing_inputs(npc) if npc.title in ("baker", "innkeeper") else []
    if missing and ("water" in missing or any(W.supplier_for(world, i) for i in missing)):
        out["restock"] = "gather the supplies their trade needs"
    if npc.energy < 0.45:
        out["rest"] = "go home and recover"
    if npc.social < 0.75:
        out["socialize"] = "seek company and talk to someone"
    if npc.title == "guard":
        out["patrol"] = "walk the village on guard duty"
    if npc.title == "child" or len(out) == 1:
        out["wander"] = "idle about the village"
    return out


def _describe(npc, world) -> str:
    stock = ", ".join(f"{k} {v}" for k, v in npc.inventory.items() if v) or "nothing"
    mem = "; ".join(npc.memory) or "nothing recent"
    duty = WORK_LABEL.get(npc.title, "their trade")
    phase = "It is early, so the day's work comes first." if world.minute < 10 * 60 else ""
    return (
        f"{npc.name} the {npc.title}, at {config.place_name(npc.location)}. "
        f"Gold {npc.gold}g, carrying {stock}. "
        f"Hunger {npc.hunger:.2f}, energy {npc.energy:.2f}, social {npc.social:.2f}. "
        f"The village relies on {npc.name} to {duty}. Today's focus: {npc.focus}. "
        f"{phase} Recent: {mem}. It is {world.minute // 60:02d}:{world.minute % 60:02d}, "
        f"weather {world.weather}."
    )


def _summary(world) -> str:
    places = ", ".join(config.place_name(p) for p in config.PLACES)
    return f"A small village on a {world.weather} day. Places: {places}."


def _sample(probs: dict[str, float], rng: random.Random) -> str | None:
    if not probs:
        return None
    names = list(probs)
    weights = [max(0.0, probs[n]) for n in names]
    if sum(weights) <= 0:
        return rng.choice(names)
    return rng.choices(names, weights=weights, k=1)[0]


class KevClient:
    """Talks to a System One server. Falls back to nothing when disabled."""

    def __init__(self, url: str = config.KEV_URL, model: str = config.KEV_MODEL,
                 enabled: bool = True, timeout: int = 120):
        self.url = url
        self.model = model
        self.enabled = enabled
        self.timeout = timeout
        self.calls = 0
        self.failures = 0

    def _post(self, payload: dict) -> dict:
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            self.url, data=data, headers={"Content-Type": "application/json"}, method="POST"
        )
        with urllib.request.urlopen(req, timeout=self.timeout) as resp:
            return json.load(resp)

    def decide(self, world, npcs, rng: random.Random) -> dict[str, tuple[str, dict]]:
        questions = {
            f"act_{npc.name}": {
                "type": "choice",
                "instructions": _describe(npc, world),
                "criteria": _criteria(npc, world),
            }
            for npc in npcs
        }
        if not self.enabled or not questions:
            return {}
        payload = {"model": self.model, "state": _summary(world), "questions": questions}
        try:
            body = self._post(payload)
            self.calls += 1
        except Exception as exc:  # noqa: BLE001
            self.failures += 1
            print(f"  ! decision call failed: {exc}", flush=True)
            return {}
        answers = body.get("answers", {})
        out = {}
        for npc in npcs:
            answer = answers.get(f"act_{npc.name}", {})
            probs = answer.get("probabilities") or {}
            choice = _sample(probs, rng) or answer.get("choice")
            if choice:
                out[npc.name] = (choice, probs)
        return out

    def plan(self, world, npcs, rng: random.Random) -> dict[str, str]:
        criteria = {
            "duty": "focus on their trade",
            "earn": "focus on earning coin",
            "socialize": "focus on people",
            "rest": "take it easy today",
        }
        questions = {
            f"focus_{npc.name}": {
                "type": "choice",
                "instructions": f"How should {npc.name} the {npc.title} spend this {world.weather} day?",
                "criteria": criteria,
            }
            for npc in npcs
        }
        if not self.enabled:
            return {}
        payload = {"model": self.model, "state": _summary(world), "questions": questions}
        try:
            body = self._post(payload)
            self.calls += 1
        except Exception as exc:  # noqa: BLE001
            self.failures += 1
            print(f"  ! plan call failed: {exc}", flush=True)
            return {}
        answers = body.get("answers", {})
        out = {}
        for npc in npcs:
            answer = answers.get(f"focus_{npc.name}", {})
            focus = _sample(answer.get("probabilities") or {}, rng) or answer.get("choice")
            if focus:
                out[npc.name] = focus
        return out
