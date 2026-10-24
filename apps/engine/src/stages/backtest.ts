import { z } from "zod";
import { brier, interpolate, mape, phraseOverlap, Rng, type BacktestResult, type MarketBacktestRow, type MarketSignal } from "@market/core";
import type { Analytics } from "../analytics.js";
import type { RunContext } from "../context.js";
import type { EventBus } from "../bus.js";
import type { LlmRouter } from "../llm/router.js";
import { limiter } from "../llm/types.js";

/** Compares the prediction with what actually happened, misses included. */
export async function scoreBacktest(ctx: RunContext, analytics: Analytics): Promise<BacktestResult | null> {
  const bt = ctx.backtest;
  if (!bt || !ctx.bass) return null;
  const { bus } = ctx;
  bus.emit({ type: "stage", stage: "backtest", status: "running", detail: `comparing with observed outcome for ${bt.alias}` });

  const predicted = ctx.bass.curve.map((c) => ({ month: c.month, cumulative: c.cumulative }));
  const actual = bt.actual.adoption;
  const err = mape(predicted, actual);
  const predictedObjections = analytics.objections.map((o) => o.label);
  const overlap = phraseOverlap(predictedObjections, bt.actual.topComplaints);
  const priceMatch = analytics.price.verdict === bt.actual.priceOutcome;

  const hits: string[] = [];
  const misses: string[] = [];
  for (const a of actual) {
    const p = interpolate(predicted, a.month);
    const rel = a.cumulative > 0 ? (p - a.cumulative) / a.cumulative : 0;
    const line = `Month ${a.month}: predicted ${(p * 100).toFixed(2)}% vs actual ${(a.cumulative * 100).toFixed(2)}% (${rel >= 0 ? "+" : ""}${(rel * 100).toFixed(0)}%)`;
    (Math.abs(rel) <= 0.3 ? hits : misses).push(line);
  }
  const matchedActual = new Set(overlap.matched.map(([a]) => a));
  for (const c of bt.actual.topComplaints) {
    if (matchedActual.has(c)) hits.push(`Anticipated complaint: “${c}” (matched “${overlap.matched.find(([a]) => a === c)?.[1]}”)`);
    else misses.push(`Missed complaint: “${c}”`);
  }
  (priceMatch ? hits : misses).push(`Price verdict: predicted ${analytics.price.verdict.replaceAll("_", " ")}, actual ${bt.actual.priceOutcome.replaceAll("_", " ")}`);

  const result: BacktestResult = {
    caseId: bt.id,
    alias: bt.alias,
    realName: bt.realName,
    cutoff: ctx.cutoff,
    predicted,
    actual,
    mape: err,
    objectionOverlap: overlap.score,
    priceMatch,
    hits,
    misses,
    leakageWarnings: [...new Set(ctx.leakageWarnings)],
  };
  bus.emit({ type: "backtest.result", result });

  const section = { id: "backtest", title: "Backtest: prediction vs reality" };
  bus.emit({ type: "report.section", ...section, order: 99 });
  const mock = () =>
    `Run on **${bt.alias}** (revealed after scoring as **${bt.realName}**), using only data up to **${ctx.cutoff.slice(0, 10)}**.\n\n- Adoption curve error (MAPE): **${(err * 100).toFixed(1)}%**\n- Complaint overlap: **${(overlap.score * 100).toFixed(0)}%**\n- Price verdict: **${priceMatch ? "matched" : "missed"}**\n\n**Where it was right:**\n${hits.map((h) => `- ${h}`).join("\n") || "- nothing"}\n\n**Where it missed:**\n${misses.map((m) => `- ${m}`).join("\n") || "- nothing"}\n\n${result.leakageWarnings.length ? `⚑ **Leakage warnings:** ${result.leakageWarnings.join(" ")}` : "No leakage of the real product name was detected in model outputs."}\n\nSource of actuals: ${bt.actual.source}`;
  for await (const chunk of ctx.llm.stream(ctx.llm.reasoningBackend, {
    purpose: "report.backtest",
    system: "You write the backtest section of a launch report. Use only the provided numbers. Lead with misses as prominently as hits. Markdown, under 250 words, no top-level heading.",
    prompt: JSON.stringify({ result, actualNotes: bt.actual.notes, actualSource: bt.actual.source }),
    maxTokens: 3000,
    mock,
  }))
    bus.emit({ type: "report.delta", id: section.id, text: chunk });
  bus.emit({ type: "report.section.done", id: section.id });
  bus.emit({ type: "stage", stage: "backtest", status: "done", detail: `MAPE ${(err * 100).toFixed(1)}%` });
  return result;
}

// ── Stretch: swarm forecasting on resolved prediction markets ────────────────

const ForecastSchema = z.object({ probability: z.number().describe("0-1 probability the question resolves YES"), reasoning: z.string() });

const FORECASTERS = [
  "a cautious macro economist who anchors on base rates",
  "a retail trader who follows news momentum",
  "a contrarian who distrusts consensus",
  "a policy analyst focused on official statements",
  "a quantitative forecaster who reasons from historical frequencies",
  "a tech industry insider",
  "a journalist who reads every headline",
  "a skeptical small-business owner",
];

export interface MarketCase {
  signal: MarketSignal & { outcome: 0 | 1 };
  cutoff: string;
  /** Pre-cutoff context (headlines etc.); never includes the outcome. */
  context: string[];
}

export async function runMarketBacktest(bus: EventBus, llm: LlmRouter, cases: MarketCase[], panelSize = 16): Promise<MarketBacktestRow[]> {
  bus.emit({ type: "stage", stage: "backtest", status: "running", detail: `${cases.length} resolved questions × ${panelSize} forecasters` });
  const run = limiter(6);
  const rows: MarketBacktestRow[] = [];
  for (const c of cases) {
    const panel = Array.from({ length: panelSize }, (_, i) => ({ id: i, persona: FORECASTERS[i % FORECASTERS.length], backend: llm.swarmBackends[i % llm.swarmBackends.length].backend }));
    const probs = await Promise.all(
      panel.map((f) =>
        run(async () => {
          const rng = new Rng(`mkt:${c.signal.id}:${f.id}`);
          const { value } = await llm.json(f.backend, {
            purpose: "market.forecast",
            system: `You are ${f.persona}. Today is ${c.cutoff.slice(0, 10)}. You know nothing after this date. Estimate the probability the question resolves YES.`,
            prompt: `Question: ${c.signal.question}\n\nContext available on ${c.cutoff.slice(0, 10)}:\n${c.context.map((x) => `- ${x}`).join("\n") || "- (no additional context)"}`,
            schema: ForecastSchema,
            maxTokens: 800,
            // Offline: shrink the cutoff market price toward 50% with persona noise. Never sees the outcome.
            mock: () => ({ probability: Math.min(0.98, Math.max(0.02, 0.5 + (c.signal.probability - 0.5) * rng.range(0.6, 1.1) + rng.normal(0, 0.08))), reasoning: "offline estimate" }),
          });
          return Math.min(1, Math.max(0, value.probability));
        }),
      ),
    );
    const sorted = probs.sort((a, b) => a - b);
    const trim = Math.floor(sorted.length * 0.1);
    const kept = sorted.slice(trim, sorted.length - trim);
    const swarm = kept.reduce((a, b) => a + b, 0) / kept.length;
    const row: MarketBacktestRow = {
      signalId: c.signal.id,
      question: c.signal.question,
      cutoff: c.cutoff,
      swarmProbability: swarm,
      marketProbability: c.signal.probability,
      outcome: c.signal.outcome,
      swarmBrier: brier(swarm, c.signal.outcome),
      marketBrier: brier(c.signal.probability, c.signal.outcome),
    };
    rows.push(row);
    bus.emit({ type: "market_backtest.row", row });
  }
  const sb = rows.reduce((a, r) => a + r.swarmBrier, 0) / rows.length;
  const mb = rows.reduce((a, r) => a + r.marketBrier, 0) / rows.length;
  bus.emit({ type: "stage", stage: "backtest", status: "done", detail: `Brier swarm ${sb.toFixed(3)} vs market ${mb.toFixed(3)}` });
  return rows;
}
