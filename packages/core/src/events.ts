import type {
  AgentDecision,
  AgentMessage,
  AnchorInterview,
  BacktestResult,
  BassFit,
  Brief,
  EvidenceItem,
  FinanceForecast,
  GraphEdge,
  GraphNode,
  Interview,
  MarketBacktestRow,
  MarketSignal,
  Persona,
  AdoptionPoint,
  RoundSummary,
  SocialEdge,
} from "./domain.js";

export type Stage =
  | "ingest"
  | "graph"
  | "population"
  | "network"
  | "simulation"
  | "interviews"
  | "bass"
  | "finance"
  | "report"
  | "backtest";

export const STAGES: Stage[] = [
  "ingest",
  "graph",
  "population",
  "network",
  "simulation",
  "interviews",
  "bass",
  "finance",
  "report",
  "backtest",
];

export type StageStatus = "pending" | "running" | "done" | "skipped" | "error";

/**
 * Every observable step of a run. The engine emits these; SpacetimeDB stores
 * them (and materialises typed tables); the portal folds them into view state.
 */
export type MarketEvent =
  | { type: "run.started"; brief: Brief; mode: string; label: string; backtestCaseId?: string; cutoff?: string }
  | { type: "stage"; stage: Stage; status: StageStatus; detail?: string }
  | { type: "evidence.added"; item: EvidenceItem }
  | { type: "signal.added"; signal: MarketSignal }
  | { type: "anchor.added"; anchor: AnchorInterview }
  | { type: "graph.node"; node: GraphNode }
  | { type: "graph.edge"; edge: GraphEdge }
  | { type: "agent.created"; persona: Persona }
  | { type: "network.edges"; edges: SocialEdge[] }
  | { type: "round.started"; round: number; month: number }
  | { type: "agent.thinking"; round: number; agentId: string }
  | { type: "agent.decision"; decision: AgentDecision }
  | { type: "agent.message"; message: AgentMessage }
  | { type: "round.completed"; summary: RoundSummary }
  | { type: "adoption.point"; point: AdoptionPoint }
  | { type: "bass.fit"; fit: BassFit }
  | { type: "interview.started"; agentId: string }
  | { type: "interview.answer"; agentId: string; index: number; question: string; answer: string }
  | { type: "interview.completed"; interview: Interview }
  | { type: "finance.computed"; finance: FinanceForecast }
  | { type: "report.section"; id: string; title: string; order: number }
  | { type: "report.delta"; id: string; text: string }
  | { type: "report.section.done"; id: string }
  | { type: "backtest.result"; result: BacktestResult }
  | { type: "market_backtest.row"; row: MarketBacktestRow }
  | { type: "log"; level: "info" | "warn" | "error"; message: string }
  | { type: "run.completed"; status: "ok" | "error"; usage: Record<string, { calls: number; inputTokens: number; outputTokens: number }> };

export type MarketEventType = MarketEvent["type"];

export interface EventEnvelope {
  runId: string;
  seq: number;
  /** Epoch milliseconds when emitted; replay uses deltas between envelopes. */
  ts: number;
  event: MarketEvent;
}

export function isEnvelope(x: unknown): x is EventEnvelope {
  return (
    typeof x === "object" &&
    x !== null &&
    typeof (x as EventEnvelope).runId === "string" &&
    typeof (x as EventEnvelope).seq === "number" &&
    typeof (x as EventEnvelope).event?.type === "string"
  );
}

export function parseJsonl(text: string): EventEnvelope[] {
  const out: EventEnvelope[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parsed = JSON.parse(trimmed);
    if (isEnvelope(parsed)) out.push(parsed);
  }
  return out.sort((a, b) => a.seq - b.seq);
}
