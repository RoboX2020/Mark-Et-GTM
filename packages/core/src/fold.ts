import type {
  AgentDecision,
  AgentMessage,
  AnchorInterview,
  AdoptionPoint,
  BacktestResult,
  BassFit,
  Brief,
  EvidenceItem,
  FinanceForecast,
  GraphEdge,
  GraphNode,
  Interview,
  InterviewQA,
  MarketBacktestRow,
  MarketSignal,
  Persona,
  ReportSection,
  RoundSummary,
  SocialEdge,
} from "./domain.js";
import { STAGES, type EventEnvelope, type Stage, type StageStatus } from "./events.js";

export interface ActivityItem {
  seq: number;
  ts: number;
  kind: "stage" | "evidence" | "signal" | "graph" | "agent" | "decision" | "message" | "round" | "interview" | "fit" | "finance" | "report" | "backtest" | "log";
  text: string;
  agentId?: string;
  tone?: "positive" | "negative" | "neutral";
}

export interface RunState {
  runId: string | null;
  label: string;
  mode: string;
  brief: Brief | null;
  backtestCaseId?: string;
  cutoff?: string;
  startedAt: number | null;
  lastTs: number | null;
  status: "idle" | "running" | "ok" | "error";
  stages: Record<Stage, { status: StageStatus; detail?: string }>;
  evidence: EvidenceItem[];
  signals: MarketSignal[];
  anchors: AnchorInterview[];
  nodes: Map<string, GraphNode>;
  edges: Map<string, GraphEdge>;
  personas: Map<string, Persona>;
  socialEdges: SocialEdge[];
  currentRound: number;
  thinking: Set<string>;
  /** Latest decision per agent. */
  agentState: Map<string, AgentDecision>;
  /** Full history per agent, by round. */
  decisions: Map<string, AgentDecision[]>;
  messages: AgentMessage[];
  rounds: RoundSummary[];
  adoption: AdoptionPoint[];
  bass: BassFit | null;
  interviews: Map<string, { agentId: string; qa: InterviewQA[]; done: Interview | null }>;
  finance: FinanceForecast | null;
  report: Map<string, ReportSection>;
  backtest: BacktestResult | null;
  marketBacktest: MarketBacktestRow[];
  activity: ActivityItem[];
  usage: Record<string, { calls: number; inputTokens: number; outputTokens: number }>;
  eventCount: number;
}

const ACTIVITY_LIMIT = 400;

export function emptyState(): RunState {
  return {
    runId: null,
    label: "",
    mode: "",
    brief: null,
    startedAt: null,
    lastTs: null,
    status: "idle",
    stages: Object.fromEntries(STAGES.map((s) => [s, { status: "pending" as StageStatus }])) as RunState["stages"],
    evidence: [],
    signals: [],
    anchors: [],
    nodes: new Map(),
    edges: new Map(),
    personas: new Map(),
    socialEdges: [],
    currentRound: 0,
    thinking: new Set(),
    agentState: new Map(),
    decisions: new Map(),
    messages: [],
    rounds: [],
    adoption: [],
    bass: null,
    interviews: new Map(),
    finance: null,
    report: new Map(),
    backtest: null,
    marketBacktest: [],
    activity: [],
    usage: {},
    eventCount: 0,
  };
}

function tone(x: number): ActivityItem["tone"] {
  return x > 0.15 ? "positive" : x < -0.15 ? "negative" : "neutral";
}

function clip(s: string, n = 140): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/**
 * Applies one envelope to the state in place and returns it. Mutation keeps
 * replays of 100k+ events cheap; UIs track `eventCount` to know when to render.
 */
export function applyEvent(state: RunState, env: EventEnvelope): RunState {
  const e = env.event;
  state.eventCount++;
  state.lastTs = env.ts;
  const push = (item: Omit<ActivityItem, "seq" | "ts">) => {
    state.activity.push({ seq: env.seq, ts: env.ts, ...item });
    if (state.activity.length > ACTIVITY_LIMIT) state.activity.splice(0, state.activity.length - ACTIVITY_LIMIT);
  };
  const name = (id: string) => state.personas.get(id)?.name ?? id;

  switch (e.type) {
    case "run.started": {
      const fresh = emptyState();
      Object.assign(state, fresh, {
        runId: env.runId,
        label: e.label,
        mode: e.mode,
        brief: e.brief,
        backtestCaseId: e.backtestCaseId,
        cutoff: e.cutoff,
        startedAt: env.ts,
        lastTs: env.ts,
        status: "running",
        eventCount: 1,
      });
      push({ kind: "stage", text: `Run started — ${e.label}` });
      break;
    }
    case "stage":
      state.stages[e.stage] = { status: e.status, detail: e.detail };
      if (e.status === "running" || e.status === "done" || e.status === "error")
        push({ kind: "stage", text: `${e.stage} · ${e.status}${e.detail ? ` — ${e.detail}` : ""}` });
      break;
    case "evidence.added":
      state.evidence.push(e.item);
      push({ kind: "evidence", text: `${e.item.source}: ${clip(e.item.title ?? e.item.text, 110)}` });
      break;
    case "signal.added":
      state.signals.push(e.signal);
      push({ kind: "signal", text: `${e.signal.venue} ${(e.signal.probability * 100).toFixed(0)}% — ${clip(e.signal.question, 100)}` });
      break;
    case "anchor.added":
      state.anchors.push(e.anchor);
      push({ kind: "evidence", text: `Anchor interview — ${clip(e.anchor.segmentHint, 80)}` });
      break;
    case "graph.node":
      state.nodes.set(e.node.id, e.node);
      push({ kind: "graph", text: `+ ${e.node.kind.replace("_", " ")}: ${e.node.label}` });
      break;
    case "graph.edge":
      state.edges.set(e.edge.id, e.edge);
      break;
    case "agent.created":
      state.personas.set(e.persona.id, e.persona);
      state.agentState.set(e.persona.id, {
        round: 0,
        agentId: e.persona.id,
        state: "unaware",
        previous: "unaware",
        exposure: "none",
        sentiment: 0,
        wtp: e.persona.wtp,
        comment: "",
        reasoning: "",
        influencedBy: [],
        shownNodeIds: [],
        backend: e.persona.backend,
      });
      if (state.personas.size <= 12 || state.personas.size % 50 === 0)
        push({ kind: "agent", text: `Agent ${e.persona.name} — ${e.persona.role}`, agentId: e.persona.id });
      break;
    case "network.edges":
      state.socialEdges.push(...e.edges);
      break;
    case "round.started":
      state.currentRound = e.round;
      push({ kind: "round", text: `Round ${e.round} · month ${e.month}` });
      break;
    case "agent.thinking":
      state.thinking.add(e.agentId);
      break;
    case "agent.decision": {
      const d = e.decision;
      state.thinking.delete(d.agentId);
      state.agentState.set(d.agentId, d);
      const hist = state.decisions.get(d.agentId) ?? [];
      hist.push(d);
      state.decisions.set(d.agentId, hist);
      if (d.state !== d.previous || d.comment)
        push({
          kind: "decision",
          agentId: d.agentId,
          tone: tone(d.sentiment),
          text: `${name(d.agentId)} → ${d.state}${d.comment ? `: “${clip(d.comment, 120)}”` : ""}`,
        });
      break;
    }
    case "agent.message":
      state.messages.push(e.message);
      push({
        kind: "message",
        agentId: e.message.from,
        tone: tone(e.message.sentiment),
        text: `${name(e.message.from)} → ${name(e.message.to)}: “${clip(e.message.text, 110)}”`,
      });
      break;
    case "round.completed":
      state.rounds.push(e.summary);
      state.thinking.clear();
      push({
        kind: "round",
        text: `Round ${e.summary.round} done — ${e.summary.counts.adopted} adopted, ${e.summary.counts.considering} considering`,
      });
      break;
    case "adoption.point":
      state.adoption.push(e.point);
      break;
    case "bass.fit":
      state.bass = e.fit;
      push({ kind: "fit", text: `Bass fit p=${e.fit.p.toFixed(4)} q=${e.fit.q.toFixed(3)} m=${(e.fit.m * 100).toFixed(1)}%` });
      break;
    case "interview.started":
      state.interviews.set(e.agentId, { agentId: e.agentId, qa: [], done: null });
      push({ kind: "interview", agentId: e.agentId, text: `Interviewing ${name(e.agentId)}` });
      break;
    case "interview.answer": {
      const iv = state.interviews.get(e.agentId) ?? { agentId: e.agentId, qa: [], done: null };
      iv.qa[e.index] = { question: e.question, answer: e.answer };
      state.interviews.set(e.agentId, iv);
      break;
    }
    case "interview.completed": {
      const iv = state.interviews.get(e.interview.agentId) ?? { agentId: e.interview.agentId, qa: [], done: null };
      iv.qa = e.interview.qa;
      iv.done = e.interview;
      state.interviews.set(e.interview.agentId, iv);
      push({ kind: "interview", agentId: e.interview.agentId, text: `${name(e.interview.agentId)}: “${clip(e.interview.topObjection, 100)}”` });
      break;
    }
    case "finance.computed":
      state.finance = e.finance;
      push({ kind: "finance", text: `Forecast — break-even ${e.finance.breakEvenMonth ? `month ${e.finance.breakEvenMonth}` : "not within 12 months"}` });
      break;
    case "report.section":
      state.report.set(e.id, { id: e.id, title: e.title, order: e.order, text: "", done: false });
      push({ kind: "report", text: `Writing — ${e.title}` });
      break;
    case "report.delta": {
      const s = state.report.get(e.id);
      if (s) s.text += e.text;
      break;
    }
    case "report.section.done": {
      const s = state.report.get(e.id);
      if (s) s.done = true;
      break;
    }
    case "backtest.result":
      state.backtest = e.result;
      push({ kind: "backtest", text: `Backtest vs reality — MAPE ${(e.result.mape * 100).toFixed(1)}%` });
      break;
    case "market_backtest.row":
      state.marketBacktest.push(e.row);
      push({ kind: "backtest", text: `Market Q — swarm ${(e.row.swarmProbability * 100).toFixed(0)}% vs market ${(e.row.marketProbability * 100).toFixed(0)}%` });
      break;
    case "log":
      if (e.level !== "info") push({ kind: "log", text: `${e.level}: ${e.message}`, tone: "negative" });
      break;
    case "run.completed":
      state.status = e.status;
      state.usage = e.usage;
      state.thinking.clear();
      push({ kind: "stage", text: `Run ${e.status === "ok" ? "complete" : "failed"}` });
      break;
  }
  return state;
}

export function foldAll(envs: EventEnvelope[]): RunState {
  const s = emptyState();
  for (const env of envs) applyEvent(s, env);
  return s;
}
