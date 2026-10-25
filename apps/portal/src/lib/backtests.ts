import { useEffect, useState } from "react";
import { foldAll } from "@market/core";
import { fetchRun, fetchRuns } from "./player";
import { OUTCOMES, type Outcome } from "./outcomes";
import { observedAdoption, profit12, reportHeadline } from "./verdict";

export interface CaseSummary {
  outcome: Outcome;
  label: string;
  predicted: { month: number; cumulative: number }[];
  actual: { month: number; cumulative: number }[];
  mape: number | null;
  simAdoption: number;
  simMonth: number;
  revenue12: number | null;
  profit12: number | null;
  breakEven: number | null;
  reportHeadline: string | null;
}

let cache: Promise<CaseSummary[]> | null = null;

async function load(): Promise<CaseSummary[]> {
  const runs = await fetchRuns();
  const out: CaseSummary[] = [];
  for (const outcome of OUTCOMES) {
    const entry = runs.find((r) => r.kind === "backtest" && r.id === `backtest_${outcome.caseId}`);
    if (!entry) continue;
    const s = foldAll(await fetchRun(entry));
    const obs = observedAdoption(s);
    out.push({
      outcome,
      label: entry.label,
      predicted: s.backtest?.predicted ?? s.bass?.curve ?? [],
      actual: s.backtest?.actual ?? [],
      mape: s.backtest?.mape ?? null,
      simAdoption: obs.share,
      simMonth: obs.month,
      revenue12: s.finance?.totalRevenue12 ?? null,
      profit12: profit12(s),
      breakEven: s.finance?.breakEvenMonth ?? null,
      reportHeadline: reportHeadline(s),
    });
  }
  return out;
}

/** The recorded Humane, Ray-Ban Meta and Rabbit backtests, folded once per page load. */
export function useCaseSummaries(): { cases: CaseSummary[]; loading: boolean } {
  const [cases, setCases] = useState<CaseSummary[] | null>(null);
  useEffect(() => {
    let live = true;
    cache ??= load().catch(() => {
      cache = null;
      return [];
    });
    void cache.then((c) => live && setCases(c));
    return () => {
      live = false;
    };
  }, []);
  return { cases: cases ?? [], loading: cases === null };
}
