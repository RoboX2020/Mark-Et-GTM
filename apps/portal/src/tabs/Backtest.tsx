import { useDateFilter, useRun } from "../lib/context";
import { pct } from "../lib/format";
import { LineChart, niceMax } from "../components/Charts";
import { BarGroup } from "../components/Bars";
import { OutcomeCard, Versus } from "../components/Outcome";
import { CASE_COLOR, outcomeFor } from "../lib/outcomes";
import { useCaseSummaries } from "../lib/backtests";
import { compact, verdictOf } from "../lib/verdict";

const usd = (n: number) => `${n < 0 ? "−" : ""}$${compact(Math.abs(n))}`;

export function Backtest() {
  const { state } = useRun();
  const date = useDateFilter();
  const bt = state.backtest;
  const mk = state.marketBacktest;
  const outcome = bt ? outcomeFor(bt.caseId, bt.realName) : undefined;
  const verdict = verdictOf(state);

  if (!bt && !mk.length)
    return (
      <div className="stack">
        <div className="empty">
          <h3>No backtest in this run</h3>
          Run <span className="mono">pnpm backtest &lt;case&gt;</span> to point the simulator at a product that already launched, using only pre-launch data, and compare it with
          what actually happened. Or run <span className="mono">pnpm --filter @market/engine backtest-markets</span> to score the swarm on resolved prediction markets.
        </div>
        <CrossCase />
      </div>
    );

  const btX = bt ? Math.max(12, ...bt.actual.map((p) => p.month)) : 12;
  const shared = bt ? niceMax(Math.max(0.02, ...bt.predicted.map((p) => p.cumulative), ...bt.actual.map((p) => p.cumulative)) * 1.08) : 1;

  return (
    <div className="stack">
      {bt && (
        <>
          <div className="row between wrap">
            <div>
              <span className="eyebrow">Backtest · data cutoff {bt.cutoff.slice(0, 10)}{date.through && date.through !== bt.cutoff.slice(0, 10) ? ` · evidence filter ${date.through}` : ""}</span>
              <h2 style={{ marginTop: 4 }}>
                {bt.alias} <span className="muted" style={{ fontSize: 16 }}>revealed as</span> {bt.realName}
              </h2>
            </div>
            <div className="row wrap">
              <span className={`chip ${bt.mape < 0.3 ? "pos" : bt.mape < 0.6 ? "warn" : "neg"}`}>MAPE {pct(bt.mape, 1)}</span>
              <span className="chip">complaint overlap {pct(bt.objectionOverlap)}</span>
              <span className={`chip ${bt.priceMatch ? "pos" : "neg"}`}>price {bt.priceMatch ? "matched" : "missed"}</span>
            </div>
          </div>
          {bt.leakageWarnings.length > 0 && (
            <div className="callout warn">
              <strong>Leakage warnings.</strong> {bt.leakageWarnings.join(" ")}
            </div>
          )}
          {outcome && (
            <div className="grid g2">
              <OutcomeCard outcome={outcome} />
              {verdict && (
                <div className="stack">
                  <Versus verdict={verdict} outcome={outcome} />
                  {verdict.report && (
                    <div className="callout">
                      <span className="eyebrow">Engine report verdict</span>
                      <div style={{ marginTop: 4, fontWeight: 600 }}>{verdict.report}</div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          <div className="grid g2">
            <div className="card">
              <div className="card-head">
                <h3>Predicted</h3>
                <span className="muted" style={{ fontSize: 12 }}>Bass curve from pre-launch data only</span>
              </div>
              <div className="card-pad">
                <LineChart yMax={shared} xMax={btX} yFmt={(v) => pct(v, 1)} series={[{ points: bt.predicted.map((p) => ({ x: p.month, y: p.cumulative })), kind: "curve", area: true }]} />
              </div>
            </div>
            <div className="card">
              <div className="card-head">
                <h3>What actually happened</h3>
                <span className="muted" style={{ fontSize: 12 }}>black: reported · dashed: prediction · same scale</span>
              </div>
              <div className="card-pad">
                <LineChart
                  yMax={shared}
                  xMax={btX}
                  yFmt={(v) => pct(v, 1)}
                  series={[
                    { points: bt.predicted.map((p) => ({ x: p.month, y: p.cumulative })), kind: "alt" },
                    { points: [{ x: 0, y: 0 }, ...bt.actual.map((p) => ({ x: p.month, y: p.cumulative }))], kind: "actual", dots: true },
                  ]}
                />
              </div>
            </div>
          </div>
          <div className="grid g2">
            <div className="card card-pad">
              <h3>Where it was right</h3>
              <ul style={{ paddingLeft: 18, marginBottom: 0 }}>
                {bt.hits.map((h, i) => <li key={i} style={{ margin: "6px 0" }}>{h}</li>)}
                {!bt.hits.length && <li className="muted">Nothing landed within tolerance.</li>}
              </ul>
            </div>
            <div className="card card-pad">
              <h3>Where it missed</h3>
              <ul style={{ paddingLeft: 18, marginBottom: 0 }}>
                {bt.misses.map((h, i) => <li key={i} style={{ margin: "6px 0" }}>{h}</li>)}
                {!bt.misses.length && <li className="muted">No misses recorded.</li>}
              </ul>
            </div>
          </div>
        </>
      )}

      <CrossCase current={bt?.caseId} />

      {mk.length > 0 && <MarketTable />}
    </div>
  );
}

/** Humane, Rabbit and Ray-Ban Meta on shared axes, so the gaps between them are real gaps. */
function CrossCase({ current }: { current?: string }) {
  const { cases, loading } = useCaseSummaries();
  if (loading) return <div className="card card-pad muted">Loading the three recorded backtests…</div>;
  if (!cases.length) return null;
  const xMax = Math.max(12, ...cases.flatMap((c) => c.actual.map((p) => p.month)));
  const within = (pts: { month: number; cumulative: number }[]) => pts.filter((p) => p.month <= xMax);
  const top = Math.max(0.05, ...cases.flatMap((c) => [...within(c.predicted), ...within(c.actual)].map((p) => p.cumulative), ...cases.map((c) => c.simAdoption)));
  const yMax = Math.min(1, Math.ceil((top * 1.08) / 0.05) * 0.05);
  const name = (c: (typeof cases)[number]) => c.outcome.realName.replace(" smart glasses", "");
  return (
    <div className="card">
      <div className="card-head">
        <h3>Three real launches, one scale</h3>
        <span className="scale-note">every bar and axis below shares its scale across companies</span>
      </div>
      <div className="card-pad stack">
        <div className="hbar-key">
          {cases.map((c) => (
            <span key={c.outcome.caseId}>
              <i style={{ background: CASE_COLOR[c.outcome.caseId] }} /> {name(c)}
            </span>
          ))}
          <span>
            <i style={{ background: "repeating-linear-gradient(135deg, var(--ink-3) 0 3px, transparent 3px 6px)", outline: "1px solid var(--ink-3)" }} /> hatched: simulation
          </span>
          <span>
            <i style={{ background: "var(--ink-3)" }} /> solid: real world
          </span>
        </div>
        <div className="grid g2">
          <div className="hbars">
            <BarGroup
              title="Units sold, real world"
              fmt={(v) => compact(v)}
              rows={cases.map((c) => ({ label: name(c), value: c.outcome.units, color: CASE_COLOR[c.outcome.caseId] }))}
            />
            <BarGroup
              title="Revenue: simulated first 12 months vs real"
              fmt={usd}
              rows={cases.flatMap((c) => [
                { label: `${name(c)} · sim`, value: c.revenue12, color: CASE_COLOR[c.outcome.caseId], hatch: true },
                { label: `${name(c)} · real`, value: c.outcome.revenue, color: CASE_COLOR[c.outcome.caseId] },
              ])}
            />
            <BarGroup
              title="Simulated 12-month profit"
              fmt={usd}
              rows={cases.map((c) => ({ label: name(c), value: c.profit12, color: CASE_COLOR[c.outcome.caseId], hatch: true, text: c.profit12 === null ? undefined : `${usd(c.profit12)}${c.breakEven ? "" : " · never pays back"}` }))}
            />
          </div>
          <div className="hbars">
            <BarGroup
              title="Share of target market that bought: simulated vs reported"
              fmt={(v) => pct(v)}
              domain={[0, yMax]}
              rows={cases.flatMap((c) => [
                { label: `${name(c)} · sim`, value: c.simAdoption, color: CASE_COLOR[c.outcome.caseId], hatch: true },
                { label: `${name(c)} · real`, value: c.actual.at(-1)?.cumulative ?? null, color: CASE_COLOR[c.outcome.caseId] },
              ])}
            />
            <div className="stack" style={{ fontSize: 12.5 }}>
              {cases.map((c) => (
                <div key={c.outcome.caseId} className="row" style={{ alignItems: "flex-start" }}>
                  <span className={`chip ${c.outcome.verdict === "failed" ? "neg" : c.outcome.verdict === "stalled" ? "warn" : "pos"}`} style={{ minWidth: 64, justifyContent: "center" }}>
                    {c.outcome.verdict}
                  </span>
                  <span>
                    <strong>{name(c)}:</strong> {c.outcome.headline}.{c.reportHeadline ? <span className="muted"> Engine said: “{c.reportHeadline}”</span> : null}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="grid g3">
          {cases.map((c) => (
            <div key={c.outcome.caseId}>
              <div className="row between" style={{ marginBottom: 4 }}>
                <span className="eyebrow" style={{ color: CASE_COLOR[c.outcome.caseId] }}>{name(c)}{c.outcome.caseId === current ? " · this run" : ""}</span>
                {c.mape !== null && <span className="scale-note">MAPE {pct(c.mape)}</span>}
              </div>
              <LineChart
                height={180}
                yMax={yMax}
                xMax={xMax}
                yFmt={(v) => pct(v)}
                series={[
                  { points: within(c.predicted).map((p) => ({ x: p.month, y: p.cumulative })), kind: "alt", color: CASE_COLOR[c.outcome.caseId] },
                  { points: [{ x: 0, y: 0 }, ...c.actual.map((p) => ({ x: p.month, y: p.cumulative }))], kind: "actual", dots: true },
                ]}
              />
            </div>
          ))}
        </div>
        <p className="scale-note" style={{ margin: 0 }}>
          Adoption is the share of each company's stated addressable market. Real revenue for Rabbit and Meta is units × launch price; Humane's is the reported figure. Simulated
          money comes from the finance agent's 12-month plan.
        </p>
      </div>
    </div>
  );
}

function MarketTable() {
  const { state } = useRun();
  const rows = state.marketBacktest;
  const sb = rows.reduce((a, r) => a + r.swarmBrier, 0) / rows.length;
  const mb = rows.reduce((a, r) => a + r.marketBrier, 0) / rows.length;
  return (
    <div className="card">
      <div className="card-head">
        <h3>Swarm vs. prediction markets</h3>
        <div className="row">
          <span className={`chip ${sb <= mb ? "pos" : "neg"}`}>swarm Brier {sb.toFixed(3)}</span>
          <span className="chip">market Brier {mb.toFixed(3)}</span>
        </div>
      </div>
      <div className="card-pad" style={{ paddingTop: 6 }}>
        <p className="muted" style={{ fontSize: 13, marginTop: 4 }}>
          Resolved questions, forecast using only information available at each cutoff. Lower Brier is better; the market price at the cutoff is the bar to beat.
        </p>
        <table className="t">
          <thead>
            <tr><th>Question</th><th>Cutoff</th><th className="n">Swarm</th><th className="n">Market</th><th className="n">Outcome</th><th className="n">Δ Brier</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.signalId}>
                <td>{r.question}</td>
                <td className="mono">{r.cutoff.slice(0, 10)}</td>
                <td className="n">{pct(r.swarmProbability)}</td>
                <td className="n">{pct(r.marketProbability)}</td>
                <td className="n">{r.outcome ? "YES" : "NO"}</td>
                <td className="n" style={{ color: r.swarmBrier <= r.marketBrier ? "var(--pos)" : "var(--neg)" }}>{(r.swarmBrier - r.marketBrier).toFixed(3)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
