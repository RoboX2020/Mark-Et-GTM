import { computeFinance, fitBass } from "@market/core";
import { computeAnalytics, type Analytics } from "../analytics.js";
import { lastDecision, type RunContext } from "../context.js";

export async function fitAdoption(ctx: RunContext): Promise<void> {
  const { bus } = ctx;
  bus.emit({ type: "stage", stage: "bass", status: "running", detail: `fitting ${ctx.adoption.length} simulated months` });
  const n = ctx.personas.length;
  const considering = ctx.personas.filter((p) => lastDecision(ctx, p.id)?.state === "considering").length;
  const adopted = ctx.personas.filter((p) => lastDecision(ctx, p.id)?.state === "adopted").length;
  // Prior on eventual adoption: current adopters plus a share of fence-sitters
  // and of everyone not yet reached. Short horizons identify m poorly.
  const unreached = ctx.personas.filter((p) => !lastDecision(ctx, p.id)).length;
  const mPrior = (adopted + 0.45 * considering + 0.08 * unreached) / n;
  ctx.bass = fitBass(ctx.adoption, { horizon: 12, mPrior, priorWeight: 0.08 });
  bus.emit({ type: "bass.fit", fit: ctx.bass });
  bus.emit({ type: "stage", stage: "bass", status: "done", detail: `peak month ${ctx.bass.peakMonth.toFixed(1)}, m=${(ctx.bass.m * 100).toFixed(1)}%` });
}

export async function forecastFinance(ctx: RunContext): Promise<Analytics> {
  const { bus } = ctx;
  bus.emit({ type: "stage", stage: "finance", status: "running", detail: "finance agent building 12-month forecast" });
  const analytics = computeAnalytics(ctx);
  const adopters = ctx.personas.filter((p) => lastDecision(ctx, p.id)?.state === "adopted").map((p) => p.id);
  const wtp = ctx.interviews.length >= 5 ? ctx.interviews.map((i) => ({ agentId: i.agentId, wtp: i.wtp })) : adopters.map((id) => ({ agentId: id, wtp: lastDecision(ctx, id)!.wtp }));
  ctx.finance = computeFinance({
    brief: ctx.brief,
    bass: ctx.bass!,
    wtp,
    attribution: analytics.channels.map((c) => ({ channel: c.channel, adopterIds: c.adopterIds, evidenceIds: c.evidenceIds })),
    adoptionAgentIds: adopters,
    adoptionEvidenceIds: ctx.nodes.filter((n) => n.kind === "segment").flatMap((n) => n.evidenceIds).slice(0, 20),
  });
  bus.emit({ type: "finance.computed", finance: ctx.finance });
  const flagged = ctx.finance.items.filter((i) => i.provenance.needsReview).length + ctx.finance.channels.filter((c) => c.provenance.needsReview).length;
  bus.emit({
    type: "stage",
    stage: "finance",
    status: "done",
    detail: `break-even ${ctx.finance.breakEvenMonth ? `month ${ctx.finance.breakEvenMonth}` : "beyond 12 months"} · ${flagged} figures flagged for review`,
  });
  return analytics;
}
