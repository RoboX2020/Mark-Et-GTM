import type { AdoptionPoint, BassFit } from "./domain.js";

/** Cumulative Bass adoption fraction F(t) for innovation p and imitation q. */
export function bassF(t: number, p: number, q: number): number {
  if (t <= 0) return 0;
  const e = Math.exp(-(p + q) * t);
  return (1 - e) / (1 + (q / p) * e);
}

export function bassPeak(p: number, q: number): number {
  return q > p ? Math.log(q / p) / (p + q) : 0;
}

/** Minimal Nelder–Mead; enough for a 3-parameter least-squares fit. */
export function nelderMead(f: (x: number[]) => number, x0: number[], step = 0.5, iters = 600): number[] {
  const n = x0.length;
  let simplex: { x: number[]; v: number }[] = [{ x: x0, v: f(x0) }];
  for (let i = 0; i < n; i++) {
    const x = [...x0];
    x[i] += step;
    simplex.push({ x, v: f(x) });
  }
  for (let k = 0; k < iters; k++) {
    simplex.sort((a, b) => a.v - b.v);
    const best = simplex[0];
    const worst = simplex[n];
    if (Math.abs(worst.v - best.v) < 1e-12) break;
    const centroid = Array.from({ length: n }, (_, j) => simplex.slice(0, n).reduce((a, s) => a + s.x[j], 0) / n);
    const at = (t: number) => centroid.map((c, j) => c + t * (worst.x[j] - c));
    const xr = at(-1);
    const vr = f(xr);
    if (vr < best.v) {
      const xe = at(-2);
      const ve = f(xe);
      simplex[n] = ve < vr ? { x: xe, v: ve } : { x: xr, v: vr };
    } else if (vr < simplex[n - 1].v) {
      simplex[n] = { x: xr, v: vr };
    } else {
      const xc = at(0.5);
      const vc = f(xc);
      if (vc < worst.v) simplex[n] = { x: xc, v: vc };
      else
        simplex = simplex.map((s, i) =>
          i === 0 ? s : { x: s.x.map((v, j) => best.x[j] + 0.5 * (v - best.x[j])), v: f(s.x.map((v, j) => best.x[j] + 0.5 * (v - best.x[j]))) },
        );
    }
  }
  simplex.sort((a, b) => a.v - b.v);
  return simplex[0].x;
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));
const logit = (x: number) => Math.log(x / (1 - x));

export interface BassFitOptions {
  horizon?: number;
  /** Prior on eventual adoption m (e.g. adopted + intent-weighted considering). */
  mPrior?: number;
  /** Strength of the prior; short simulations identify m poorly, so default is moderate. */
  priorWeight?: number;
}

/**
 * Fits p, q, m to observed cumulative adoption (fractions of the simulated
 * population). Parameters are optimised in unconstrained space: log p, log q,
 * logit m. With only a few observed months m is weakly identified, so an
 * optional prior keeps it near the population's stated intent.
 */
export function fitBass(observed: AdoptionPoint[], opts: BassFitOptions = {}): BassFit {
  const horizon = opts.horizon ?? 12;
  const pts = observed.filter((o) => o.month > 0);
  const last = pts.length ? pts[pts.length - 1].cumulative : 0;
  const mPrior = Math.min(0.99, Math.max(opts.mPrior ?? Math.max(last * 2, 0.05), last + 1e-3));
  const w = opts.priorWeight ?? 0.05;

  const loss = (x: number[]) => {
    const p = Math.exp(x[0]);
    const q = Math.exp(x[1]);
    const m = sigmoid(x[2]);
    if (p > 0.3 || q > 1.5 || p < 1e-5) return 1e6;
    let sse = 0;
    for (const o of pts) {
      const r = m * bassF(o.month, p, q) - o.cumulative;
      sse += r * r;
    }
    const prior = w * (m - mPrior) ** 2;
    const floor = m < last ? 10 * (last - m) ** 2 : 0;
    return sse + prior + floor;
  };

  let best: number[] = [Math.log(0.01), Math.log(0.3), logit(mPrior)];
  let bestV = loss(best);
  // Multi-start: diffusion surfaces have long flat valleys.
  for (const p0 of [0.002, 0.01, 0.03, 0.08]) {
    for (const q0 of [0.1, 0.35, 0.8]) {
      const x = nelderMead(loss, [Math.log(p0), Math.log(q0), logit(mPrior)], 0.6, 500);
      const v = loss(x);
      if (v < bestV) {
        best = x;
        bestV = v;
      }
    }
  }
  const p = Math.exp(best[0]);
  const q = Math.exp(best[1]);
  const m = sigmoid(best[2]);
  let sse = 0;
  for (const o of pts) sse += (m * bassF(o.month, p, q) - o.cumulative) ** 2;
  const curve = Array.from({ length: horizon + 1 }, (_, month) => ({ month, cumulative: m * bassF(month, p, q) }));
  return {
    p,
    q,
    m,
    rmse: pts.length ? Math.sqrt(sse / pts.length) : 0,
    observed,
    curve,
    peakMonth: bassPeak(p, q),
  };
}
