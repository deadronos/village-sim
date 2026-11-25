import { pickArgmax } from "../rng.ts";
import type { Answer, BatchMode, DecisionProvider, ProviderResult, Question } from "../types.ts";
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
}

interface WireResponse {
  answers?: Record<string, unknown>;
  latency_ms?: number;
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
 * failure, malformed answer rejection, and permanent fallback to ScriptedProvider
 * if the endpoint is unreachable for the run (§5.3, §5.4, §17).
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
  private readonly fallback = new ScriptedProvider();
  private permanentlyDown = false;
  private consecutiveNetworkFailures = 0;

  constructor(options: SystemOneOptions) {
    this.endpoint = options.endpoint;
    this.model = options.model;
    this.timeoutMs = options.timeoutMs;
    this.batch = options.batch;
    this.apiKey = options.apiKey;
    this.retryBaseMs = options.retryBaseMs ?? 40;
    this.onWarning = options.onWarning;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  get isFallbackActive(): boolean {
    return this.permanentlyDown;
  }

  /**
   * Health check via `GET /v1/models` (a bare `GET /` returns 404 on System One servers).
   */
  async checkHealth(): Promise<{ ok: boolean; status?: number; error?: string }> {
    try {
      const url = new URL(this.endpoint);
      url.pathname = "/v1/models";
      const headers: Record<string, string> = {};
      if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
      const res = await this.fetchImpl(url.toString(), {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(Math.min(this.timeoutMs, 5000)),
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
        questions,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    const elapsed = Math.round(performance.now() - start);
    if (!res.ok) {
      throw new HttpStatusError(res.status, `System One HTTP ${res.status}`);
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

    if (this.permanentlyDown) {
      const fb = await this.fallback.decide(state, questions, seed);
      return {
        answers: fb.answers,
        meta: {
          latencyMs: 0,
          provider: this.fallback.name,
          batched: keys.length > 1,
          fallbackUsed: true,
        },
      };
    }

    const shouldBatch = this.batch === "always" || (this.batch === "auto" && keys.length >= 2);

    if (shouldBatch) {
      try {
        const { rawAnswers, latencyMs } = await this.postSystemOne(state, questions);
        this.consecutiveNetworkFailures = 0;
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
      } catch (err) {
        // Batched call failed: retry once per-entity with bounded exponential backoff (§5.4)
        const isNetworkError = !(err instanceof HttpStatusError);
        const perEntity = await this.retryPerEntity(state, questions, seed, isNetworkError);
        return perEntity;
      }
    }

    // Single-question or DECISION_BATCH=never path
    return this.decidePerEntity(state, questions, seed);
  }

  private async decidePerEntity(
    state: string | Record<string, unknown>,
    questions: Record<string, Question>,
    seed: number,
  ): Promise<ProviderResult> {
    const answers: Record<string, Answer> = {};
    let totalLatency = 0;
    let networkFailures = 0;
    let anySuccess = false;

    for (const [qId, q] of Object.entries(questions)) {
      try {
        const { rawAnswers, latencyMs } = await this.postSystemOne(state, { [qId]: q });
        totalLatency += latencyMs;
        anySuccess = true;
        this.consecutiveNetworkFailures = 0;
        const sanitized = sanitizeAnswer(rawAnswers[qId], q);
        if (sanitized) {
          answers[qId] = sanitized;
        }
      } catch (err) {
        if (!(err instanceof HttpStatusError)) {
          networkFailures += 1;
        }
      }
    }

    if (!anySuccess && networkFailures === Object.keys(questions).length) {
      this.tripPermanentFallback(
        "System One endpoint unreachable; switching permanently to scripted provider.",
      );
      const fb = await this.fallback.decide(state, questions, seed);
      return {
        answers: fb.answers,
        meta: {
          latencyMs: totalLatency,
          provider: this.fallback.name,
          batched: false,
          fallbackUsed: true,
        },
      };
    }

    return {
      answers,
      meta: {
        latencyMs: totalLatency,
        provider: anySuccess ? this.name : this.fallback.name,
        batched: false,
        ...missingAnswerMetadata(questions, answers),
      },
    };
  }

  private async retryPerEntity(
    state: string | Record<string, unknown>,
    questions: Record<string, Question>,
    seed: number,
    initialWasNetworkError: boolean,
  ): Promise<ProviderResult> {
    const answers: Record<string, Answer> = {};
    let totalLatency = 0;
    let successes = 0;
    let networkErrors = initialWasNetworkError ? 1 : 0;

    let idx = 0;
    for (const [qId, q] of Object.entries(questions)) {
      if (this.retryBaseMs > 0) {
        const backoff = Math.min(this.retryBaseMs * 2 ** Math.min(idx, 3), 400);
        await sleep(backoff);
      }
      idx += 1;

      try {
        const { rawAnswers, latencyMs } = await this.postSystemOne(state, { [qId]: q });
        totalLatency += latencyMs;
        successes += 1;
        this.consecutiveNetworkFailures = 0;
        const sanitized = sanitizeAnswer(rawAnswers[qId], q);
        if (sanitized) {
          answers[qId] = sanitized;
        }
      } catch (err) {
        if (!(err instanceof HttpStatusError)) {
          networkErrors += 1;
        }
      }
    }

    if (successes === 0) {
      if (networkErrors >= Object.keys(questions).length) {
        this.consecutiveNetworkFailures += 1;
        if (this.consecutiveNetworkFailures >= 1) {
          this.tripPermanentFallback(
            `System One endpoint ${this.endpoint} unreachable; switching permanently to scripted provider.`,
          );
        }
      }
      const fb = await this.fallback.decide(state, questions, seed);
      return {
        answers: fb.answers,
        meta: {
          latencyMs: totalLatency,
          provider: this.fallback.name,
          batched: false,
          fallbackUsed: true,
        },
      };
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

  private tripPermanentFallback(message: string): void {
    if (!this.permanentlyDown) {
      this.permanentlyDown = true;
      this.onWarning?.(message);
    }
  }
}

class HttpStatusError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
