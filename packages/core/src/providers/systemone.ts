import { pickArgmax } from "../rng.ts";
import type {
  Answer,
  BatchMode,
  DecisionProvider,
  ProviderResult,
  Question,
  StartupHealthProbe,
} from "../types.ts";
import { ScriptedProvider } from "./scripted.ts";

export interface SystemOneOptions {
  endpoint: string;
  model: string;
  timeoutMs: number;
  batch: BatchMode;
  apiKey?: string;
  retryBaseMs?: number;
  onWarning?: (message: string) => void;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const CONSECUTIVE_FAILURE_LIMIT = 3;
const FALLBACK_COOLDOWN_MS = 5_000;
const DEFAULT_HEALTH_TIMEOUT_MS = 3_000;
const DEGRADATION_WINDOW = 10;
const COMPLETENESS_THRESHOLD = 0.9;

interface WireResponse {
  answers?: Record<string, unknown>;
  latency_ms?: number;
}

function toWireQuestion(question: Question): Question {
  if (question.type === "choice") {
    return {
      type: "choice",
      instructions: question.instructions,
      criteria: question.criteria,
    };
  }
  return question;
}

function toWireQuestions(questions: Record<string, Question>): Record<string, Question> {
  const out: Record<string, Question> = {};
  for (const [id, q] of Object.entries(questions)) {
    out[id] = toWireQuestion(q);
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeAnswer(raw: unknown, question: Question): Answer | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;

  if (question.type === "choice") {
    const rawProbs = obj.probabilities;
    if (!rawProbs || typeof rawProbs !== "object" || Array.isArray(rawProbs)) {
      return null;
    }
    const allowedKeys = new Set(Object.keys(question.criteria));
    const probs: Record<string, number> = {};
    let total = 0;

    for (const [k, v] of Object.entries(rawProbs as Record<string, unknown>)) {
      if (!allowedKeys.has(k)) continue;
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) continue;
      probs[k] = v;
      total += v;
    }

    if (total <= 0 || !Number.isFinite(total)) return null;

    for (const [k, v] of Object.entries(probs)) {
      probs[k] = v / total;
    }
    const { key: choice } = pickArgmax(probs);

    return {
      type: "choice",
      choice,
      probabilities: probs,
      confidence: probs[choice]!,
    };
  }

  return null;
}

function missingAnswerMetadata(
  questions: Record<string, Question>,
  answers: Record<string, Answer>,
) {
  const fallbackQuestionIds = Object.keys(questions).filter((id) => !Object.hasOwn(answers, id));
  return { fallbackUsed: fallbackQuestionIds.length > 0, fallbackQuestionIds };
}

/**
 * External System One typed-decision provider (`POST {endpoint}`).
 * Supports batching (`auto | always | never`), bounded per-entity retry on batch
 * failure, malformed answer rejection, and temporary fallback to ScriptedProvider
 * during an outage (§5.3, §5.4, §17).
 */
export class SystemOneProvider implements DecisionProvider {
  readonly name = "systemone";
  private readonly endpoint: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly batch: BatchMode;
  private readonly apiKey?: string;
  private readonly retryBaseMs: number;
  private readonly onWarning?: (message: string) => void;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly fallback = new ScriptedProvider();
  private scriptedFallbackActive = false;
  private consecutiveFailures = 0;
  private fallbackRetryAt?: number;
  private probeInFlight = false;
  private readonly sweepWindow: Array<{ asked: number; missing: number }> = [];
  private consecutiveDegradedSweeps = 0;
  private degradedWarningEmitted = false;

  constructor(options: SystemOneOptions) {
    this.endpoint = options.endpoint;
    this.model = options.model;
    this.timeoutMs = options.timeoutMs;
    this.batch = options.batch;
    this.apiKey = options.apiKey;
    this.retryBaseMs = options.retryBaseMs ?? 40;
    this.onWarning = options.onWarning;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => performance.now());
  }

  get isFallbackActive(): boolean {
    return this.scriptedFallbackActive;
  }

  get partialFallbackRate(): number {
    let totalAsked = 0;
    let totalMissing = 0;
    for (const sweep of this.sweepWindow) {
      totalAsked += sweep.asked;
      totalMissing += sweep.missing;
    }
    return totalAsked > 0 ? totalMissing / totalAsked : 0;
  }

  get isDegraded(): boolean {
    if (this.scriptedFallbackActive) return false;
    let totalAsked = 0;
    let totalMissing = 0;
    for (const sweep of this.sweepWindow) {
      totalAsked += sweep.asked;
      totalMissing += sweep.missing;
    }
    return totalAsked > 0 && (totalAsked - totalMissing) / totalAsked < COMPLETENESS_THRESHOLD;
  }

  /**
   * Immediately enters scripted fallback mode with the standard retry cooldown,
   * e.g. when a startup health probe fails under `--allow-degraded`.
   */
  activateFallback(): void {
    this.scriptedFallbackActive = true;
    this.consecutiveFailures = CONSECUTIVE_FAILURE_LIMIT;
    this.fallbackRetryAt = this.now() + FALLBACK_COOLDOWN_MS;
  }

  /**
   * Health check via `GET /v1/models` (a bare `GET /` returns 404 on System One servers).
   */
  async checkHealth(timeoutMs = DEFAULT_HEALTH_TIMEOUT_MS): Promise<StartupHealthProbe> {
    try {
      const url = new URL(this.endpoint);
      url.pathname = "/v1/models";
      const headers: Record<string, string> = {};
      if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
      const res = await this.fetchImpl(url.toString(), {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(Math.min(this.timeoutMs, timeoutMs)),
      });
      return { ok: res.ok, status: res.status };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async postSystemOne(
    state: string | Record<string, unknown>,
    questions: Record<string, Question>,
  ): Promise<{ rawAnswers: Record<string, unknown>; latencyMs: number }> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    const start = performance.now();
    const res = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: this.model,
        state,
        questions: toWireQuestions(questions),
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    const elapsed = Math.round(performance.now() - start);
    if (!res.ok) {
      throw new Error(`System One HTTP ${res.status}`);
    }

    const data = (await res.json()) as WireResponse;
    if (!data || typeof data !== "object" || !data.answers || typeof data.answers !== "object") {
      throw new Error("System One response missing answers object");
    }

    const latencyMs =
      typeof data.latency_ms === "number" && Number.isFinite(data.latency_ms)
        ? data.latency_ms
        : elapsed;

    return { rawAnswers: data.answers, latencyMs };
  }

  async decide(
    state: string | Record<string, unknown>,
    questions: Record<string, Question>,
    seed: number,
  ): Promise<ProviderResult> {
    const keys = Object.keys(questions);
    if (keys.length === 0) {
      return {
        answers: {},
        meta: { latencyMs: 0, provider: this.name, batched: false },
      };
    }

    const retryAt = this.fallbackRetryAt;
    if (retryAt !== undefined) {
      if (this.probeInFlight || this.now() < retryAt) {
        return this.scriptedFallback(state, questions, seed, 0, keys.length > 1);
      }
      this.probeInFlight = true;
    }

    const shouldBatch = this.batch === "always" || (this.batch === "auto" && keys.length >= 2);
    try {
      const result = await this.requestAnswers(state, questions, shouldBatch);
      const answeredCount = Object.keys(result.answers).length;
      if (answeredCount > 0) {
        this.scriptedFallbackActive = false;
        this.consecutiveFailures = 0;
        this.fallbackRetryAt = undefined;
        this.recordSweepOutcome(keys.length, keys.length - answeredCount);
        return result;
      }

      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= CONSECUTIVE_FAILURE_LIMIT) {
        const wasCoolingDown = this.fallbackRetryAt !== undefined;
        this.fallbackRetryAt = this.now() + FALLBACK_COOLDOWN_MS;
        if (!wasCoolingDown) {
          this.onWarning?.(
            `System One returned no usable answers in ${CONSECUTIVE_FAILURE_LIMIT} consecutive decision sweeps. Using scripted fallback and retrying in ${FALLBACK_COOLDOWN_MS / 1000} seconds.`,
          );
        }
      }
      return this.scriptedFallback(
        state,
        questions,
        seed,
        result.meta.latencyMs,
        result.meta.batched,
      );
    } finally {
      if (retryAt !== undefined) this.probeInFlight = false;
    }
  }

  private async requestAnswers(
    state: string | Record<string, unknown>,
    questions: Record<string, Question>,
    shouldBatch: boolean,
  ): Promise<ProviderResult> {
    if (!shouldBatch) return this.decidePerEntity(state, questions, false);

    try {
      const { rawAnswers, latencyMs } = await this.postSystemOne(state, questions);
      const answers: Record<string, Answer> = {};
      for (const [qId, q] of Object.entries(questions)) {
        const sanitized = sanitizeAnswer(rawAnswers[qId], q);
        if (sanitized) answers[qId] = sanitized;
      }
      return {
        answers,
        meta: {
          latencyMs,
          provider: this.name,
          batched: true,
          ...missingAnswerMetadata(questions, answers),
        },
      };
    } catch {
      // Batched call failed: retry once per entity with bounded exponential backoff (§5.4).
      return this.decidePerEntity(state, questions, true);
    }
  }

  private async decidePerEntity(
    state: string | Record<string, unknown>,
    questions: Record<string, Question>,
    retryingBatch: boolean,
  ): Promise<ProviderResult> {
    const answers: Record<string, Answer> = {};
    let totalLatency = 0;

    for (const [index, [qId, q]] of Object.entries(questions).entries()) {
      if (retryingBatch && this.retryBaseMs > 0) {
        const backoff = Math.min(this.retryBaseMs * 2 ** Math.min(index, 3), 400);
        await sleep(backoff);
      }

      try {
        const { rawAnswers, latencyMs } = await this.postSystemOne(state, { [qId]: q });
        totalLatency += latencyMs;
        const sanitized = sanitizeAnswer(rawAnswers[qId], q);
        if (sanitized) answers[qId] = sanitized;
      } catch {
        // Leave the failed question unanswered so the simulator can fall back for it.
      }
    }

    return {
      answers,
      meta: {
        latencyMs: totalLatency,
        provider: this.name,
        batched: false,
        ...missingAnswerMetadata(questions, answers),
      },
    };
  }

  private recordSweepOutcome(asked: number, missing: number): void {
    this.sweepWindow.push({ asked, missing });
    if (this.sweepWindow.length > DEGRADATION_WINDOW) {
      this.sweepWindow.shift();
    }
    const completeness = (asked - missing) / asked;
    if (completeness >= COMPLETENESS_THRESHOLD) {
      this.consecutiveDegradedSweeps = 0;
      if (!this.isDegraded) {
        this.degradedWarningEmitted = false;
      }
      return;
    }

    this.consecutiveDegradedSweeps += 1;
    if (
      this.consecutiveDegradedSweeps >= CONSECUTIVE_FAILURE_LIMIT &&
      !this.degradedWarningEmitted
    ) {
      this.degradedWarningEmitted = true;
      this.onWarning?.(
        `System One is degraded: ${Math.round(this.partialFallbackRate * 100)}% of recent decisions required scripted fallback across ${this.consecutiveDegradedSweeps} consecutive partial sweeps.`,
      );
    }
  }

  private async scriptedFallback(
    state: string | Record<string, unknown>,
    questions: Record<string, Question>,
    seed: number,
    latencyMs: number,
    batched: boolean,
  ): Promise<ProviderResult> {
    this.scriptedFallbackActive = true;
    const { answers } = await this.fallback.decide(state, questions, seed);
    return {
      answers,
      meta: { latencyMs, provider: this.fallback.name, batched, fallbackUsed: true },
    };
  }
}
