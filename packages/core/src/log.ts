import type {
  DaySummary,
  DecisionLogRecord,
  HeaderLogRecord,
  ItemKind,
  JsonlRecord,
  TickHashRecord,
} from "./types.ts";

export interface ParsedRunLog {
  header?: HeaderLogRecord;
  decisions: DecisionLogRecord[];
  tickHashes: TickHashRecord[];
}

export function serializeJsonlRecord(record: JsonlRecord): string {
  return JSON.stringify(record);
}

export function serializeJsonl(records: readonly JsonlRecord[]): string {
  return `${records.map((r) => JSON.stringify(r)).join("\n")}\n`;
}

export function parseJsonl(content: string): ParsedRunLog {
  const decisions: DecisionLogRecord[] = [];
  const tickHashes: TickHashRecord[] = [];
  let header: HeaderLogRecord | undefined;

  const lines = content.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const parsed = JSON.parse(line) as JsonlRecord;
    if (parsed.recordType === "header") {
      header = parsed;
    } else if (parsed.recordType === "decision") {
      decisions.push(parsed);
    } else if (parsed.recordType === "tick") {
      tickHashes.push(parsed);
    }
  }

  return { header, decisions, tickHashes };
}

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = values.toSorted((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round((sorted[idx] ?? 0) * 100) / 100;
}

export function explainLastDecision(
  decisions: readonly DecisionLogRecord[],
  entityId: string,
): DecisionLogRecord | undefined {
  const target = entityId.toLowerCase();
  for (let i = decisions.length - 1; i >= 0; i--) {
    const rec = decisions[i]!;
    if (rec.entity.toLowerCase() === target) {
      return rec;
    }
  }
  return undefined;
}

export function formatExplainReport(record: DecisionLogRecord): string {
  const probs = Object.entries(record.probabilities)
    .toSorted(([, a], [, b]) => b - a)
    .map(([action, prob]) => {
      const pct = (prob * 100).toFixed(1).padStart(5);
      const bars = "#".repeat(Math.round(prob * 24));
      const marker = action === record.action ? " <-- chosen" : "";
      return `  ${action.padEnd(12)} ${pct}%  ${bars}${marker}`;
    })
    .join("\n");

  return [
    `=== Explain: ${record.entity} (Day ${record.day}, ${record.time}, tick ${record.tick}) ===`,
    `Question ID : ${record.question_id}`,
    `Provider    : ${record.provider} (latency ${record.latency_ms}ms, escalated=${record.escalated})`,
    `Chosen      : ${record.action} (confidence ${(record.confidence * 100).toFixed(1)}%)`,
    `State Hash  : ${record.state_hash}`,
    ``,
    `Shared State:`,
    `  ${record.state_summary}`,
    ``,
    `Serialized Instruction:`,
    `  ${record.instructions}`,
    ``,
    `Probability Distribution:`,
    probs,
  ].join("\n");
}

function formatStockCompact(stock: Partial<Record<ItemKind, number>>): string {
  const items = (Object.entries(stock) as Array<[ItemKind, number]>)
    .filter(([, qty]) => qty > 0)
    .toSorted(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}:${v}`);
  return items.length > 0 ? items.join(" ") : "-";
}

export function formatDaySummaryTable(summary: DaySummary): string {
  const escalatedLabel =
    summary.provider === "scripted" ? "n/a (scripted)" : String(summary.escalatedDecisions);
  const lines: string[] = [
    ``,
    `--- End of Day ${summary.day} (${summary.weather}) ---`,
    `Trades: ${summary.trades} | Bread: ${summary.breadProduced} | Stew: ${summary.stewProduced} | Meals: ${summary.mealsTotal} (min/entity: ${summary.minMealsPerEntity})`,
    `Provider calls: ${summary.providerCalls} | Latency p50/p95: ${summary.p50LatencyMs}ms / ${summary.p95LatencyMs}ms | Fallback: ${(summary.fallbackRate * 100).toFixed(1)}% | Escalated: ${escalatedLabel}`,
    `Final Hash: ${summary.finalStateHash.slice(0, 16)}...`,
    ``,
    `${"Entity".padEnd(10)} ${"Role".padEnd(11)} ${"Gold".padStart(5)} ${"Meals".padStart(6)}  Stock`,
    `${"-".repeat(62)}`,
  ];

  for (const e of summary.entities) {
    lines.push(
      `${e.name.padEnd(10)} ${e.role.padEnd(11)} ${(String(e.gold) + "g").padStart(5)} ${String(e.meals).padStart(6)}  ${formatStockCompact(e.stock)}`,
    );
  }

  return lines.join("\n");
}
