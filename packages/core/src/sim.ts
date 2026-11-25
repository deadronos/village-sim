import {
  ITEM_CAPS,
  ITEM_PRICES,
  RECIPES,
  applyDeadlockRelief,
  assertWorldInvariants,
  consumeCarriedMeal,
  decayNeeds,
  drawWaterFromWell,
  executeRecipe,
  executeTrade,
  findSuppliersForItem,
  runScheduledEconomyEvents,
} from "./economy.ts";
import { findRestockOption, findSocialPartner, getGatedActions } from "./gating.ts";
import {
  decayRumorsForNewDay,
  maybeRecordFriendshipRumor,
  propagateGossip,
  recordRumor,
  tryCozySurplusExchange,
  updateWorldProsperity,
} from "./gossip.ts";
import { hashWorldState } from "./hash.ts";
import { percentile } from "./log.ts";
import { PATROL_ROUTE, findRoute, getEdgeCost } from "./places.ts";
import { ReplayProvider } from "./providers/replay.ts";
import { ScriptedProvider } from "./providers/scripted.ts";
import { createStreamRng, pickArgmax } from "./rng.ts";
import {
  DAWN_FOCUS_CRITERIA,
  buildDawnQuestion,
  buildTickQuestion,
  serializeWorldState,
} from "./serializer.ts";
import type {
  ActionKind,
  DaySummary,
  DecisionLogRecord,
  DecisionProvider,
  Entity,
  EntityGoal,
  Focus,
  HeaderLogRecord,
  ItemKind,
  JsonlRecord,
  Question,
  SimConfig,
  SimEvent,
  TickHashRecord,
  TickSnapshot,
  WorldState,
} from "./types.ts";
import {
  clamp01,
  cloneEntitiesForSnapshot,
  createInitialWorld,
  formatSimTime,
  getEntityById,
  getStock,
  pushMemory,
  resetEntitiesForNewDay,
} from "./world.ts";

export interface SimulationHooks {
  onEvent?: (event: SimEvent) => void;
  onTick?: (snapshot: TickSnapshot) => void;
  onDayEnd?: (summary: DaySummary) => void;
}

export interface SimulationRunResult {
  world: WorldState;
  summaries: DaySummary[];
  records: JsonlRecord[];
  decisions: DecisionLogRecord[];
  tickHashes: TickHashRecord[];
  events: SimEvent[];
  finalStateHash: string;
}

interface DayTelemetry {
  providerCalls: number;
  providerDecisions: number;
  fallbackDecisions: number;
  escalatedDecisions: number;
  latenciesMs: number[];
}

function emptyTelemetry(): DayTelemetry {
  return {
    providerCalls: 0,
    providerDecisions: 0,
    fallbackDecisions: 0,
    escalatedDecisions: 0,
    latenciesMs: [],
  };
}

const ROLE_LOD_COOLDOWN: Record<Entity["role"], number> = {
  baker: 0,
  innkeeper: 0,
  farmer: 0,
  woodcutter: 2,
  smith: 2,
  herbalist: 2,
  guard: 3,
  child: 3,
};

/**
 * Deterministic Level-of-Detail (LoD) post-action cooldown (§7.1):
 * Critical supply-chain roles (baker, innkeeper, farmer) stay immediately
 * responsive (0 cooldown); secondary craft roles decide every 2nd tick (2);
 * non-critical ambient roles (guard, child) decide every 3rd tick (3).
 * Failed food/restock attempts get 0 cooldown to recover immediately.
 */
export function getPostActionCooldown(
  entity: Entity,
  action: ActionKind,
  succeeded: boolean,
): number {
  if (!succeeded && (action === "buy_food" || action === "restock")) {
    return 0;
  }
  return ROLE_LOD_COOLDOWN[entity.role];
}

/**
 * Selects up to `maxBatch` idle, off-cooldown entities for this tick's batched
 * decision call, prioritizing urgent hunger first and rotating fairly across
 * ticks via deterministic round-robin so no villager is starved.
 */
export function selectEntitiesForTickDecision(world: WorldState, maxBatch: number): Entity[] {
  const eligible = world.entities.filter((e) => e.goal === null && e.decisionCooldown <= 0);
  if (eligible.length <= maxBatch) {
    return eligible;
  }

  const indexById = new Map<string, number>();
  for (let i = 0; i < world.entities.length; i++) {
    indexById.set(world.entities[i]!.id, i);
  }
  const n = Math.max(1, world.entities.length);

  return eligible
    .toSorted((a, b) => {
      const urgentA = a.needs.hunger > 0.72 ? 0 : 1;
      const urgentB = b.needs.hunger > 0.72 ? 0 : 1;
      if (urgentA !== urgentB) return urgentA - urgentB;

      const rotA = ((indexById.get(a.id) ?? 0) + world.tick) % n;
      const rotB = ((indexById.get(b.id) ?? 0) + world.tick) % n;
      return rotA - rotB;
    })
    .slice(0, maxBatch);
}

export class VillageSimulation {
  readonly config: SimConfig;
  readonly world: WorldState;
  private readonly provider: DecisionProvider;
  private readonly scriptedFallback = new ScriptedProvider();
  private readonly hooks: SimulationHooks;

  readonly records: JsonlRecord[] = [];
  readonly decisions: DecisionLogRecord[] = [];
  readonly tickHashes: TickHashRecord[] = [];
  readonly summaries: DaySummary[] = [];
  readonly events: SimEvent[] = [];

  private dayTelemetry: DayTelemetry = emptyTelemetry();
  private totalProviderCalls = 0;
  private totalDecisions = 0;
  private totalFallbacks = 0;
  private dawnCompletedForDay = 0;

  constructor(config: SimConfig, provider: DecisionProvider, hooks: SimulationHooks = {}) {
    this.config = config;
    this.provider = provider;
    this.hooks = hooks;
    this.world = createInitialWorld(config);

    const header: HeaderLogRecord = {
      recordType: "header",
      version: 1,
      seed: config.seed,
      provider: config.provider,
      model: config.model,
      sample: config.sample,
      minConf: config.minConf,
      maxBatch: config.maxBatch,
      days: config.days,
      ticksPerDay: config.ticksPerDay,
      minutesPerTick: config.minutesPerTick,
    };
    this.records.push(header);
  }

  get isFinished(): boolean {
    return this.world.day > this.config.days;
  }

  private emitEvent(event: SimEvent, tickEvents: SimEvent[]): void {
    tickEvents.push(event);
    this.events.push(event);
    this.hooks.onEvent?.(event);
  }

  private async runDawnPlan(tickEvents: SimEvent[]): Promise<DecisionLogRecord[]> {
    const world = this.world;
    const stateSummary = serializeWorldState(world);
    const questions: Record<string, Question> = {};
    for (const entity of world.entities) {
      questions[`dawn_${entity.id}`] = buildDawnQuestion(world, entity);
    }

    if (this.provider instanceof ReplayProvider) {
      this.provider.setCursor(world.day, -1);
    }

    const res = await this.provider.decide(stateSummary, questions, world.seed);
    this.dayTelemetry.providerCalls += 1;
    this.totalProviderCalls += 1;
    if (res.meta.latencyMs > 0) {
      this.dayTelemetry.latenciesMs.push(res.meta.latencyMs);
    }

    const scriptedBackup = await this.scriptedFallback.decide(stateSummary, questions, world.seed);
    const dawnRecords: DecisionLogRecord[] = [];
    const time = formatSimTime(0, world.minutesPerTick, world.startHour);

    for (const entity of world.entities) {
      const qId = `dawn_${entity.id}`;
      const question = questions[qId]!;
      const providerAns = res.answers[qId];
      const fallbackAns = scriptedBackup.answers[qId]!;

      let usedFallback = Boolean(res.meta.fallbackUsed) || !providerAns;
      let probs = providerAns?.probabilities ?? fallbackAns.probabilities;
      if (Object.keys(probs).length === 0) {
        usedFallback = true;
        probs = fallbackAns.probabilities;
      }

      const rng = createStreamRng(world.seed, world.day, -1, entity.id, "dawn");
      const sampled =
        this.config.sample === "argmax" ? pickArgmax(probs) : rng.sampleWeighted(probs);

      let chosenFocus = sampled.key as Focus;
      let escalated = false;

      if (!DAWN_FOCUS_CRITERIA[chosenFocus]) {
        usedFallback = true;
        chosenFocus = (fallbackAns.choice as Focus) ?? "duty";
      }

      // Confidence escalation on dawn plan if below threshold
      if (!usedFallback && sampled.prob < this.config.minConf) {
        escalated = true;
        const escSample =
          this.config.sample === "argmax"
            ? pickArgmax(fallbackAns.probabilities)
            : createStreamRng(world.seed, world.day, -1, entity.id, "dawn_esc").sampleWeighted(
                fallbackAns.probabilities,
              );
        chosenFocus = (escSample.key as Focus) || "duty";
      }

      // Track metrics
      this.totalDecisions += 1;
      this.dayTelemetry.providerDecisions += 1;
      if (usedFallback) {
        this.dayTelemetry.fallbackDecisions += 1;
        this.totalFallbacks += 1;
      }
      if (escalated) {
        this.dayTelemetry.escalatedDecisions += 1;
      }

      entity.focus = chosenFocus;

      const rec: DecisionLogRecord = {
        recordType: "decision",
        day: world.day,
        tick: -1,
        time,
        entity: entity.id,
        question_id: qId,
        action: chosenFocus,
        probabilities: { ...probs },
        confidence: sampled.prob,
        provider: usedFallback ? this.scriptedFallback.name : res.meta.provider,
        seed: world.seed,
        state_hash: "",
        escalated,
        fallback: usedFallback || undefined,
        latency_ms: res.meta.latencyMs,
        instructions: question.instructions,
        state_summary: stateSummary,
        criteria: { ...DAWN_FOCUS_CRITERIA },
      };
      dawnRecords.push(rec);
    }

    this.emitEvent(
      {
        day: world.day,
        tick: 0,
        time,
        kind: "dawn",
        message: `${time} Day ${world.day} dawns (${world.weather}) — villagers set their daily focus`,
      },
      tickEvents,
    );

    this.dawnCompletedForDay = world.day;
    return dawnRecords;
  }

  /**
   * Plan a validated deterministic EntityGoal from the sampled intent.
   * Deterministic code owns all routing, pricing, stock validation, and constraints.
   */
  private buildGoalForAction(entity: Entity, action: ActionKind): EntityGoal {
    const world = this.world;
    const rng = createStreamRng(world.seed, world.day, world.tick, entity.id, `plan_${action}`);

    const makeGoal = (
      kind: ActionKind,
      targetPlace: string,
      extra?: { targetEntity?: string; targetItem?: ItemKind },
    ): EntityGoal => {
      const route = findRoute(entity.location, targetPlace);
      if (route.hops.length === 0) {
        return {
          kind,
          targetPlace,
          targetEntity: extra?.targetEntity,
          targetItem: extra?.targetItem,
          ticksLeft: 0,
          route: [],
          phase: "execute",
        };
      }
      const firstHop = route.hops[0]!;
      return {
        kind,
        targetPlace,
        targetEntity: extra?.targetEntity,
        targetItem: extra?.targetItem,
        ticksLeft: getEdgeCost(entity.location, firstHop),
        route: route.hops,
        phase: "travel",
      };
    };

    switch (action) {
      case "work": {
        return makeGoal("work", entity.workplace);
      }

      case "restock": {
        const opt = findRestockOption(world, entity);
        if (!opt) {
          pushMemory(entity, "nothing to restock with");
          return makeGoal("wander", "well");
        }
        return makeGoal("restock", opt.targetPlace, {
          targetEntity: opt.sellerId,
          targetItem: opt.item,
        });
      }

      case "buy_food": {
        // Already carrying food? Eat right where we are!
        if (getStock(entity, "stew") > 0 || getStock(entity, "bread") > 0) {
          return makeGoal("buy_food", entity.location);
        }
        // Choose between stew (tavern) and bread (bakery)
        const stewSellers =
          entity.gold >= ITEM_PRICES.stew ? findSuppliersForItem(world, "stew", entity.id, 1) : [];
        const breadSellers =
          entity.gold >= ITEM_PRICES.bread
            ? findSuppliersForItem(world, "bread", entity.id, 1)
            : [];

        const preferStew =
          stewSellers.length > 0 &&
          (breadSellers.length === 0 ||
            world.weather === "rain" ||
            entity.needs.social < 0.55 ||
            world.tick >= 36 ||
            rng.next() < 0.45);

        if (preferStew && stewSellers[0]) {
          return makeGoal("buy_food", stewSellers[0].workplace, {
            targetEntity: stewSellers[0].id,
            targetItem: "stew",
          });
        }
        if (breadSellers[0]) {
          return makeGoal("buy_food", breadSellers[0].workplace, {
            targetEntity: breadSellers[0].id,
            targetItem: "bread",
          });
        }
        if (stewSellers[0]) {
          return makeGoal("buy_food", stewSellers[0].workplace, {
            targetEntity: stewSellers[0].id,
            targetItem: "stew",
          });
        }
        // Fallback: head to bakery (and trigger deadlock guard if starving)
        return makeGoal("buy_food", "bakery");
      }

      case "rest": {
        const restPlace = entity.needs.energy < 0.25 ? entity.home : entity.home;
        return makeGoal("rest", restPlace);
      }

      case "socialize": {
        const partner = findSocialPartner(world, entity);
        const socialSpot =
          world.weather === "rain"
            ? "tavern"
            : partner &&
                (partner.location === "tavern" ||
                  partner.location === "well" ||
                  partner.location === "market")
              ? partner.location
              : rng.next() < 0.5
                ? "tavern"
                : world.prosperity === "thriving"
                  ? "market"
                  : "well";
        return makeGoal("socialize", socialSpot, { targetEntity: partner?.id });
      }

      case "patrol": {
        const currentIdx = PATROL_ROUTE.indexOf(entity.location);
        const nextPlace = PATROL_ROUTE[(currentIdx + 1) % PATROL_ROUTE.length] ?? "market";
        return makeGoal("patrol", nextPlace);
      }

      case "wander": {
        const spots = ["well", "market", "garden", "bakery", "tavern", "fields"];
        const filtered = spots.filter((s) => s !== entity.location);
        const dest = filtered[rng.nextInt(filtered.length)] ?? "well";
        return makeGoal("wander", dest);
      }
    }
  }

  private executeGoalAction(entity: Entity, goal: EntityGoal, tickEvents: SimEvent[]): void {
    const world = this.world;
    const time = formatSimTime(world.tick, world.minutesPerTick, world.startHour);
    let actionSucceeded = true;

    switch (goal.kind) {
      case "work": {
        const res = executeRecipe(world, entity);
        actionSucceeded = res.ok;
        if (res.ok && res.event) {
          this.emitEvent(res.event, tickEvents);
          const recipe = RECIPES[entity.role];
          if (recipe && getStock(entity, recipe.output) >= ITEM_CAPS[recipe.output] - 1) {
            recordRumor(entity, {
              id: `surplus:${world.day}:${entity.id}:${recipe.output}`,
              kind: "surplus",
              subjectId: entity.id,
              summary: `${entity.name.toLowerCase()} has surplus ${recipe.output}`,
              day: world.day,
              tick: world.tick,
            });
          }
        } else {
          pushMemory(entity, `could not ${entity.duty} (${res.reason ?? "blocked"})`);
        }
        entity.goal = null;
        break;
      }

      case "restock": {
        if (goal.targetItem === "water") {
          const ev = drawWaterFromWell(world, entity);
          if (ev) this.emitEvent(ev, tickEvents);
          entity.goal = null;
          break;
        }
        actionSucceeded = false;
        if (goal.targetEntity && goal.targetItem) {
          const seller = getEntityById(world, goal.targetEntity);
          if (seller) {
            const prevAff = entity.affinity[seller.id] ?? 0.5;
            const trade = executeTrade(world, entity, seller, goal.targetItem, 1);
            if (trade.ok && trade.event) {
              actionSucceeded = true;
              this.emitEvent(trade.event, tickEvents);
              maybeRecordFriendshipRumor(world, entity, seller, prevAff);
              const gossipEv = propagateGossip(world, seller, entity);
              if (gossipEv) this.emitEvent(gossipEv, tickEvents);
            } else {
              pushMemory(entity, `failed to restock ${goal.targetItem}`);
              recordRumor(entity, {
                id: `shortage:${world.day}:${entity.id}:${goal.targetItem}`,
                kind: "shortage",
                subjectId: entity.id,
                summary: `${entity.name.toLowerCase()} is short on ${goal.targetItem}`,
                day: world.day,
                tick: world.tick,
              });
            }
          }
        }
        entity.goal = null;
        break;
      }

      case "buy_food": {
        // First eat if carrying food
        const carriedMeal = consumeCarriedMeal(world, entity);
        if (carriedMeal) {
          this.emitEvent(carriedMeal, tickEvents);
          world.deadlockCounter[entity.id] = 0;
          entity.goal = null;
          break;
        }

        // Otherwise buy from target seller (or any food seller at current place)
        let bought = false;
        if (goal.targetEntity && goal.targetItem) {
          const seller = getEntityById(world, goal.targetEntity);
          if (seller && entity.location === seller.workplace) {
            const trade = executeTrade(world, entity, seller, goal.targetItem, 1);
            if (trade.ok && trade.event) {
              this.emitEvent(trade.event, tickEvents);
              bought = true;
            }
          }
        }

        // If target seller was out of stock, try the other food item if present at this place
        if (!bought) {
          const localSellers = world.entities.filter(
            (e) =>
              e.id !== entity.id &&
              e.workplace === entity.location &&
              (e.role === "baker" || e.role === "innkeeper"),
          );
          for (const seller of localSellers) {
            const item: ItemKind = seller.role === "innkeeper" ? "stew" : "bread";
            const trade = executeTrade(world, entity, seller, item, 1);
            if (trade.ok && trade.event) {
              this.emitEvent(trade.event, tickEvents);
              bought = true;
              break;
            }
          }
        }

        if (bought) {
          const meal = consumeCarriedMeal(world, entity);
          if (meal) this.emitEvent(meal, tickEvents);
          world.deadlockCounter[entity.id] = 0;
        } else {
          actionSucceeded = false;
          pushMemory(entity, "found no food to buy");
          recordRumor(entity, {
            id: `shortage:${world.day}:food:${entity.location}`,
            kind: "shortage",
            subjectId: entity.id,
            summary: `${entity.location} ran low on food`,
            day: world.day,
            tick: world.tick,
          });
          const relief = applyDeadlockRelief(world, entity);
          if (relief) this.emitEvent(relief, tickEvents);
        }

        entity.goal = null;
        break;
      }

      case "rest": {
        entity.needs.energy = clamp01(entity.needs.energy + 0.34);
        pushMemory(entity, `rested at ${entity.location}`);
        this.emitEvent(
          {
            day: world.day,
            tick: world.tick,
            time,
            kind: "rest",
            entityId: entity.id,
            place: entity.location,
            message: `${time} ${entity.name.toLowerCase()} rests at ${entity.location}`,
          },
          tickEvents,
        );
        entity.goal = null;
        break;
      }

      case "socialize": {
        const otherHere = world.entities.find(
          (e) => e.id !== entity.id && e.location === entity.location,
        );
        const partner =
          otherHere ?? (goal.targetEntity ? getEntityById(world, goal.targetEntity) : undefined);

        entity.needs.social = clamp01(entity.needs.social + 0.32);
        if (partner) {
          const prevAff = entity.affinity[partner.id] ?? 0.5;
          partner.needs.social = clamp01(partner.needs.social + 0.14);
          entity.affinity[partner.id] = clamp01(prevAff + 0.06);
          partner.affinity[entity.id] = clamp01((partner.affinity[entity.id] ?? 0.5) + 0.06);
          maybeRecordFriendshipRumor(world, entity, partner, prevAff);
          pushMemory(entity, `chatted with ${partner.name.toLowerCase()} at ${entity.location}`);
          this.emitEvent(
            {
              day: world.day,
              tick: world.tick,
              time,
              kind: "socialize",
              entityId: entity.id,
              otherEntityId: partner.id,
              place: entity.location,
              message: `${time} ${entity.name.toLowerCase()} chats with ${partner.name.toLowerCase()} at ${entity.location}`,
            },
            tickEvents,
          );

          // Exchange gossip bidirectionally (at most 1 rumor each)
          const gossipA = propagateGossip(world, entity, partner);
          if (gossipA) this.emitEvent(gossipA, tickEvents);
          const gossipB = propagateGossip(world, partner, entity);
          if (gossipB) this.emitEvent(gossipB, tickEvents);

          // Cozy surplus purchase or friend gifting when village is steady/thriving
          const exchange =
            tryCozySurplusExchange(world, entity, partner) ??
            tryCozySurplusExchange(world, partner, entity);
          if (exchange) this.emitEvent(exchange, tickEvents);
        } else {
          pushMemory(entity, `relaxed at ${entity.location}`);
          this.emitEvent(
            {
              day: world.day,
              tick: world.tick,
              time,
              kind: "socialize",
              entityId: entity.id,
              place: entity.location,
              message: `${time} ${entity.name.toLowerCase()} lingers at ${entity.location}`,
            },
            tickEvents,
          );
        }
        entity.goal = null;
        break;
      }

      case "patrol": {
        entity.needs.social = clamp01(entity.needs.social + 0.06);
        pushMemory(entity, `patrolled ${entity.location}`);
        this.emitEvent(
          {
            day: world.day,
            tick: world.tick,
            time,
            kind: "patrol",
            entityId: entity.id,
            place: entity.location,
            message: `${time} ${entity.name.toLowerCase()} patrols ${entity.location}`,
          },
          tickEvents,
        );
        entity.goal = null;
        break;
      }

      case "wander": {
        entity.needs.social = clamp01(entity.needs.social + 0.08);
        pushMemory(entity, `wandered to ${entity.location}`);
        this.emitEvent(
          {
            day: world.day,
            tick: world.tick,
            time,
            kind: "wander",
            entityId: entity.id,
            place: entity.location,
            message: `${time} ${entity.name.toLowerCase()} wanders by ${entity.location}`,
          },
          tickEvents,
        );
        entity.goal = null;
        break;
      }
    }

    entity.decisionCooldown = getPostActionCooldown(entity, goal.kind, actionSucceeded);
  }

  private advanceActiveGoal(entity: Entity, tickEvents: SimEvent[]): void {
    const goal = entity.goal;
    if (!goal) return;

    if (goal.phase === "travel") {
      goal.ticksLeft -= 1;
      if (goal.ticksLeft <= 0) {
        const nextStop = goal.route.shift();
        if (nextStop) {
          entity.prevLocation = entity.location;
          entity.location = nextStop;
          const time = formatSimTime(
            this.world.tick,
            this.world.minutesPerTick,
            this.world.startHour,
          );
          this.emitEvent(
            {
              day: this.world.day,
              tick: this.world.tick,
              time,
              kind: "move",
              entityId: entity.id,
              place: nextStop,
              message: `${time} ${entity.name.toLowerCase()} arrives at ${nextStop}`,
            },
            tickEvents,
          );
        }

        if (goal.route.length > 0) {
          goal.ticksLeft = getEdgeCost(entity.location, goal.route[0]!);
        } else {
          goal.phase = "execute";
          // Execute immediately upon arrival so travel feels crisp and responsive
          this.executeGoalAction(entity, goal, tickEvents);
        }
      }
      return;
    }

    this.executeGoalAction(entity, goal, tickEvents);
  }

  async stepTick(): Promise<TickSnapshot> {
    if (this.isFinished) {
      throw new Error("Simulation has already completed all configured days");
    }

    const world = this.world;
    const tickEvents: SimEvent[] = [];
    const tickDecisions: DecisionLogRecord[] = [];
    const time = formatSimTime(world.tick, world.minutesPerTick, world.startHour);

    // Track previous locations for smooth 3D road interpolation
    for (const entity of world.entities) {
      entity.prevLocation = entity.location;
    }

    // 1. Dawn plan once at the beginning of each day
    if (world.tick === 0 && this.dawnCompletedForDay < world.day) {
      const dawnRecs = await this.runDawnPlan(tickEvents);
      tickDecisions.push(...dawnRecs);
    }

    // 2. Scheduled economy events (noon and 18:00)
    const scheduled = runScheduledEconomyEvents(world);
    for (const ev of scheduled) {
      this.emitEvent(ev, tickEvents);
    }

    // 3. Need decay & LoD cooldown advancement
    for (const entity of world.entities) {
      decayNeeds(entity);
      if (entity.decisionCooldown > 0) {
        entity.decisionCooldown -= 1;
      }
      // Urgent hunger bypasses LoD cooldown and interrupts non-eating goals
      if (entity.needs.hunger > 0.72) {
        entity.decisionCooldown = 0;
      }
      if (entity.needs.hunger > 0.8 && entity.goal && entity.goal.kind !== "buy_food") {
        entity.goal = null;
      }
    }

    // 4. Micro-steering for entities with active goals
    for (const entity of world.entities) {
      if (entity.goal) {
        this.advanceActiveGoal(entity, tickEvents);
      }
    }

    // 5. Batched tick decisions for eligible idle entities (bounded by LoD cadence + maxBatch)
    const idleEntities = selectEntitiesForTickDecision(world, this.config.maxBatch);
    if (idleEntities.length > 0) {
      const stateSummary = serializeWorldState(world);
      const questions: Record<string, Question> = {};
      const criteriaByEntity = new Map<string, Record<string, string>>();

      for (const entity of idleEntities) {
        const criteria = getGatedActions(world, entity);
        criteriaByEntity.set(entity.id, criteria);
        questions[`act_${entity.id}`] = buildTickQuestion(world, entity, criteria);
      }

      if (this.provider instanceof ReplayProvider) {
        this.provider.setCursor(world.day, world.tick);
      }

      const res = await this.provider.decide(stateSummary, questions, world.seed);
      this.dayTelemetry.providerCalls += 1;
      this.totalProviderCalls += 1;
      if (res.meta.latencyMs > 0) {
        this.dayTelemetry.latenciesMs.push(res.meta.latencyMs);
      }

      const scriptedBackup = await this.scriptedFallback.decide(
        stateSummary,
        questions,
        world.seed,
      );

      for (const entity of idleEntities) {
        const qId = `act_${entity.id}`;
        const question = questions[qId]!;
        const criteria = criteriaByEntity.get(entity.id)!;
        const allowedKeys = Object.keys(criteria);

        const providerAns = res.answers[qId];
        const fallbackAns = scriptedBackup.answers[qId]!;

        // Deterministic validation: keep only probabilities for gated criteria keys
        let usedFallback = Boolean(res.meta.fallbackUsed) || !providerAns;
        const filteredProbs: Record<string, number> = {};
        if (!usedFallback && providerAns) {
          let sum = 0;
          for (const k of allowedKeys) {
            const p = providerAns.probabilities[k];
            if (typeof p === "number" && Number.isFinite(p) && p > 0) {
              filteredProbs[k] = p;
              sum += p;
            }
          }
          if (sum <= 0) {
            usedFallback = true;
          } else {
            for (const k of Object.keys(filteredProbs)) {
              filteredProbs[k] = filteredProbs[k]! / sum;
            }
          }
        }

        const activeProbs = usedFallback ? fallbackAns.probabilities : filteredProbs;
        const rng = createStreamRng(world.seed, world.day, world.tick, entity.id, "act");
        const sampled =
          this.config.sample === "argmax"
            ? pickArgmax(activeProbs)
            : rng.sampleWeighted(activeProbs);

        let chosenAction = sampled.key as ActionKind;
        let escalated = false;

        // Confidence escalation (§7.3)
        if (!usedFallback && sampled.prob < this.config.minConf) {
          escalated = true;
          const escRng = createStreamRng(world.seed, world.day, world.tick, entity.id, "act_esc");
          const escSample =
            this.config.sample === "argmax"
              ? pickArgmax(fallbackAns.probabilities)
              : escRng.sampleWeighted(fallbackAns.probabilities);
          chosenAction = (escSample.key as ActionKind) || (allowedKeys[0] as ActionKind);
        }

        if (!criteria[chosenAction]) {
          usedFallback = true;
          chosenAction = (allowedKeys[0] as ActionKind) ?? "wander";
        }

        // Update metrics
        this.totalDecisions += 1;
        this.dayTelemetry.providerDecisions += 1;
        if (usedFallback) {
          this.dayTelemetry.fallbackDecisions += 1;
          this.totalFallbacks += 1;
        }
        if (escalated) {
          this.dayTelemetry.escalatedDecisions += 1;
        }

        // Build deterministic goal and execute immediately if already at destination
        const goal = this.buildGoalForAction(entity, chosenAction);
        entity.goal = goal;
        if (goal.phase === "execute") {
          this.executeGoalAction(entity, goal, tickEvents);
        } else {
          // Begin moving along first road segment
          this.advanceActiveGoal(entity, tickEvents);
        }

        const providerLabel = usedFallback ? this.scriptedFallback.name : res.meta.provider;
        entity.lastDecision = {
          day: world.day,
          tick: world.tick,
          questionId: qId,
          action: chosenAction,
          probabilities: { ...activeProbs },
          confidence: sampled.prob,
          provider: providerLabel,
          escalated,
          instructions: question.instructions,
          worldStateSummary: stateSummary,
          criteria: { ...criteria },
        };

        const decisionRec: DecisionLogRecord = {
          recordType: "decision",
          day: world.day,
          tick: world.tick,
          time,
          entity: entity.id,
          question_id: qId,
          action: chosenAction,
          probabilities: { ...activeProbs },
          confidence: sampled.prob,
          provider: providerLabel,
          seed: world.seed,
          state_hash: "",
          escalated,
          fallback: usedFallback || undefined,
          latency_ms: res.meta.latencyMs,
          instructions: question.instructions,
          state_summary: stateSummary,
          criteria: { ...criteria },
        };
        tickDecisions.push(decisionRec);
      }
    }

    // 6. Update deterministic village prosperity & assert invariants every tick (§8)
    updateWorldProsperity(world);
    assertWorldInvariants(world);

    // 7. Compute canonical state hash and finalize decision logs
    const stateHash = hashWorldState(world);
    for (const rec of tickDecisions) {
      rec.state_hash = stateHash;
      this.records.push(rec);
      this.decisions.push(rec);
    }

    const tickHashRec: TickHashRecord = {
      recordType: "tick",
      day: world.day,
      tick: world.tick,
      time,
      state_hash: stateHash,
    };
    this.records.push(tickHashRec);
    this.tickHashes.push(tickHashRec);

    const currentDay = world.day;
    const currentTick = world.tick;
    const currentWeather = world.weather;

    let daySummary: DaySummary | undefined;
    const isLastTickOfDay = world.tick + 1 >= world.ticksPerDay;

    if (isLastTickOfDay) {
      const minMeals = Math.min(...world.entities.map((e) => e.mealsToday));
      const fallbackRate =
        this.dayTelemetry.providerDecisions > 0
          ? this.dayTelemetry.fallbackDecisions / this.dayTelemetry.providerDecisions
          : 0;

      daySummary = {
        day: world.day,
        weather: world.weather,
        trades: world.tradesToday,
        breadProduced: world.breadProducedToday,
        stewProduced: world.stewProducedToday,
        mealsTotal: world.mealsToday,
        minMealsPerEntity: minMeals,
        providerCalls: this.dayTelemetry.providerCalls,
        providerDecisions: this.dayTelemetry.providerDecisions,
        fallbackDecisions: this.dayTelemetry.fallbackDecisions,
        escalatedDecisions: this.dayTelemetry.escalatedDecisions,
        latenciesMs: [...this.dayTelemetry.latenciesMs],
        p50LatencyMs: percentile(this.dayTelemetry.latenciesMs, 50),
        p95LatencyMs: percentile(this.dayTelemetry.latenciesMs, 95),
        fallbackRate,
        finalStateHash: stateHash,
        entities: world.entities.map((e) => ({
          id: e.id,
          name: e.name,
          role: e.role,
          gold: e.gold,
          meals: e.mealsToday,
          stock: { ...e.inventory },
        })),
      };
      this.summaries.push(daySummary);
      this.hooks.onDayEnd?.(daySummary);
      this.dayTelemetry = emptyTelemetry();
    }

    const snapshot: TickSnapshot = {
      day: currentDay,
      tick: currentTick,
      time,
      weather: currentWeather,
      prosperity: world.prosperity,
      prosperityScore: world.prosperityScore,
      stateHash,
      entities: cloneEntitiesForSnapshot(world.entities),
      events: tickEvents,
      decisions: tickDecisions,
      daySummary,
      stats: {
        tradesToday: world.tradesToday,
        tradesTotal: world.tradesTotal,
        breadProducedToday: world.breadProducedToday,
        stewProducedToday: world.stewProducedToday,
        mealsToday: world.mealsToday,
        totalGold: world.entities.reduce((sum, e) => sum + e.gold, 0),
        providerCalls: this.totalProviderCalls,
        fallbackRate: this.totalDecisions > 0 ? this.totalFallbacks / this.totalDecisions : 0,
      },
    };

    // Advance sim clock
    if (isLastTickOfDay) {
      if (world.day < this.config.days) {
        resetEntitiesForNewDay(world, world.day + 1);
        decayRumorsForNewDay(world);
        updateWorldProsperity(world);
      } else {
        world.day += 1;
        world.tick = 0;
      }
    } else {
      world.tick += 1;
    }

    this.hooks.onTick?.(snapshot);
    return snapshot;
  }

  async stepDay(): Promise<DaySummary> {
    if (this.isFinished) {
      throw new Error("Simulation has already completed all configured days");
    }
    const targetDay = this.world.day;
    let lastSummary: DaySummary | undefined;
    while (!this.isFinished && this.world.day === targetDay) {
      const snap = await this.stepTick();
      if (snap.daySummary) {
        lastSummary = snap.daySummary;
      }
    }
    if (!lastSummary) {
      throw new Error(`Day ${targetDay} did not emit a summary`);
    }
    return lastSummary;
  }

  async runAllDays(): Promise<SimulationRunResult> {
    while (!this.isFinished) {
      await this.stepDay();
    }
    const finalStateHash =
      this.tickHashes[this.tickHashes.length - 1]?.state_hash ?? hashWorldState(this.world);

    return {
      world: this.world,
      summaries: this.summaries,
      records: this.records,
      decisions: this.decisions,
      tickHashes: this.tickHashes,
      events: this.events,
      finalStateHash,
    };
  }
}

export function getRecipeInfo(role: Entity["role"]) {
  return RECIPES[role];
}
