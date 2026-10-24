import { z } from "zod";
import { clamp01, Rng, type Channel, type EdgeRelation, type GraphEdge, type GraphNode } from "@market/core";
import { briefSummary, type RunContext, type SegmentProfile } from "../context.js";
import { detectThemes, THEMES } from "../lexicon.js";

const CHANNELS = ["product_hunt", "reddit", "x", "tiktok", "app_store", "seo", "paid_social", "email", "partnerships", "word_of_mouth"] as const;
const RELATIONS = ["feels", "uses", "prefers", "anchors_on", "solves", "affects", "competes_with"] as const;

const GraphSchema = z.object({
  recognizedProduct: z.boolean().describe("True if you recognise the product as a real, already-launched product."),
  segments: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      share: z.number().describe("Share of the target market, 0-1; shares sum to ~1"),
      summary: z.string(),
      ageBand: z.string(),
      roles: z.array(z.string()),
      innovativeness: z.number().describe("0-1"),
      priceSensitivity: z.number().describe("0-1"),
      socialInfluence: z.number().describe("0-1, how much peers sway them"),
      skepticism: z.number().describe("0-1"),
      wtpMultiple: z.number().describe("Typical willingness to pay as a multiple of the launch price"),
      evidenceIds: z.array(z.string()),
    }),
  ),
  pains: z.array(
    z.object({ id: z.string(), label: z.string(), frequency: z.number().describe("0-1"), positive: z.boolean(), summary: z.string(), evidenceIds: z.array(z.string()) }),
  ),
  competitors: z.array(z.object({ id: z.string(), label: z.string(), strength: z.number().describe("0-1"), summary: z.string(), evidenceIds: z.array(z.string()) })),
  trends: z.array(z.object({ id: z.string(), label: z.string(), strength: z.number().describe("0-1"), summary: z.string(), evidenceIds: z.array(z.string()) })),
  pricePoints: z.array(z.object({ id: z.string(), label: z.string(), amount: z.number(), summary: z.string(), evidenceIds: z.array(z.string()) })),
  conditions: z.array(
    z.object({ id: z.string(), label: z.string(), probability: z.number(), direction: z.enum(["tailwind", "headwind"]), signalIds: z.array(z.string()) }),
  ),
  channels: z.array(z.object({ id: z.enum(CHANNELS), weight: z.number().describe("0-1 relevance for this market") })),
  edges: z.array(z.object({ source: z.string(), target: z.string(), relation: z.enum(RELATIONS), weight: z.number(), evidenceIds: z.array(z.string()) })),
});
type GraphOut = z.infer<typeof GraphSchema>;

const SYSTEM = `You are a market analyst building a knowledge graph of the market a product is about to launch into.
Work only from the evidence provided. Every node and edge must cite the evidence ids (or market signal ids) that support it; do not invent ids.
Describe aggregate patterns across many posts: segments, recurring pains, competitor positions, price anchors, macro conditions. Never describe or profile an individual poster.
Use short snake_case ids prefixed by kind: seg_, pain_, comp_, trend_, price_, cond_. Use "product" as the id of the product being launched, and channel ids as given.
Edges: segment→pain "feels", segment→competitor "uses", segment→channel "prefers", segment→price "anchors_on", competitor|product→pain "solves", condition|trend→segment "affects", product→competitor "competes_with".
Aim for 3–6 segments, 5–10 pains (include positive desires with positive=true), every named competitor, 2–5 price points, and conditions from the market signals.
If you recognise the product as a real launched product, set recognizedProduct=true but still reason only from the evidence.`;

function compactEvidence(ctx: RunContext): string {
  return ctx.evidence
    .map((e) => `[${e.id}] (${e.source}, ${e.publishedAt.slice(0, 10)}, eng ${e.engagement}) ${e.title ? e.title + " — " : ""}${e.text.slice(0, 320).replace(/\s+/g, " ")}`)
    .join("\n");
}

export async function buildGraph(ctx: RunContext): Promise<void> {
  const { bus, llm, brief } = ctx;
  bus.emit({ type: "stage", stage: "graph", status: "running", detail: `extracting with ${llm.reasoningBackend}` });

  const prompt = [
    "## Launch brief",
    briefSummary(brief),
    "\n## Market signals (prediction-market probabilities)",
    ctx.signals.map((s) => `[${s.id}] ${s.venue} ${(s.probability * 100).toFixed(0)}% — ${s.question}`).join("\n"),
    "\n## Anchor interviews (real people, summarised)",
    ctx.anchors.map((a) => `[${a.id}] ${a.segmentHint}: ${a.summary} Quotes: ${a.quotes.join(" | ")}${a.statedWtp ? ` Stated WTP: ${a.statedWtp}` : ""}`).join("\n"),
    "\n## Evidence",
    compactEvidence(ctx),
  ].join("\n");

  const { value } = await llm.json(llm.reasoningBackend, { purpose: "graph", system: SYSTEM, prompt, schema: GraphSchema, maxTokens: 24000, mock: () => mockGraph(ctx) });
  if (value.recognizedProduct && ctx.backtest) ctx.leakageWarnings.push("Graph extractor reported recognising the product despite anonymisation.");
  materialise(ctx, value);
  bus.emit({ type: "stage", stage: "graph", status: "done", detail: `${ctx.nodes.length} nodes, ${ctx.edges.length} edges` });
}

function materialise(ctx: RunContext, g: GraphOut) {
  const validEvidence = new Set([...ctx.evidence.map((e) => e.id), ...ctx.signals.map((s) => s.id), ...ctx.anchors.map((a) => a.id)]);
  const ev = (ids: string[]) => ids.filter((i) => validEvidence.has(i));
  const nodes: GraphNode[] = [
    { id: "product", kind: "product", label: ctx.brief.product.name, weight: 1, summary: ctx.brief.product.description, evidenceIds: [] },
  ];
  const shareTotal = g.segments.reduce((a, s) => a + Math.max(0, s.share), 0) || 1;
  for (const s of g.segments) {
    const share = Math.max(0, s.share) / shareTotal;
    nodes.push({ id: s.id, kind: "segment", label: s.label, weight: share, summary: s.summary, attrs: { ageBand: s.ageBand }, evidenceIds: ev(s.evidenceIds) });
    ctx.profiles.set(s.id, {
      id: s.id,
      innovativeness: clamp01(s.innovativeness),
      priceSensitivity: clamp01(s.priceSensitivity),
      socialInfluence: clamp01(s.socialInfluence),
      skepticism: clamp01(s.skepticism),
      wtpMultiple: Math.max(0.05, s.wtpMultiple),
      ageBand: s.ageBand,
      roles: s.roles.length ? s.roles : [s.label],
    });
  }
  for (const p of g.pains)
    nodes.push({ id: p.id, kind: p.positive ? "trend" : "pain", label: p.label, weight: clamp01(p.frequency), summary: p.summary, attrs: { positive: p.positive }, evidenceIds: ev(p.evidenceIds) });
  for (const c of g.competitors) nodes.push({ id: c.id, kind: "competitor", label: c.label, weight: clamp01(c.strength), summary: c.summary, evidenceIds: ev(c.evidenceIds) });
  for (const t of g.trends) nodes.push({ id: t.id, kind: "trend", label: t.label, weight: clamp01(t.strength), summary: t.summary, evidenceIds: ev(t.evidenceIds) });
  for (const p of g.pricePoints)
    nodes.push({ id: p.id, kind: "price_point", label: p.label, weight: 0.5, summary: p.summary, attrs: { amount: p.amount }, evidenceIds: ev(p.evidenceIds) });
  for (const c of g.conditions)
    nodes.push({ id: c.id, kind: "condition", label: c.label, weight: clamp01(c.probability), attrs: { direction: c.direction }, evidenceIds: ev(c.signalIds) });
  for (const c of g.channels) if (!nodes.some((n) => n.id === c.id)) nodes.push({ id: c.id, kind: "channel", label: c.id.replaceAll("_", " "), weight: clamp01(c.weight), evidenceIds: [] });

  const ids = new Set(nodes.map((n) => n.id));
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  for (const e of g.edges) {
    const key = `${e.source}|${e.relation}|${e.target}`;
    if (!ids.has(e.source) || !ids.has(e.target) || seen.has(key)) continue;
    seen.add(key);
    edges.push({ id: `e_${edges.length}`, source: e.source, target: e.target, relation: e.relation as EdgeRelation, weight: clamp01(e.weight), evidenceIds: ev(e.evidenceIds) });
  }
  // Make sure each segment has at least one channel preference so exposure works.
  for (const s of g.segments)
    if (!edges.some((e) => e.source === s.id && e.relation === "prefers"))
      for (const ch of ctx.brief.channels.slice(0, 2))
        if (ids.has(ch)) edges.push({ id: `e_${edges.length}`, source: s.id, target: ch, relation: "prefers", weight: 0.4, evidenceIds: [] });

  // Emit kind by kind so the portal graph grows in a readable order.
  const order = ["product", "segment", "pain", "trend", "competitor", "price_point", "condition", "channel"];
  nodes.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  for (const node of nodes) ctx.bus.emit({ type: "graph.node", node });
  for (const edge of edges) ctx.bus.emit({ type: "graph.edge", edge });
  ctx.nodes = nodes;
  ctx.edges = edges;
}

// ── Deterministic offline extraction ─────────────────────────────────────────

const SEGMENT_ARCHETYPES = [
  { key: "price", label: "Budget-conscious early adopters", inn: 0.62, price: 0.82, soc: 0.55, skep: 0.45, wtp: 0.7, age: "18–26", roles: ["student", "junior freelancer", "new grad"] },
  { key: "time", label: "Time-poor professionals", inn: 0.45, price: 0.3, soc: 0.35, skep: 0.5, wtp: 1.6, age: "28–45", roles: ["product manager", "consultant", "founder"] },
  { key: "incumbent", label: "Loyal incumbent users", inn: 0.18, price: 0.55, soc: 0.3, skep: 0.75, wtp: 0.55, age: "25–50", roles: ["team lead", "operations manager", "power user"] },
  { key: "social", label: "Community-driven followers", inn: 0.3, price: 0.6, soc: 0.85, skep: 0.35, wtp: 1.0, age: "18–34", roles: ["creator", "student", "hobbyist"] },
  { key: "privacy", label: "Privacy-first skeptics", inn: 0.25, price: 0.45, soc: 0.25, skep: 0.88, wtp: 1.1, age: "30–55", roles: ["engineer", "researcher", "lawyer"] },
];

export function mockGraph(ctx: RunContext): GraphOut {
  const rng = new Rng(`graph:${ctx.brief.seed}`);
  const counts = new Map<string, string[]>();
  for (const e of ctx.evidence) for (const t of detectThemes(`${e.title ?? ""} ${e.text}`)) counts.set(t.id, [...(counts.get(t.id) ?? []), e.id]);
  const maxCount = Math.max(1, ...[...counts.values()].map((v) => v.length));
  const themes = THEMES.filter((t) => counts.has(t.id));

  const archetypes = SEGMENT_ARCHETYPES.filter((a) => a.key !== "privacy" || counts.has("privacy")).slice(0, 5);
  const shares = archetypes.map(() => rng.range(0.6, 1.4));
  const total = shares.reduce((a, b) => a + b, 0);
  const segments = archetypes.map((a, i) => {
    const related = themes.filter((t) => (a.key === "price" && t.id === "price") || (a.key === "privacy" && t.id === "privacy") || (a.key === "time" && t.id === "time_savings") || (a.key === "social" && t.id === "community_love") || (a.key === "incumbent" && t.id === "integration"));
    return {
      id: `seg_${a.key}`,
      label: a.label,
      share: shares[i] / total,
      summary: `${a.label} within ${ctx.brief.targetMarket}.`,
      ageBand: a.age,
      roles: a.roles,
      innovativeness: a.inn,
      priceSensitivity: a.price,
      socialInfluence: a.soc,
      skepticism: a.skep,
      wtpMultiple: a.wtp,
      evidenceIds: related.flatMap((t) => (counts.get(t.id) ?? []).slice(0, 4)),
    };
  });

  const pains = themes.map((t) => ({
    id: `pain_${t.id}`,
    label: t.label,
    frequency: (counts.get(t.id)?.length ?? 0) / maxCount,
    positive: t.polarity > 0,
    summary: t.objection ?? t.label,
    evidenceIds: (counts.get(t.id) ?? []).slice(0, 8),
  }));

  const competitors = ctx.brief.competitors.map((c) => {
    const ids = ctx.evidence.filter((e) => e.text.toLowerCase().includes(c.toLowerCase())).map((e) => e.id);
    return { id: `comp_${c.toLowerCase().replace(/\W+/g, "_")}`, label: c, strength: clamp01(0.3 + ids.length / 40), summary: `Mentioned in ${ids.length} posts.`, evidenceIds: ids.slice(0, 8) };
  });

  const news = ctx.evidence.filter((e) => e.source === "news");
  const trends = news.slice(0, 3).map((e, i) => ({ id: `trend_${i}`, label: (e.title ?? e.text).slice(0, 70), strength: rng.range(0.3, 0.8), summary: e.text.slice(0, 160), evidenceIds: [e.id] }));

  const p = ctx.brief.price.amount;
  const priceIds = counts.get("price") ?? [];
  const pricePoints = [
    { id: "price_free", label: "Free tier expectation", amount: 0, summary: "Many compare against free tiers.", evidenceIds: priceIds.slice(0, 3) },
    { id: "price_launch", label: `Launch price ${p}`, amount: p, summary: "The proposed price.", evidenceIds: [] },
    { id: "price_premium", label: "Premium tier", amount: Math.round(p * 2), summary: "What time-poor buyers say they'd pay.", evidenceIds: priceIds.slice(3, 5) },
  ];

  const conditions = ctx.signals.map((s, i) => ({
    id: `cond_${i}`,
    label: s.question,
    probability: s.probability,
    direction: (/recession|inflation|layoff|tariff/i.test(s.question) ? "headwind" : "tailwind") as "headwind" | "tailwind",
    signalIds: [s.id],
  }));

  const channels = ctx.brief.channels.map((c) => ({ id: c as (typeof CHANNELS)[number], weight: rng.range(0.4, 0.9) }));

  const edges: GraphOut["edges"] = [];
  for (const s of segments) {
    for (const pain of pains) {
      const w = pain.frequency * rng.range(0.3, 1) * (s.id === "seg_price" && pain.id === "pain_price" ? 1.6 : 1);
      if (w > 0.25) edges.push({ source: s.id, target: pain.id, relation: "feels", weight: clamp01(w), evidenceIds: pain.evidenceIds.slice(0, 2) });
    }
    for (const c of competitors) if (rng.chance(0.6)) edges.push({ source: s.id, target: c.id, relation: "uses", weight: rng.range(0.3, 0.9), evidenceIds: c.evidenceIds.slice(0, 2) });
    for (const ch of rng.sample(channels, Math.min(3, channels.length))) edges.push({ source: s.id, target: ch.id, relation: "prefers", weight: rng.range(0.4, 1), evidenceIds: [] });
    edges.push({ source: s.id, target: s.priceSensitivity > 0.6 ? "price_free" : s.wtpMultiple > 1.3 ? "price_premium" : "price_launch", relation: "anchors_on", weight: 0.7, evidenceIds: [] });
  }
  for (const c of conditions) for (const s of rng.sample(segments, 2)) edges.push({ source: c.id, target: s.id, relation: "affects", weight: c.probability, evidenceIds: c.signalIds });
  for (const c of competitors) {
    edges.push({ source: "product", target: c.id, relation: "competes_with", weight: c.strength, evidenceIds: [] });
    for (const pain of rng.sample(pains, 2)) edges.push({ source: c.id, target: pain.id, relation: "solves", weight: rng.range(0.2, 0.6), evidenceIds: [] });
  }
  for (const pain of pains.filter((x) => x.positive)) edges.push({ source: "product", target: pain.id, relation: "solves", weight: 0.7, evidenceIds: [] });

  return { recognizedProduct: false, segments, pains, competitors, trends, pricePoints, conditions, channels, edges };
}

export type { SegmentProfile, Channel };
