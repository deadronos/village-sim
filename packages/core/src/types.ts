export type QuestionType = "choice" | "noul" | "score";

export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
}

export interface NoulQuestion {
  type: "noul";
  instructions: string;
  criteria: { true: string; false: string };
}

export interface ScoreQuestion {
  type: "score";
  instructions: string;
  criteria: string[];
}

export type Question = ChoiceQuestion | NoulQuestion | ScoreQuestion;

export interface Answer {
  type: QuestionType;
  choice?: string;
  noul?: number;
  score?: number;
  probabilities: Record<string, number>;
  confidence?: number;
}

export interface ProviderCallMetadata {
  latencyMs: number;
  provider: string;
  batched: boolean;
  fallbackUsed?: boolean;
  error?: string;
}

export interface ProviderResult {
  answers: Record<string, Answer>;
  meta: ProviderCallMetadata;
}

export interface DecisionProvider {
  readonly name: string;
  decide(
    state: string | Record<string, unknown>,
    questions: Record<string, Question>,
    seed: number,
  ): Promise<ProviderResult>;
}

export type ProviderKind = "systemone" | "scripted" | "replay";
export type BatchMode = "auto" | "always" | "never";
export type SampleMode = "weighted" | "argmax";

export interface SimConfig {
  provider: ProviderKind;
  endpoint: string;
  model: string;
  timeoutMs: number;
  batch: BatchMode;
  maxBatch: number;
  sample: SampleMode;
  minConf: number;
  apiKey?: string;
  seed: number;
  days: number;
  ticksPerDay: number;
  minutesPerTick: number;
  startHour: number;
  replayPath?: string;
  quiet?: boolean;
}

export type Role =
  | "farmer"
  | "baker"
  | "innkeeper"
  | "woodcutter"
  | "smith"
  | "herbalist"
  | "guard"
  | "child";

export type ItemKind = "wheat" | "water" | "bread" | "stew" | "wood" | "tool" | "herbs";

export type Focus = "duty" | "earn" | "socialize" | "rest";

export type ActionKind =
  | "work"
  | "buy_food"
  | "restock"
  | "rest"
  | "socialize"
  | "patrol"
  | "wander";

export type Weather = "clear" | "overcast" | "rain" | "breezy";

export type ProsperityTier = "lean" | "steady" | "thriving";

export type RelationshipTier = "cool" | "neutral" | "warm" | "close";

export type RumorKind = "shortage" | "surplus" | "friendship" | "prosperity" | "gift";

export interface Rumor {
  id: string;
  kind: RumorKind;
  subjectId: string;
  summary: string;
  originDay: number;
  originTick: number;
  hops: number;
  sourceId: string;
}

export interface Needs {
  hunger: number;
  energy: number;
  social: number;
}

export interface EntityGoal {
  kind: ActionKind;
  targetPlace: string;
  targetEntity?: string;
  targetItem?: ItemKind;
  ticksLeft: number;
  route: string[];
  phase: "travel" | "execute";
}

export interface LastDecisionSnapshot {
  day: number;
  tick: number;
  questionId: string;
  action: string;
  probabilities: Record<string, number>;
  confidence: number;
  provider: string;
  escalated: boolean;
  instructions: string;
  worldStateSummary: string;
  criteria: Record<string, string>;
}

export interface Entity {
  id: string;
  name: string;
  role: Role;
  title: string;
  duty: string;
  home: string;
  workplace: string;
  location: string;
  prevLocation: string;
  gold: number;
  inventory: Partial<Record<ItemKind, number>>;
  needs: Needs;
  focus: Focus;
  goal: EntityGoal | null;
  decisionCooldown: number;
  memory: string[];
  rumors: Rumor[];
  affinity: Record<string, number>;
  mealsToday: number;
  tradesToday: number;
  lastDecision?: LastDecisionSnapshot;
}

export interface PlaceNode {
  id: string;
  name: string;
  kind: "well" | "bakery" | "tavern" | "market" | "fields" | "woods" | "smithy" | "garden" | "home";
  x: number;
  z: number;
  ownerId?: string;
}

export interface PlaceEdge {
  from: string;
  to: string;
  cost: number;
}

export interface SimEvent {
  day: number;
  tick: number;
  time: string;
  kind:
    | "trade"
    | "produce"
    | "eat"
    | "move"
    | "socialize"
    | "gossip"
    | "gift"
    | "rest"
    | "patrol"
    | "wander"
    | "wage"
    | "demand"
    | "dawn"
    | "decision"
    | "deadlock"
    | "system";
  entityId?: string;
  otherEntityId?: string;
  place?: string;
  item?: ItemKind;
  qty?: number;
  gold?: number;
  rumorSummary?: string;
  message: string;
}

export interface DecisionLogRecord {
  recordType: "decision";
  day: number;
  tick: number;
  time: string;
  entity: string;
  question_id: string;
  action: string;
  probabilities: Record<string, number>;
  confidence: number;
  provider: string;
  seed: number;
  state_hash: string;
  escalated: boolean;
  fallback?: boolean;
  latency_ms: number;
  instructions: string;
  state_summary: string;
  criteria: Record<string, string>;
}

export interface HeaderLogRecord {
  recordType: "header";
  version: 1;
  seed: number;
  provider: ProviderKind;
  model: string;
  sample: SampleMode;
  minConf: number;
  maxBatch?: number;
  days: number;
  ticksPerDay: number;
  minutesPerTick: number;
}

export interface TickHashRecord {
  recordType: "tick";
  day: number;
  tick: number;
  time: string;
  state_hash: string;
}

export type JsonlRecord = HeaderLogRecord | DecisionLogRecord | TickHashRecord;

export interface DaySummary {
  day: number;
  weather: Weather;
  trades: number;
  breadProduced: number;
  stewProduced: number;
  mealsTotal: number;
  minMealsPerEntity: number;
  providerCalls: number;
  providerDecisions: number;
  fallbackDecisions: number;
  escalatedDecisions: number;
  latenciesMs: number[];
  p50LatencyMs: number;
  p95LatencyMs: number;
  fallbackRate: number;
  finalStateHash: string;
  entities: Array<{
    id: string;
    name: string;
    role: Role;
    gold: number;
    meals: number;
    stock: Partial<Record<ItemKind, number>>;
  }>;
}

export interface WorldState {
  seed: number;
  day: number;
  tick: number;
  minutesPerTick: number;
  ticksPerDay: number;
  startHour: number;
  weather: Weather;
  prosperity: ProsperityTier;
  prosperityScore: number;
  entities: Entity[];
  initialTotalGold: number;
  totalGoldMinted: number;
  tradesToday: number;
  tradesTotal: number;
  breadProducedToday: number;
  stewProducedToday: number;
  mealsToday: number;
  deadlockCounter: Record<string, number>;
}

export interface TickSnapshot {
  day: number;
  tick: number;
  time: string;
  weather: Weather;
  prosperity: ProsperityTier;
  prosperityScore: number;
  stateHash: string;
  entities: Entity[];
  events: SimEvent[];
  decisions: DecisionLogRecord[];
  daySummary?: DaySummary;
  stats: {
    tradesToday: number;
    tradesTotal: number;
    breadProducedToday: number;
    stewProducedToday: number;
    mealsToday: number;
    totalGold: number;
    providerCalls: number;
    fallbackRate: number;
  };
}
