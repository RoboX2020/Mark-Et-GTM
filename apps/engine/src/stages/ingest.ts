import type { EvidenceItem, EvidenceSource, MarketSignal } from "@market/core";
import type { RunContext } from "../context.js";
import { apifyActor, apifyInput, brightdataDataset, brightdataNews, normalise } from "../connectors/social.js";
import { kalshiSignals, MACRO_KEYWORDS, polymarketSignals } from "../connectors/markets.js";
import { fixtureAnchors, fixtureEvidence, fixtureSignals } from "../connectors/fixtures.js";
import { loadAnchors } from "../connectors/anchors.js";

const MAX_EVIDENCE = 160;
const MIN_LIVE_EVIDENCE = 20;

function queries(ctx: RunContext): string[] {
  const b = ctx.brief;
  const q = [b.product.category, `${b.product.category} app ${b.targetMarket}`];
  for (const c of b.competitors.slice(0, 3)) q.push(`${c} alternative`, `${c} too expensive`);
  return [...new Set(q)].slice(0, 6);
}

type Fetcher = { source: EvidenceSource; via: string; run: (q: string) => Promise<Record<string, unknown>[]> };

function fetchers(ctx: RunContext): Fetcher[] {
  const { brightdata: bd, apify } = ctx.cfg;
  const out: Fetcher[] = [];
  if (bd.token) {
    out.push({ source: "news", via: "brightdata.serp", run: (q) => brightdataNews(bd, q, ctx.cutoff) });
    for (const [source, id] of Object.entries(bd.datasets) as [EvidenceSource, string][])
      if (id) out.push({ source, via: `brightdata.${source}`, run: (q) => brightdataDataset(bd, id, q) });
  }
  if (apify.token) {
    for (const [source, actor] of Object.entries(apify.actors) as [EvidenceSource, string][]) {
      if (!actor || out.some((f) => f.source === source)) continue;
      out.push({ source, via: `apify.${source}`, run: (q) => apifyActor(apify.token, actor, apifyInput(source, q)) });
    }
  }
  return out;
}

export async function ingest(ctx: RunContext): Promise<void> {
  const { bus, cache, cutoff } = ctx;
  bus.emit({ type: "stage", stage: "ingest", status: "running", detail: `cutoff ${cutoff.slice(0, 10)}` });

  // ── Social + news ──────────────────────────────────────────────
  let items: EvidenceItem[] = [];
  const qs = queries(ctx);
  for (const f of fetchers(ctx)) {
    for (const q of qs) {
      try {
        const raw = await cache.through(`evidence/${f.via}`, { q, cutoff }, () => f.run(q));
        (raw ?? []).forEach((r, i) => {
          const n = normalise(r, f.source, q, i);
          if (n) items.push(n);
        });
      } catch (err) {
        bus.log(`${f.via} "${q}" failed: ${(err as Error).message.slice(0, 160)}`, "warn");
      }
    }
  }

  // Strict cutoff: in a backtest, undated items could leak post-launch knowledge.
  const cutoffMs = new Date(cutoff).getTime();
  items = items.filter((e) => (e.publishedAt ? new Date(e.publishedAt).getTime() <= cutoffMs : !ctx.backtest));

  if (items.length < MIN_LIVE_EVIDENCE) {
    if (ctx.cfg.mode !== "mock") bus.log(`Only ${items.length} live/cached posts — topping up with labelled fixture data`, "warn");
    items.push(...fixtureEvidence(ctx.brief, cutoff));
  }

  const seen = new Set<string>();
  items = items
    .map((e) => (ctx.anon ? ctx.anon.evidence(e) : e))
    .filter((e) => {
      const k = e.text.slice(0, 80).toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => b.engagement - a.engagement)
    .slice(0, MAX_EVIDENCE);

  for (const item of items) bus.emit({ type: "evidence.added", item });
  ctx.evidence = items;

  // ── Prediction markets ─────────────────────────────────────────
  const keywords = [...MACRO_KEYWORDS, ...ctx.brief.product.category.toLowerCase().split(/\W+/).filter((w) => w.length > 3), ...ctx.brief.competitors.map((c) => c.toLowerCase())];
  let signals: MarketSignal[] = [];
  const backtestCutoff = ctx.backtest ? cutoff : undefined;
  for (const [ns, run] of [
    ["markets/kalshi", () => kalshiSignals(ctx.cfg.kalshi, keywords, backtestCutoff)],
    ["markets/polymarket", () => polymarketSignals(ctx.cfg.polymarket, keywords, backtestCutoff)],
  ] as const) {
    try {
      signals.push(...((await cache.through(ns, { keywords, cutoff: backtestCutoff ?? cutoff.slice(0, 10) }, run)) ?? []));
    } catch (err) {
      bus.log(`${ns} failed: ${(err as Error).message.slice(0, 160)}`, "warn");
    }
  }
  if (!signals.length) signals = fixtureSignals(ctx.brief, cutoff);
  // Resolved outcomes are never shown to the simulation.
  signals = signals.map(({ outcome: _drop, ...s }) => s);
  for (const signal of signals) bus.emit({ type: "signal.added", signal });
  ctx.signals = signals;

  // ── Real-people anchors ────────────────────────────────────────
  let anchors = loadAnchors(ctx.cfg.dataDir);
  if (!anchors.length) anchors = fixtureAnchors(ctx.brief);
  for (const anchor of anchors) bus.emit({ type: "anchor.added", anchor });
  ctx.anchors = anchors;

  const synthetic = items.filter((e) => e.synthetic).length;
  bus.emit({
    type: "stage",
    stage: "ingest",
    status: "done",
    detail: `${items.length} posts (${synthetic} fixture), ${signals.length} market signals, ${anchors.length} anchors`,
  });
}
