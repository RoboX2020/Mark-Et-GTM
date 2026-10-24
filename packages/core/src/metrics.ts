// Scoring helpers for backtests.

export function mape(pred: { month: number; cumulative: number }[], actual: { month: number; cumulative: number }[]): number {
  const errs: number[] = [];
  for (const a of actual) {
    if (a.cumulative <= 0) continue;
    const p = interpolate(pred, a.month);
    errs.push(Math.abs(p - a.cumulative) / a.cumulative);
  }
  return errs.length ? errs.reduce((x, y) => x + y, 0) / errs.length : 0;
}

export function interpolate(curve: { month: number; cumulative: number }[], month: number): number {
  if (!curve.length) return 0;
  const sorted = [...curve].sort((a, b) => a.month - b.month);
  if (month <= sorted[0].month) return sorted[0].cumulative;
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1];
    const b = sorted[i];
    if (month <= b.month) return a.cumulative + ((b.cumulative - a.cumulative) * (month - a.month)) / (b.month - a.month || 1);
  }
  return sorted[sorted.length - 1].cumulative;
}

export function brier(p: number, outcome: 0 | 1): number {
  return (p - outcome) ** 2;
}

export function logLoss(p: number, outcome: 0 | 1): number {
  const c = Math.min(1 - 1e-6, Math.max(1e-6, p));
  return -(outcome * Math.log(c) + (1 - outcome) * Math.log(1 - c));
}

const STOP = new Set("the a an and or of to is it for in on with too not no very i my me this that be are was".split(" "));

export function tokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w)),
  );
}

/** Soft overlap between two lists of short phrases (best Jaccard match per item). */
export function phraseOverlap(predicted: string[], actual: string[]): { score: number; matched: [string, string][] } {
  if (!actual.length) return { score: 0, matched: [] };
  const matched: [string, string][] = [];
  let total = 0;
  for (const a of actual) {
    const ta = tokens(a);
    let best = 0;
    let bestP = "";
    for (const p of predicted) {
      const tp = tokens(p);
      const inter = [...ta].filter((w) => tp.has(w)).length;
      const j = inter / (new Set([...ta, ...tp]).size || 1);
      if (j > best) {
        best = j;
        bestP = p;
      }
    }
    if (best >= 0.2) matched.push([a, bestP]);
    total += Math.min(1, best * 2.5);
  }
  return { score: total / actual.length, matched };
}
