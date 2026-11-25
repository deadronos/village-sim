import type {
  Answer,
  DecisionLogRecord,
  DecisionProvider,
  HeaderLogRecord,
  ProviderResult,
  Question,
} from "../types.ts";

/**
 * Re-emits recorded probability distributions from a decisions.jsonl log so
 * `village replay` reproduces the identical per-tick hash sequence (§5.1, §9, A7).
 */
export class ReplayProvider implements DecisionProvider {
  readonly name = "replay";
  readonly runVersion: HeaderLogRecord["version"];
  private readonly recordsByKey = new Map<string, DecisionLogRecord>();
  private currentDay = 1;
  private currentTick = 0;

  constructor(records: readonly DecisionLogRecord[], runVersion: HeaderLogRecord["version"] = 3) {
    this.runVersion = runVersion;
    for (const rec of records) {
      this.recordsByKey.set(this.keyFor(rec.day, rec.tick, rec.question_id), rec);
    }
  }

  setCursor(day: number, tick: number): void {
    this.currentDay = day;
    this.currentTick = tick;
  }

  getRecord(day: number, tick: number, questionId: string): DecisionLogRecord | undefined {
    return this.recordsByKey.get(this.keyFor(day, tick, questionId));
  }

  private keyFor(day: number, tick: number, questionId: string): string {
    return `${day}:${tick}:${questionId}`;
  }

  async decide(
    _state: string | Record<string, unknown>,
    questions: Record<string, Question>,
    _seed: number,
  ): Promise<ProviderResult> {
    const answers: Record<string, Answer> = {};
    const fallbackQuestionIds: string[] = [];

    for (const qId of Object.keys(questions)) {
      const rec = this.recordsByKey.get(this.keyFor(this.currentDay, this.currentTick, qId));
      if (!rec) continue;
      if (rec.fallback) fallbackQuestionIds.push(qId);
      answers[qId] = {
        type: "choice",
        choice: rec.action,
        probabilities: { ...rec.probabilities },
        confidence: rec.confidence,
      };
    }

    return {
      answers,
      meta: {
        latencyMs: 0,
        provider: this.name,
        batched: Object.keys(questions).length > 1,
        fallbackUsed: fallbackQuestionIds.length > 0,
        fallbackQuestionIds,
      },
    };
  }
}
