import { Rng, type AnchorInterview, type Brief, type EvidenceItem, type EvidenceSource, type MarketSignal } from "@market/core";
import { THEMES } from "../lexicon.js";

// Offline stand-ins used when there is no live or cached data. Everything is
// flagged `synthetic: true` and shown as such in the portal and report.

const SOURCE_FOR_CHANNEL: Partial<Record<string, EvidenceSource>> = {
  reddit: "reddit",
  x: "x",
  tiktok: "tiktok",
  product_hunt: "product_hunt",
  app_store: "app_store",
};

const OPENERS: Record<EvidenceSource, string[]> = {
  reddit: ["Genuine question:", "Rant incoming.", "PSA for anyone looking at {cat} tools:", "Has anyone else noticed", ""],
  x: ["hot take:", "ok but", "", "unpopular opinion:"],
  tiktok: ["POV: you finally found a {cat} app that", "storytime:", "", "rating {cat} apps so you don't have to:"],
  product_hunt: ["Congrats on the launch!", "Interesting approach.", "Upvoted.", ""],
  app_store: ["★★★", "★★", "★★★★", "★"],
  play_store: ["★★★", "★★★★"],
  news: [""],
};

const HEADLINES = [
  "{cat} startups race to add AI features as {c} raises prices",
  "Survey: younger buyers report subscription fatigue across {cat} apps",
  "{c} faces backlash over data policy change",
  "Investors cool on {cat} as consumer spending tightens",
  "The quiet rise of indie {cat} tools challenging {c}",
];

export function fixtureEvidence(brief: Brief, cutoff: string, count = 220): EvidenceItem[] {
  const rng = new Rng(`evidence:${brief.seed}:${brief.product.category}`);
  const comps = brief.competitors.length ? brief.competitors : ["the big incumbent"];
  const sources: EvidenceSource[] = [...new Set([...brief.channels.map((c) => SOURCE_FOR_CHANNEL[c]).filter(Boolean), "reddit", "news"] as EvidenceSource[])];
  const priceStr = `$${Math.round(brief.price.amount)}`;
  // Price concern grows with price; everything else gets a seeded weight.
  const weights = new Map(THEMES.map((t) => [t.id, t.id === "price" ? 0.6 + Math.log10(1 + brief.price.amount) * 0.35 : rng.range(0.3, 1)]));
  const end = new Date(cutoff).getTime();
  const out: EvidenceItem[] = [];
  for (let i = 0; i < count; i++) {
    const source = rng.pick(sources);
    const c = rng.pick(comps);
    const fill = (s: string) => s.replaceAll("{c}", c).replaceAll("{p}", priceStr).replaceAll("{cat}", brief.product.category);
    const publishedAt = new Date(end - rng.range(1, 150) * 86400_000).toISOString();
    if (source === "news") {
      const title = fill(rng.pick(HEADLINES));
      out.push({ id: `fx_news_${i}`, source, title, text: `${title}. Analysts point to shifting expectations among ${brief.targetMarket}.`, publishedAt, engagement: rng.int(10, 900), query: brief.product.category, synthetic: true });
      continue;
    }
    const theme = rng.weighted(THEMES, (t) => weights.get(t.id) ?? 0.5);
    const opener = fill(rng.pick(OPENERS[source]));
    const body = fill(rng.pick(theme.phrases));
    out.push({
      id: `fx_${source}_${i}`,
      source,
      text: `${opener} ${body}`.trim(),
      publishedAt,
      engagement: Math.round(Math.exp(rng.range(1, 7))),
      query: `${brief.product.category} ${c}`,
      synthetic: true,
    });
  }
  return out;
}

const MACRO: [string, string, number][] = [
  ["Will the Fed cut rates at the next FOMC meeting?", "economy", 0.42],
  ["Will the US enter a recession this year?", "economy", 0.27],
  ["Will CPI inflation come in above 3% this quarter?", "economy", 0.35],
  ["Will consumer sentiment rise next month?", "economy", 0.48],
  ["Will a major AI lab release a new frontier model this quarter?", "tech", 0.81],
  ["Will Apple announce a new AI feature at its next event?", "tech", 0.74],
  ["Will US tech layoffs exceed last quarter's?", "industry", 0.38],
];

export function fixtureSignals(brief: Brief, cutoff: string): MarketSignal[] {
  const rng = new Rng(`signals:${brief.seed}`);
  return MACRO.map(([question, category, base], i) => ({
    id: `fx_sig_${i}`,
    venue: i % 2 ? "polymarket" : "kalshi",
    question,
    probability: Math.min(0.97, Math.max(0.03, base + rng.normal(0, 0.05))),
    volume: Math.round(Math.exp(rng.range(9, 14))),
    asOf: cutoff,
    category,
    synthetic: true,
  }));
}

export function fixtureAnchors(brief: Brief): AnchorInterview[] {
  const rng = new Rng(`anchors:${brief.seed}`);
  const p = brief.price.amount;
  return [
    { hint: "price-conscious early adopter", wtp: p * 0.7, quote: "I'd try anything new if the free tier is real. I cancel subscriptions every January." },
    { hint: "busy professional", wtp: p * 1.6, quote: "Time is the only thing I care about. If it saves an hour a week the price is irrelevant." },
    { hint: "skeptical incumbent user", wtp: p * 0.5, quote: `I've used ${brief.competitors[0] ?? "the market leader"} for years. Switching would need to be painless.` },
    { hint: "community-driven recommender", wtp: p * 1.1, quote: "I only buy things my group chat already uses. If two friends vouch, I'm in." },
  ].map((a, i) => ({
    id: `anchor_fx_${i}`,
    segmentHint: a.hint,
    summary: `Fixture anchor (no Listen Labs data loaded): ${a.hint} in ${brief.targetMarket}.`,
    quotes: [a.quote],
    statedWtp: Math.round(a.wtp * (0.9 + rng.next() * 0.2) * 100) / 100,
    synthetic: true,
  }));
}
