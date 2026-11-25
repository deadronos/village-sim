import {
  SCRIPTED_INSTRUCTIONS,
  type Answer,
  type DecisionProvider,
  type ProviderResult,
  type Question,
} from "../types.ts";

function parseFloatMetric(text: string, label: string, fallback: number): number {
  const regex = new RegExp(`${label}\\s+([0-9]+(?:\\.[0-9]+)?)`, "i");
  const match = regex.exec(text);
  if (!match?.[1]) return fallback;
  const val = Number(match[1]);
  return Number.isFinite(val) ? val : fallback;
}

function parseIntMetric(text: string, label: string, fallback: number): number {
  const regex = new RegExp(`${label}\\s+([0-9]+)`, "i");
  const match = regex.exec(text);
  if (!match?.[1]) return fallback;
  const val = Number.parseInt(match[1], 10);
  return Number.isFinite(val) ? val : fallback;
}

function normalizeWeights(weights: Record<string, number>): Record<string, number> {
  const keys = Object.keys(weights).toSorted();
  if (keys.length === 0) return {};
  let sum = 0;
  for (const k of keys) {
    const w = Math.max(0.01, weights[k] ?? 0.01);
    weights[k] = w;
    sum += w;
  }
  const probs: Record<string, number> = {};
  for (const k of keys) {
    probs[k] = Math.round(((weights[k] ?? 0.01) / sum) * 10000) / 10000;
  }
  // Fix rounding drift on largest key so probabilities sum cleanly to 1.0
  const probSum = Object.values(probs).reduce((acc, v) => acc + v, 0);
  let maxKey = keys[0]!;
  for (const k of keys) {
    if ((probs[k] ?? 0) > (probs[maxKey] ?? 0)) maxKey = k;
  }
  probs[maxKey] = Math.max(0, Math.round(((probs[maxKey] ?? 0) + (1 - probSum)) * 10000) / 10000);
  return probs;
}

function scoreDawnFocus(
  instructions: string,
  stateSummary: string,
  criteriaKeys: string[],
): Record<string, number> {
  const gold = parseIntMetric(instructions, "Gold", 15);
  const energy = parseFloatMetric(instructions, "Energy", 0.85);
  const social = parseFloatMetric(instructions, "social", 0.6);
  const isChild = /\bthe child\b/i.test(instructions);
  const isGuard = /\bthe guard\b/i.test(instructions);
  const isRain = /\brain\b/i.test(stateSummary) || /\brain\b/i.test(instructions);
  const isThriving =
    /\bprosperity\s+thriving\b/i.test(stateSummary) ||
    /\bprosperity\s+thriving\b/i.test(instructions);
  const isLean =
    /\bprosperity\s+lean\b/i.test(stateSummary) || /\bprosperity\s+lean\b/i.test(instructions);

  const raw: Record<string, number> = {};
  for (const key of criteriaKeys) {
    switch (key) {
      case "duty":
        raw[key] = (isChild ? 0.25 : isGuard ? 0.55 : 0.42) * (isLean ? 1.25 : 1);
        break;
      case "earn":
        raw[key] =
          (isChild ? 0.1 : gold < 14 ? 0.5 : 0.28) * (isLean ? 1.3 : isThriving ? 0.85 : 1);
        break;
      case "socialize":
        raw[key] =
          (social < 0.6 ? 0.35 : isChild ? 0.45 : 0.22) *
          (isThriving ? 1.35 : isRain ? 1.15 : isLean ? 0.78 : 1);
        break;
      case "rest":
        raw[key] = (energy < 0.7 ? 0.35 : 0.12) * (isRain ? 1.28 : 1);
        break;
      default:
        raw[key] = 0.2;
    }
  }
  return normalizeWeights(raw);
}

function scoreTickAction(
  instructions: string,
  stateSummary: string,
  criteriaKeys: string[],
): Record<string, number> {
  const hunger = parseFloatMetric(instructions, "Hunger", 0.3);
  const energy = parseFloatMetric(instructions, "energy", 0.8);
  const social = parseFloatMetric(instructions, "social", 0.6);
  const mealsMatch = /(?:Meals today:|meals)\s+([0-9]+)/i.exec(instructions);
  const mealsToday = mealsMatch?.[1] ? Number.parseInt(mealsMatch[1], 10) : 0;
  const focusMatch = /(?:Today's\s+)?focus:\s*([a-z]+)/i.exec(instructions);
  const focus = focusMatch?.[1]?.toLowerCase() ?? "duty";
  const carryingBread = /\b[1-9]\d*\s+bread\b/i.test(instructions);
  const carryingStew = /\b[1-9]\d*\s+stew\b/i.test(instructions);
  const carryingFood = carryingBread || carryingStew;
  const isBaker = /\bthe baker\b/i.test(instructions);
  const isFarmer = /\bthe farmer\b/i.test(instructions);
  const isInnkeeper = /\bthe innkeeper\b/i.test(instructions);
  const isRain =
    /\bweather\s+rain\b/i.test(stateSummary) || /\bweather\s+rain\b/i.test(instructions);
  const isThriving = /\bprosperity\s+thriving\b/i.test(stateSummary);
  const heardShortage = /\bHeard:.*\b(?:short|low)\b/i.test(instructions);

  // Check village bread stock from shared world state so baker responds to scarcity
  const breadMatch = /bread\s+(\d+)/i.exec(stateSummary);
  const villageBread = breadMatch?.[1] ? Number.parseInt(breadMatch[1], 10) : 3;

  const raw: Record<string, number> = {};
  for (const key of criteriaKeys) {
    let score = 0.25;

    switch (key) {
      case "buy_food": {
        if (hunger > 0.75) {
          score = 4.0;
        } else if (hunger > 0.58) {
          score = 1.9 + (mealsToday < 2 ? 0.6 : 0);
        } else if (hunger > 0.42) {
          score = 0.85 + (carryingFood ? 0.35 : 0) + (mealsToday < 2 ? 0.35 : 0);
        } else {
          // Carrying food but not hungry yet — low probability so they don't waste meals
          score = 0.08;
        }
        break;
      }

      case "restock": {
        // Supply-chain producers need inputs urgently to keep the village fed
        score = isBaker || isInnkeeper ? 2.4 : 1.5;
        if (focus === "duty" || focus === "earn") score *= 1.3;
        break;
      }

      case "work": {
        score = 1.25;
        if (focus === "duty") score *= 1.45;
        if (focus === "earn") score *= 1.6;
        if (focus === "rest") score *= 0.65;
        if (focus === "socialize") score *= 0.75;
        if (isBaker && villageBread < 4) score *= 1.9;
        if (isFarmer) score *= 1.15;
        if (heardShortage && (isFarmer || isBaker || isInnkeeper)) score *= 1.25;
        break;
      }

      case "rest": {
        score = energy < 0.22 ? 2.2 : 0.75;
        if (focus === "rest") score *= 1.7;
        if (isRain) score *= 1.15;
        break;
      }

      case "socialize": {
        score = social < 0.35 ? 1.15 : 0.48;
        if (focus === "socialize") score *= 1.85;
        if (isThriving) score *= 1.18;
        if (isRain) score *= 1.15;
        break;
      }

      case "patrol": {
        score = 1.1;
        if (focus === "duty") score *= 1.4;
        break;
      }

      case "wander": {
        score = isRain ? 0.28 : 0.45;
        if (focus === "socialize" || focus === "rest") score *= 1.3;
        break;
      }

      default:
        score = 0.2;
    }

    raw[key] = score;
  }

  return normalizeWeights(raw);
}

/**
 * Deterministic, zero-dependency utility-based provider.
 * Serves as offline default, test baseline, and escalation/outage fallback.
 */
export class ScriptedProvider implements DecisionProvider {
  readonly name = "scripted";

  async decide(
    state: string | Record<string, unknown>,
    questions: Record<string, Question>,
    _seed: number,
  ): Promise<ProviderResult> {
    const stateSummary = typeof state === "string" ? state : JSON.stringify(state);
    const answers: Record<string, Answer> = {};

    for (const [qId, question] of Object.entries(questions)) {
      if (question.type === "choice") {
        const keys = Object.keys(question.criteria).toSorted();
        const isDawn = qId.startsWith("dawn_");
        const instructions = question[SCRIPTED_INSTRUCTIONS] ?? question.instructions;
        const probabilities = isDawn
          ? scoreDawnFocus(instructions, stateSummary, keys)
          : scoreTickAction(instructions, stateSummary, keys);

        let bestChoice = keys[0] ?? "";
        let bestProb = -1;
        for (const k of keys) {
          const p = probabilities[k] ?? 0;
          if (p > bestProb) {
            bestProb = p;
            bestChoice = k;
          }
        }

        answers[qId] = {
          type: "choice",
          choice: bestChoice,
          probabilities,
          confidence: Math.max(0, bestProb),
        };
      } else if (question.type === "noul") {
        answers[qId] = {
          type: "noul",
          noul: 0.5,
          probabilities: { true: 0.5, false: 0.5 },
          confidence: 0.5,
        };
      } else {
        const len = Math.max(1, question.criteria.length);
        const probs: Record<string, number> = {};
        for (const label of question.criteria) {
          probs[label] = Math.round((1 / len) * 10000) / 10000;
        }
        answers[qId] = {
          type: "score",
          score: (len - 1) / 2,
          probabilities: probs,
          confidence: 1 / len,
        };
      }
    }

    return {
      answers,
      meta: {
        latencyMs: 0,
        provider: this.name,
        batched: Object.keys(questions).length > 1,
      },
    };
  }
}
