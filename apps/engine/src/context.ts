import type {
  AgentDecision,
  AnchorInterview,
  BassFit,
  Brief,
  Channel,
  EvidenceItem,
  FinanceForecast,
  GraphEdge,
  GraphNode,
  Interview,
  MarketSignal,
  Persona,
  AdoptionPoint,
  SocialEdge,
  BacktestCase,
} from "@market/core";
import { Rng } from "@market/core";
import type { EventBus } from "./bus.js";
import type { Cache } from "./cache.js";
import type { EngineConfig } from "./config.js";
import type { Anonymizer } from "./connectors/anonymize.js";
import type { LlmRouter } from "./llm/router.js";

/** Segment-level behavioural priors extracted with the graph; personas are sampled from these. */
export interface SegmentProfile {
  id: string;
  innovativeness: number;
  priceSensitivity: number;
  socialInfluence: number;
  skepticism: number;
  wtpMultiple: number;
  ageBand: string;
  roles: string[];
}

export interface RunContext {
  cfg: EngineConfig;
  bus: EventBus;
  llm: LlmRouter;
  cache: Cache;
  brief: Brief;
  cutoff: string;
  rng: Rng;
  anon?: Anonymizer;
  backtest?: BacktestCase;
  leakageWarnings: string[];

  evidence: EvidenceItem[];
  signals: MarketSignal[];
  anchors: AnchorInterview[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  profiles: Map<string, SegmentProfile>;
  personas: Persona[];
  neighbours: Map<string, SocialEdge[]>;
  decisions: Map<string, AgentDecision[]>;
  firstExposure: Map<string, Channel>;
  adoption: AdoptionPoint[];
  interviews: Interview[];
  bass?: BassFit;
  finance?: FinanceForecast;
}

export function createContext(base: Pick<RunContext, "cfg" | "bus" | "llm" | "cache" | "brief" | "cutoff" | "anon" | "backtest">): RunContext {
  return {
    ...base,
    rng: new Rng(base.brief.seed),
    leakageWarnings: [],
    evidence: [],
    signals: [],
    anchors: [],
    nodes: [],
    edges: [],
    profiles: new Map(),
    personas: [],
    neighbours: new Map(),
    decisions: new Map(),
    firstExposure: new Map(),
    adoption: [],
    interviews: [],
  };
}

export function lastDecision(ctx: RunContext, agentId: string): AgentDecision | undefined {
  const h = ctx.decisions.get(agentId);
  return h?.[h.length - 1];
}

export function briefSummary(b: Brief): string {
  const per = b.price.model === "one_time" ? "one-time" : b.price.model === "subscription_annual" ? "per year" : b.price.model === "freemium" ? "per month (freemium; free tier available)" : "per month";
  return [
    `Product: ${b.product.name} — ${b.product.description}`,
    `Category: ${b.product.category}`,
    `Price: ${b.price.currency} ${b.price.amount} ${per}`,
    `Target market: ${b.targetMarket} (${b.geography})`,
    `Competitors: ${b.competitors.join(", ") || "none named"}`,
    `Launch channels: ${b.channels.join(", ")}`,
    `Launch date: ${b.launchDate}`,
  ].join("\n");
}
