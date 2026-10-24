import type { MarketSignal } from "@market/core";
import type { EngineConfig } from "../config.js";

// Kalshi and Polymarket expose public, unauthenticated market data. We pull
// open markets relevant to the launch (macro + category keywords) and, for
// backtests, the historical price at the cutoff instead of today's price.

export const MACRO_KEYWORDS = ["fed", "interest rate", "rate cut", "recession", "inflation", "cpi", "gdp", "unemployment", "tariff", "consumer"];

async function json(url: string): Promise<any> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${res.status} ${url.split("?")[0]}`);
  return res.json();
}

function relevant(text: string, keywords: string[]): boolean {
  const t = text.toLowerCase();
  return keywords.some((k) => t.includes(k));
}

function categorise(text: string): string {
  const t = text.toLowerCase();
  if (/fed|rate|inflation|cpi|gdp|recession|unemployment|tariff/.test(t)) return "economy";
  if (/ai|openai|apple|google|tech|launch|iphone|nvidia/.test(t)) return "tech";
  return "industry";
}

const kalshiPrice = (m: any): number => {
  if (m.last_price_dollars !== undefined) return Number(m.last_price_dollars);
  if (m.yes_bid_dollars !== undefined && m.yes_ask_dollars !== undefined) return (Number(m.yes_bid_dollars) + Number(m.yes_ask_dollars)) / 2;
  if (typeof m.last_price === "number" && m.last_price > 0) return m.last_price / 100;
  return ((m.yes_bid ?? 0) + (m.yes_ask ?? 0)) / 200;
};

export async function kalshiSignals(cfg: EngineConfig["kalshi"], keywords: string[], cutoff?: string, limit = 12): Promise<MarketSignal[]> {
  const status = cutoff ? "settled" : "open";
  const data = await json(`${cfg.base}/events?status=${status}&with_nested_markets=true&limit=200`);
  const out: MarketSignal[] = [];
  for (const ev of data.events ?? []) {
    for (const m of ev.markets ?? []) {
      const question = `${ev.title}${m.yes_sub_title ? ` — ${m.yes_sub_title}` : ""}`;
      if (!relevant(`${question} ${ev.category ?? ""}`, keywords)) continue;
      let probability = kalshiPrice(m);
      let asOf = new Date().toISOString();
      if (cutoff) {
        const end = Math.floor(new Date(cutoff).getTime() / 1000);
        const hist = await json(
          `${cfg.base}/series/${ev.series_ticker}/markets/${m.ticker}/candlesticks?start_ts=${end - 7 * 86400}&end_ts=${end}&period_interval=1440`,
        ).catch(() => null);
        const last = hist?.candlesticks?.at(-1);
        if (!last) continue;
        probability = Number(last.price?.close_dollars ?? (last.price?.close ?? last.yes_bid?.close ?? 0) / 100);
        asOf = cutoff;
      }
      out.push({
        id: `kalshi_${m.ticker}`,
        venue: "kalshi",
        question,
        probability,
        volume: Number(m.volume ?? 0),
        closesAt: m.close_time,
        asOf,
        category: categorise(question),
        outcome: m.result === "yes" ? 1 : m.result === "no" ? 0 : undefined,
      });
    }
  }
  return out.sort((a, b) => b.volume - a.volume).slice(0, limit);
}

export async function polymarketSignals(cfg: EngineConfig["polymarket"], keywords: string[], cutoff?: string, limit = 12): Promise<MarketSignal[]> {
  const params = cutoff ? "closed=true&limit=500&order=volume&ascending=false" : "active=true&closed=false&limit=500&order=volume&ascending=false";
  const markets: any[] = await json(`${cfg.gamma}/markets?${params}`);
  const out: MarketSignal[] = [];
  for (const m of markets) {
    if (!relevant(`${m.question} ${m.category ?? ""}`, keywords)) continue;
    const prices = JSON.parse(m.outcomePrices ?? "[]").map(Number);
    let probability = prices[0] ?? 0;
    let asOf = new Date().toISOString();
    if (cutoff) {
      if (m.startDate && new Date(m.startDate) > new Date(cutoff)) continue;
      const token = JSON.parse(m.clobTokenIds ?? "[]")[0];
      const end = Math.floor(new Date(cutoff).getTime() / 1000);
      const hist = await json(`${cfg.clob}/prices-history?market=${token}&startTs=${end - 7 * 86400}&endTs=${end}&fidelity=1440`).catch(() => null);
      const last = hist?.history?.at(-1);
      if (!last) continue;
      probability = Number(last.p);
      asOf = cutoff;
    }
    out.push({
      id: `poly_${m.id}`,
      venue: "polymarket",
      question: m.question,
      probability,
      volume: Number(m.volume ?? 0),
      closesAt: m.endDate,
      asOf,
      category: categorise(m.question),
      outcome: cutoff && prices.length ? (prices[0] > 0.5 ? 1 : 0) : undefined,
    });
  }
  return out.sort((a, b) => b.volume - a.volume).slice(0, limit);
}
