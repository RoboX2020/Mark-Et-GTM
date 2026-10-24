import { median, quantile, tokens, type Channel, type EvidenceSource } from "@market/core";
import type { RunContext } from "./context.js";
import { lastDecision } from "./context.js";
import { detectThemes, THEMES } from "./lexicon.js";

// Deterministic aggregates computed from the run. The report, the finance
// layer and the backtest all read from these, so every narrative claim traces
// back to agent ids and evidence ids.

export interface SegmentStat {
  id: string;
  label: string;
  n: number;
  adopted: number;
  considering: number;
  rejected: number;
  adoptionRate: number;
  avgSentiment: number;
  medianWtp: number;
  sampleAgentIds: string[];
}

export interface ObjectionCluster {
  key: string;
  label: string;
  count: number;
  agentIds: string[];
  quotes: { agentId: string; text: string }[];
  evidenceIds: string[];
  suggestedAnswer?: string;
}

export interface ChannelStat {
  channel: Channel;
  exposed: number;
  adopted: number;
  conversion: number;
  adopterIds: string[];
  evidenceIds: string[];
}

export interface Analytics {
  segments: SegmentStat[];
  objections: ObjectionCluster[];
  channels: ChannelStat[];
  price: {
    price: number;
    currency: string;
    wtpMedian: number;
    wtpP25: number;
    wtpP75: number;
    verdicts: Record<string, number>;
    verdict: "too_cheap" | "fair" | "too_expensive";
    shareAbovePrice: number;
    interviewAgentIds: string[];
  };
  backends: { backend: string; agents: number; adopted: number; rate: number }[];
  topComments: { agentId: string; text: string; sentiment: number }[];
  adopterQuotes: { agentId: string; text: string; sentiment: number }[];
}

const SOURCE_FOR: Partial<Record<Channel, EvidenceSource>> = { reddit: "reddit", x: "x", tiktok: "tiktok", product_hunt: "product_hunt", app_store: "app_store" };

export function computeAnalytics(ctx: RunContext): Analytics {
  const final = new Map(ctx.personas.map((p) => [p.id, lastDecision(ctx, p.id)]));

  const segments: SegmentStat[] = ctx.nodes
    .filter((n) => n.kind === "segment")
    .map((s) => {
      const members = ctx.personas.filter((p) => p.segmentId === s.id);
      const ds = members.map((p) => final.get(p.id)).filter(Boolean);
      const count = (st: string) => ds.filter((d) => d!.state === st).length;
      return {
        id: s.id,
        label: s.label,
        n: members.length,
        adopted: count("adopted"),
        considering: count("considering"),
        rejected: count("rejected"),
        adoptionRate: members.length ? count("adopted") / members.length : 0,
        avgSentiment: ds.length ? ds.reduce((a, d) => a + d!.sentiment, 0) / ds.length : 0,
        medianWtp: median(members.map((p) => final.get(p.id)?.wtp ?? p.wtp)),
        sampleAgentIds: members.filter((p) => final.get(p.id)?.state === "adopted").slice(0, 4).map((p) => p.id),
      };
    })
    .sort((a, b) => b.adoptionRate - a.adoptionRate);

  // Objections: from decisions and interviews, clustered onto known themes or graph pains.
  const painNodes = ctx.nodes.filter((n) => n.kind === "pain");
  const clusters = new Map<string, ObjectionCluster>();
  const addObjection = (agentId: string, text: string) => {
    if (!text?.trim()) return;
    const theme = detectThemes(text)[0];
    let key = theme ? `theme:${theme.id}` : "";
    let label = theme?.objection ?? "";
    let evidenceIds: string[] = [];
    const tt = tokens(text);
    let best = 0;
    for (const pn of painNodes) {
      const overlap = [...tokens(`${pn.label} ${pn.summary ?? ""}`)].filter((w) => tt.has(w)).length;
      if (overlap > best) {
        best = overlap;
        if (!theme) {
          key = `pain:${pn.id}`;
          label = pn.label;
        }
        evidenceIds = pn.evidenceIds;
      }
    }
    if (!key) {
      key = `raw:${[...tt].slice(0, 3).join("_")}`;
      label = text;
    }
    const c = clusters.get(key) ?? { key, label, count: 0, agentIds: [], quotes: [], evidenceIds, suggestedAnswer: theme?.answer };
    if (!c.agentIds.includes(agentId)) {
      c.count++;
      c.agentIds.push(agentId);
    }
    if (c.quotes.length < 4) c.quotes.push({ agentId, text });
    clusters.set(key, c);
  };
  for (const [id, d] of final) if (d?.objection) addObjection(id, d.objection);
  for (const iv of ctx.interviews) addObjection(iv.agentId, iv.topObjection);
  const objections = [...clusters.values()].sort((a, b) => b.count - a.count).slice(0, 8);

  const channels: ChannelStat[] = [];
  const allCh = new Set<Channel>([...ctx.brief.channels, ...ctx.firstExposure.values()]);
  for (const ch of allCh) {
    const exposedIds = [...ctx.firstExposure].filter(([, c]) => c === ch).map(([id]) => id);
    const adopterIds = exposedIds.filter((id) => final.get(id)?.state === "adopted");
    const src = SOURCE_FOR[ch];
    channels.push({
      channel: ch,
      exposed: exposedIds.length,
      adopted: adopterIds.length,
      conversion: exposedIds.length ? adopterIds.length / exposedIds.length : 0,
      adopterIds,
      evidenceIds: src ? ctx.evidence.filter((e) => e.source === src).slice(0, 12).map((e) => e.id) : [],
    });
  }
  channels.sort((a, b) => b.adopted - a.adopted);

  const ivWtp = ctx.interviews.map((i) => i.wtp);
  const allWtp = ivWtp.length >= 5 ? ivWtp : [...final.values()].filter(Boolean).map((d) => d!.wtp);
  const verdicts: Record<string, number> = { too_cheap: 0, fair: 0, too_expensive: 0 };
  for (const iv of ctx.interviews) verdicts[iv.priceVerdict]++;
  const price = ctx.brief.price.amount;
  const verdict = (Object.entries(verdicts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "fair") as Analytics["price"]["verdict"];

  const byBackend = new Map<string, { agents: number; adopted: number }>();
  for (const p of ctx.personas) {
    const d = final.get(p.id);
    const k = d?.backend ?? p.backend;
    const b = byBackend.get(k) ?? { agents: 0, adopted: 0 };
    b.agents++;
    if (d?.state === "adopted") b.adopted++;
    byBackend.set(k, b);
  }

  const comments = [...final.values()].filter((d) => d?.comment).map((d) => ({ agentId: d!.agentId, text: d!.comment, sentiment: d!.sentiment }));
  comments.sort((a, b) => Math.abs(b.sentiment) - Math.abs(a.sentiment));

  return {
    segments,
    objections,
    channels,
    price: {
      price,
      currency: ctx.brief.price.currency,
      wtpMedian: median(allWtp),
      wtpP25: quantile(allWtp, 0.25),
      wtpP75: quantile(allWtp, 0.75),
      verdicts,
      verdict,
      shareAbovePrice: allWtp.length ? allWtp.filter((w) => w >= price).length / allWtp.length : 0,
      interviewAgentIds: ctx.interviews.map((i) => i.agentId),
    },
    backends: [...byBackend].map(([backend, b]) => ({ backend, ...b, rate: b.agents ? b.adopted / b.agents : 0 })),
    topComments: comments.slice(0, 12),
    adopterQuotes: [...final.values()]
      .filter((d) => d?.state === "adopted" && d.comment)
      .map((d) => ({ agentId: d!.agentId, text: d!.comment, sentiment: d!.sentiment }))
      .sort((a, b) => b.sentiment - a.sentiment)
      .slice(0, 6),
  };
}

export { THEMES };
