import type { AdoptionState, RunState } from "@market/core";

export type Mood = "adopt" | "wait" | "reject" | "none";

export function moodOf(s: AdoptionState | undefined): Mood {
  return s === "adopted" ? "adopt" : s === "considering" ? "wait" : s === "rejected" ? "reject" : "none";
}

export interface Counts {
  adopt: number;
  wait: number;
  reject: number;
  other: number;
  total: number;
}

export function countMoods(state: RunState, segmentId?: string): Counts {
  const c: Counts = { adopt: 0, wait: 0, reject: 0, other: 0, total: 0 };
  for (const p of state.personas.values()) {
    if (segmentId && p.segmentId !== segmentId) continue;
    c.total++;
    const m = moodOf(state.agentState.get(p.id)?.state);
    if (m === "none") c.other++;
    else c[m]++;
  }
  return c;
}

function normaliseObjection(s: string): string {
  return s.trim().replace(/[.!]+$/, "");
}

/** Most frequent objection among agents' latest decisions. */
export function topObjection(state: RunState, segmentId?: string): { text: string; count: number } | null {
  const counts = new Map<string, { text: string; count: number }>();
  for (const d of state.agentState.values()) {
    if (!d.objection || d.state === "adopted") continue;
    if (segmentId && state.personas.get(d.agentId)?.segmentId !== segmentId) continue;
    const text = normaliseObjection(d.objection);
    const k = text.toLowerCase();
    const cur = counts.get(k) ?? { text, count: 0 };
    cur.count++;
    counts.set(k, cur);
  }
  let best: { text: string; count: number } | null = null;
  for (const v of counts.values()) if (!best || v.count > best.count) best = v;
  return best;
}

export type Tone = "pos" | "warn" | "neg";

export interface Verdict {
  headline: string;
  tone: Tone;
  detail: string;
  /** Share of residents who adopted by the last simulated month. */
  observed: number;
  month: number;
  breakEven: number | null;
  profit12: number | null;
  /** The engine report's own one-line answer, when it wrote one. */
  report: string | null;
}

export function profit12(state: RunState): number | null {
  return state.finance ? state.finance.months.reduce((a, m) => a + m.net, 0) : null;
}

export function observedAdoption(state: RunState): { share: number; month: number } {
  const last = state.adoption.at(-1);
  if (last) return { share: last.cumulative, month: last.month };
  const pop = state.personas.size;
  return { share: pop ? countMoods(state).adopt / pop : 0, month: 0 };
}

export function reportHeadline(state: RunState): string | null {
  const text = state.report.get("verdict")?.text ?? "";
  const bold = /\*\*(.+?)\*\*/.exec(text)?.[1];
  return bold ? bold.trim() : null;
}

/**
 * Judges the launch on what the simulation actually observed (who adopted by
 * the last round) and whether the money comes back, not on the Bass ceiling
 * `m`, which a strong prior can inflate well above anything residents did.
 */
export function verdictOf(state: RunState): Verdict | null {
  if (!state.bass && !state.finance) return null;
  const { share, month } = observedAdoption(state);
  const fin = state.finance;
  const profit = profit12(state);
  const be = fin?.breakEvenMonth ?? null;
  let headline: string;
  let tone: Tone;
  if (fin && be === null) {
    headline = share < 0.1 ? "Flop: few buy, money never comes back" : "Fails to pay back";
    tone = "neg";
  } else if (profit !== null && profit < 0) {
    headline = "Loses money in year one";
    tone = "neg";
  } else if (fin && profit !== null && profit < fin.totalRevenue12 * 0.02) {
    headline = "Early sales, barely profitable";
    tone = "warn";
  } else if (share >= 0.2) {
    headline = "Strong launch";
    tone = "pos";
  } else if (share >= 0.1) {
    headline = "Moderate launch";
    tone = "warn";
  } else {
    headline = "Weak launch";
    tone = "neg";
  }
  const money = (n: number) => `${n < 0 ? "−" : ""}$${compact(Math.abs(n))}`;
  const parts = [`${Math.round(share * 100)}% adopted by month ${month || "—"}`];
  if (fin) parts.push(be ? `pays back in month ${be}` : "no payback in 12 months");
  if (profit !== null) parts.push(`12-month profit ${money(profit)}`);
  return { headline, tone, detail: parts.join(" · "), observed: share, month, breakEven: be, profit12: profit, report: reportHeadline(state) };
}

export function compact(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(a >= 1e10 ? 0 : 2)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(a >= 1e8 ? 0 : 1)}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(a >= 1e5 ? 0 : 1)}k`;
  return `${Math.round(n)}`;
}

export interface SegmentStat {
  id: string;
  label: string;
  counts: Counts;
  /** Adopters gained in the latest round. */
  fresh: number;
  objection: string | null;
}

export function segmentStats(state: RunState, ids: { id: string; label: string }[]): SegmentStat[] {
  const round = state.currentRound;
  const fresh = new Map<string, number>();
  for (const [agentId, history] of state.decisions) {
    const d = history.find((h) => h.round === round);
    if (!d || d.state !== "adopted" || d.previous === "adopted") continue;
    const seg = state.personas.get(agentId)?.segmentId;
    if (seg) fresh.set(seg, (fresh.get(seg) ?? 0) + 1);
  }
  return ids.map((s) => ({ id: s.id, label: s.label, counts: countMoods(state, s.id), fresh: fresh.get(s.id) ?? 0, objection: topObjection(state, s.id)?.text ?? null }));
}

/** One plain-language caption for what is happening in the town right now. */
export function narrate(state: RunState, stats: SegmentStat[]): { title: string; body: string } {
  const total = state.brief?.rounds ?? 6;
  const mpr = state.brief?.monthsPerRound ?? 1;
  if (state.status === "ok") {
    const v = verdictOf(state);
    return { title: v ? v.headline : "Run complete", body: v ? v.detail : "" };
  }
  if (state.currentRound === 0) {
    if (!state.personas.size) return { title: "Reading the market", body: "Collecting what real people said about products like this before launch." };
    return { title: "Residents moving in", body: `${state.personas.size} simulated customers, grouped into ${stats.length} neighbourhoods by who they are. Each colour is one customer group.` };
  }
  const r = Math.min(state.currentRound, total);
  if (state.rounds.length >= total) return { title: "Writing the report", body: "The rounds are done. The engine is fitting the curve and checking the money." };
  const fresh = stats.reduce((a, s) => a + s.fresh, 0);
  const ranked = [...stats].filter((s) => s.counts.total).sort((a, b) => b.counts.adopt / b.counts.total - a.counts.adopt / a.counts.total);
  const lead = ranked[0];
  const lag = [...ranked].reverse().find((s) => s.counts.reject + s.counts.wait > 0 && s !== lead) ?? ranked.at(-1);
  const bits: string[] = [];
  bits.push(fresh ? `${fresh} new ${fresh === 1 ? "buyer" : "buyers"} this round.` : "No new buyers this round.");
  if (lead && lead.counts.adopt) bits.push(`Most buying: ${lead.label} (${lead.counts.adopt} of ${lead.counts.total}).`);
  if (lag && lag !== lead) bits.push(`Least convinced: ${lag.label}${lag.objection ? `, saying “${lag.objection}”` : "."}`);
  return { title: `Month ${r * mpr} · round ${r} of ${total}`, body: bits.join(" ") };
}
