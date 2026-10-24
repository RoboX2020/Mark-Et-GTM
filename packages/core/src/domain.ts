// Domain model shared by the engine, the SpacetimeDB module (mirrored in Rust)
// and the portal. Everything here is plain JSON so it can travel through the
// event log unchanged.

export type Channel =
  | "product_hunt"
  | "reddit"
  | "x"
  | "tiktok"
  | "app_store"
  | "seo"
  | "paid_social"
  | "email"
  | "partnerships"
  | "word_of_mouth";

export type PriceModel = "one_time" | "subscription_monthly" | "subscription_annual" | "freemium";

export interface Brief {
  product: { name: string; description: string; category: string; url?: string };
  price: { amount: number; currency: string; model: PriceModel };
  targetMarket: string;
  geography: string;
  competitors: string[];
  channels: Channel[];
  launchDate: string; // ISO date
  /** Number of reachable buyers in the target market; scales the Bass m. */
  addressableMarket: number;
  population: number; // synthetic customers, 100–1000
  rounds: number; // social rounds
  monthsPerRound: number;
  seed: number;
  budget: {
    startingCash: number;
    monthlyMarketing: number;
    /** Share of the marketing budget by channel; missing channels split the rest evenly. */
    channelSplit?: Partial<Record<Channel, number>>;
    fixedMonthlyCosts: number;
    cogsPct: number; // 0..1 of revenue
    monthlyChurn: number; // 0..1, subscription only
  };
}

export type EvidenceSource = "reddit" | "x" | "tiktok" | "product_hunt" | "app_store" | "play_store" | "news";

/** A scraped post reduced to what the model needs. Author identity is dropped at ingestion. */
export interface EvidenceItem {
  id: string;
  source: EvidenceSource;
  title?: string;
  text: string;
  url?: string;
  publishedAt: string;
  engagement: number;
  query: string;
}

export interface MarketSignal {
  id: string;
  venue: "kalshi" | "polymarket";
  question: string;
  probability: number; // 0..1, price at asOf
  volume: number;
  closesAt?: string;
  asOf: string;
  category: string;
  /** Resolved outcome, only for backtests of resolved markets. */
  outcome?: 0 | 1;
}

/** A real interview used as an anchor. Stored as an aggregate summary plus short quotes. */
export interface AnchorInterview {
  id: string;
  segmentHint: string;
  summary: string;
  quotes: string[];
  statedWtp?: number;
}

export type NodeKind = "product" | "segment" | "pain" | "competitor" | "trend" | "price_point" | "condition" | "channel";

export interface GraphNode {
  id: string;
  kind: NodeKind;
  label: string;
  /** 0..1 salience: segment share, pain frequency, condition probability, etc. */
  weight: number;
  summary?: string;
  attrs?: Record<string, string | number | boolean>;
  evidenceIds: string[];
}

export type EdgeRelation =
  | "feels" // segment → pain
  | "uses" // segment → competitor
  | "prefers" // segment → channel
  | "anchors_on" // segment → price_point
  | "solves" // product|competitor → pain
  | "affects" // condition|trend → segment
  | "competes_with"; // product → competitor

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  relation: EdgeRelation;
  weight: number;
  evidenceIds: string[];
}

export type Backend = "claude" | "gemini" | "runpod" | "mock";

export interface Persona {
  id: string;
  name: string; // synthetic
  segmentId: string;
  ageBand: string;
  role: string;
  bio: string;
  traits: {
    innovativeness: number; // propensity to adopt unprompted (Bass p-like)
    susceptibility: number; // weight given to peers (Bass q-like)
    priceSensitivity: number;
    skepticism: number;
  };
  wtp: number; // prior willingness to pay, same currency as brief
  painIds: string[];
  channelPrefs: Channel[];
  competitorIds: string[];
  backend: Backend;
  anchorId?: string;
}

export interface SocialEdge {
  source: string;
  target: string;
  weight: number;
}

export type AdoptionState = "unaware" | "aware" | "considering" | "adopted" | "rejected";

export interface AgentDecision {
  round: number;
  agentId: string;
  state: AdoptionState;
  previous: AdoptionState;
  exposure: "channel" | "peer" | "both" | "none";
  channel?: Channel;
  sentiment: number; // -1..1
  wtp: number;
  comment: string;
  reasoning: string;
  objection?: string;
  influencedBy: string[];
  shownNodeIds: string[];
  backend: Backend;
}

export interface AgentMessage {
  round: number;
  from: string;
  to: string;
  text: string;
  sentiment: number;
  transport: "local" | "fetchai";
}

export interface RoundSummary {
  round: number;
  counts: Record<AdoptionState, number>;
  avgSentiment: number;
  newAdopters: number;
  byBackend: Partial<Record<Backend, { adopted: number; total: number }>>;
}

export interface InterviewQA {
  question: string;
  answer: string;
}

export interface Interview {
  agentId: string;
  qa: InterviewQA[];
  wtp: number;
  priceVerdict: "too_cheap" | "fair" | "too_expensive";
  topObjection: string;
  wouldRecommend: boolean;
  evidenceIds: string[];
}

export interface AdoptionPoint {
  month: number;
  cumulative: number; // fraction of population adopted
  newAdopters: number;
}

export interface BassFit {
  p: number;
  q: number;
  m: number; // eventual adoption fraction of the addressable market
  rmse: number;
  observed: AdoptionPoint[];
  curve: { month: number; cumulative: number }[];
  peakMonth: number;
}

export interface Provenance {
  agentIds: string[];
  evidenceIds: string[];
  confidence: number; // 0..1
  needsReview: boolean;
  note?: string;
}

export interface FinanceMonth {
  month: number;
  newCustomers: number;
  activeCustomers: number;
  revenue: number;
  marketing: number;
  cogs: number;
  fixed: number;
  net: number;
  cash: number;
}

export interface ChannelEconomics {
  channel: Channel;
  spend: number;
  customers: number;
  cac: number | null;
  conversionShare: number;
  provenance: Provenance;
}

export interface FinanceForecast {
  currency: string;
  months: FinanceMonth[];
  channels: ChannelEconomics[];
  breakEvenMonth: number | null;
  totalRevenue12: number;
  minCash: number;
  runwayMonths: number | null;
  arpu: number;
  wtpMedian: number;
  items: { key: string; label: string; value: number; unit: string; provenance: Provenance }[];
}

export interface ReportSection {
  id: string;
  title: string;
  order: number;
  text: string;
  done: boolean;
}

export interface BacktestCase {
  id: string;
  realName: string;
  alias: string;
  aliasTerms: string[];
  brief: Brief;
  actual: {
    source: string;
    /** Observed cumulative adoption as a fraction of addressable market, by month. */
    adoption: { month: number; cumulative: number }[];
    topComplaints: string[];
    priceOutcome: "too_cheap" | "fair" | "too_expensive";
    notes: string;
  };
}

export interface BacktestResult {
  caseId: string;
  alias: string;
  realName: string;
  cutoff: string;
  predicted: { month: number; cumulative: number }[];
  actual: { month: number; cumulative: number }[];
  mape: number;
  objectionOverlap: number;
  priceMatch: boolean;
  hits: string[];
  misses: string[];
  leakageWarnings: string[];
}

export interface MarketBacktestRow {
  signalId: string;
  question: string;
  cutoff: string;
  swarmProbability: number;
  marketProbability: number;
  outcome: 0 | 1;
  swarmBrier: number;
  marketBrier: number;
}
