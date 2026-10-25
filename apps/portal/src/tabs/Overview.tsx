import { useMemo } from "react";
import { useDateFilter, useNav, useRun } from "../lib/context";
import { int, money, pct, STATE_LABEL } from "../lib/format";
import { LineChart } from "../components/Charts";
import type { AdoptionState } from "@market/core";
import { OutcomeCard, Versus } from "../components/Outcome";
import { outcomeFor } from "../lib/outcomes";
import { verdictOf } from "../lib/verdict";

export function Overview() {
  const { state } = useRun();
  const date = useDateFilter();
  const nav = useNav();
  const b = state.brief;
  const counts = useMemo(() => {
    const c: Record<AdoptionState, number> = { unaware: 0, aware: 0, considering: 0, adopted: 0, rejected: 0 };
    for (const d of state.agentState.values()) c[d.state]++;
    return c;
  }, [state.eventCount]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!b) return <div className="empty"><h3>No run loaded</h3>Pick a recorded run above or connect to SpacetimeDB.</div>;
  const n = state.personas.size;
  const fin = state.finance;
  const bass = state.bass;
  const segments = [...state.nodes.values()].filter((x) => x.kind === "segment");
  const synthetic = state.evidence.filter((e) => e.synthetic).length;
  const verdict = state.status === "ok" ? verdictOf(state) : null;
  const outcome = state.backtestCaseId ? outcomeFor(state.backtestCaseId, state.backtest?.realName) : undefined;

  return (
    <div className="stack">
      <div className="hero">
        <div>
          <div className="eyebrow">{state.backtestCaseId ? "Backtest" : "Launch simulation"} · {state.mode} mode</div>
          <h1 style={{ marginTop: 6 }}>{state.backtest?.realName ?? b.product.name}</h1>
          <p>{b.product.description}</p>
          {state.backtest && (
            <p className="muted" style={{ fontSize: 14 }}>
              The model only knew this as {state.backtest.alias}. Every post it saw is dated on or before {state.backtest.cutoff.slice(0, 10)}.
            </p>
          )}
          <div className="row wrap" style={{ marginTop: 10 }}>
            <span className="chip">{money(b.price.amount, b)} · {b.price.model.replaceAll("_", " ")}</span>
            <span className="chip">{b.targetMarket}</span>
            <span className="chip">launch {b.launchDate}</span>
            {date.cutoff && <span className="chip mono">data through {date.through || date.cutoff}</span>}
            {b.channels.map((c) => (
              <span key={c} className="chip mono">{c.replaceAll("_", " ")}</span>
            ))}
          </div>
        </div>
      </div>

      {synthetic > 0 && (
        <div className="callout warn">
          {synthetic} of {state.evidence.length} posts in this run are offline fixtures, not scraped data. Add API keys and run in live mode for a real market read.
        </div>
      )}

      {verdict && (
        <div className={`card verdict-strip ${verdict.tone}`}>
          <div>
            <span className="eyebrow">Simulation verdict</span>
            <h2>{verdict.headline}</h2>
            <div className="muted" style={{ fontSize: 13 }}>{verdict.detail}</div>
          </div>
          {verdict.report && <blockquote>“{verdict.report}”<span className="muted"> engine report</span></blockquote>}
        </div>
      )}

      {outcome && verdict && (
        <div className="grid g2">
          <OutcomeCard outcome={outcome} />
          <Versus verdict={verdict} outcome={outcome} />
        </div>
      )}

      <div className="grid g6">
        <Metric k="Agents" v={int(n)} s={`${segments.length} segments`} />
        <Metric k="Adopted" v={n ? pct(counts.adopted / n, 1) : "—"} s={`${counts.considering} considering`} live={state.status === "running" && state.currentRound > 0} />
        <Metric k="Forecast ceiling m" v={bass ? pct(bass.m, 1) : "—"} s={bass ? `Bass upper bound · q ${bass.q.toFixed(2)}` : "after simulation"} />
        <Metric k="Peak month" v={bass ? bass.peakMonth.toFixed(1) : "—"} s="new sign-ups" />
        <Metric k="12-mo revenue" v={fin ? money(fin.totalRevenue12, b, true) : "—"} s={fin ? `profit ${money(verdict?.profit12 ?? fin.months.reduce((a, m) => a + m.net, 0), b, true)}` : "finance agent"} tone={fin ? (fin.months.reduce((a, m) => a + m.net, 0) < 0 ? "neg" : "pos") : undefined} />
        <Metric k="Break-even" v={fin ? (fin.breakEvenMonth ? `M${fin.breakEvenMonth}` : "Never") : "—"} s={fin ? (fin.breakEvenMonth ? `low cash ${money(fin.minCash, b, true)}` : "not within 12 months") : ""} tone={fin ? (fin.breakEvenMonth ? "pos" : "neg") : undefined} />
      </div>

      <div className="grid g2">
        <div className="card">
          <div className="card-head">
            <h3>Adoption curve</h3>
            <span className="muted" style={{ fontSize: 12 }}>
              simulated rounds · Bass fit to month 12
            </span>
          </div>
          <div className="card-pad">
            <LineChart
              yFloor={0.05}
              xMax={12}
              yFmt={(v) => pct(v)}
              markerX={state.adoption.length ? state.adoption[state.adoption.length - 1].month : undefined}
              series={[
                ...(bass ? [{ points: bass.curve.map((c) => ({ x: c.month, y: c.cumulative })), kind: "curve" as const, area: true }] : []),
                { points: [{ x: 0, y: 0 }, ...state.adoption.map((a) => ({ x: a.month, y: a.cumulative }))], kind: bass ? ("alt" as const) : ("curve" as const), dots: true },
              ]}
            />
          </div>
        </div>
        <div className="card">
          <div className="card-head">
            <h3>Population</h3>
            <span className="muted mono" style={{ fontSize: 12 }}>
              round {state.currentRound || "—"}
            </span>
          </div>
          <div className="card-pad">
            <Mosaic onPick={(id) => nav.openAgent(id)} />
            <div className="legend" style={{ marginTop: 14 }}>
              {(["unaware", "aware", "considering", "adopted", "rejected"] as AdoptionState[]).map((s) => (
                <span key={s}>
                  <i className={`cell ${s}`} style={{ width: 9, height: 9 }} /> {STATE_LABEL[s]} <span className="mono">{counts[s]}</span>
                </span>
              ))}
              <span>
                <i className="cell thinking" style={{ width: 9, height: 9 }} /> thinking
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Segments</h3>
          <span className="muted" style={{ fontSize: 12 }}>
            from the knowledge graph
          </span>
        </div>
        <div className="card-pad" style={{ paddingTop: 8 }}>
          <SegmentTable />
        </div>
      </div>
    </div>
  );
}

function Metric({ k, v, s, live, tone }: { k: string; v: string; s?: string; live?: boolean; tone?: "pos" | "neg" | "warn" }) {
  return (
    <div className={`card metric ${tone ?? ""}`}>
      <div className="row between">
        <span className="eyebrow">{k}</span>
        {live && <span className="dot live" />}
      </div>
      <div className="v">{v}</div>
      {s && <div className="s">{s}</div>}
    </div>
  );
}

function Mosaic({ onPick }: { onPick: (id: string) => void }) {
  const { state } = useRun();
  const personas = [...state.personas.values()].sort((a, b) => a.segmentId.localeCompare(b.segmentId));
  return (
    <div className="mosaic">
      {personas.map((p) => {
        const st = state.agentState.get(p.id)?.state ?? "unaware";
        const thinking = state.thinking.has(p.id);
        return <div key={p.id} className={`cell ${thinking ? "thinking" : st}`} title={`${p.name} — ${st}`} onClick={() => onPick(p.id)} />;
      })}
    </div>
  );
}

export function SegmentTable() {
  const { state } = useRun();
  const segs = [...state.nodes.values()].filter((x) => x.kind === "segment");
  const rows = segs.map((s) => {
    const members = [...state.personas.values()].filter((p) => p.segmentId === s.id);
    const ds = members.map((p) => state.agentState.get(p.id)!).filter(Boolean);
    const adopted = ds.filter((d) => d.state === "adopted").length;
    const sent = ds.filter((d) => d.state !== "unaware");
    return { s, n: members.length, adopted, rate: members.length ? adopted / members.length : 0, sentiment: sent.length ? sent.reduce((a, d) => a + d.sentiment, 0) / sent.length : 0 };
  });
  rows.sort((a, b) => b.rate - a.rate);
  return (
    <table className="t">
      <thead>
        <tr>
          <th>Segment</th>
          <th className="n">Share</th>
          <th className="n">Agents</th>
          <th style={{ width: "28%" }}>Adoption</th>
          <th className="n">Sentiment</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.s.id}>
            <td>
              <div>{r.s.label}</div>
              {r.s.summary && <div className="muted" style={{ fontSize: 12 }}>{r.s.summary}</div>}
            </td>
            <td className="n">{pct(r.s.weight)}</td>
            <td className="n">{r.n}</td>
            <td>
              <div className="row">
                <div className="bar" style={{ flex: 1 }}>
                  <i style={{ width: pct(r.rate, 1), background: "var(--pos)" }} />
                </div>
                <span className="mono" style={{ fontSize: 12, width: 44, textAlign: "right" }}>{pct(r.rate)}</span>
              </div>
            </td>
            <td className="n">{r.sentiment.toFixed(2)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
