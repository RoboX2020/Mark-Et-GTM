import { useRun } from "../lib/context";
import { pct } from "../lib/format";
import { LineChart } from "../components/Charts";

export function Backtest() {
  const { state } = useRun();
  const bt = state.backtest;
  const mk = state.marketBacktest;

  if (!bt && !mk.length)
    return (
      <div className="empty">
        <h3>No backtest in this run</h3>
        Run <span className="mono">pnpm backtest &lt;case&gt;</span> to point the simulator at a product that already launched, using only pre-launch data, and compare it with
        what actually happened. Or run <span className="mono">pnpm --filter @market/engine backtest-markets</span> to score the swarm on resolved prediction markets.
      </div>
    );

  return (
    <div className="stack">
      {bt && (
        <>
          <div className="row between wrap">
            <div>
              <span className="eyebrow">Backtest · data cutoff {bt.cutoff.slice(0, 10)}</span>
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
          <div className="grid g2">
            <div className="card">
              <div className="card-head">
                <h3>Predicted</h3>
                <span className="muted" style={{ fontSize: 12 }}>Bass curve from pre-launch data only</span>
              </div>
              <div className="card-pad">
                <LineChart yFloor={0.02} xMax={12} yFmt={(v) => pct(v, 1)} series={[{ points: bt.predicted.map((p) => ({ x: p.month, y: p.cumulative })), kind: "curve", area: true }]} />
              </div>
            </div>
            <div className="card">
              <div className="card-head">
                <h3>What actually happened</h3>
                <span className="muted" style={{ fontSize: 12 }}>observed, overlaid on prediction</span>
              </div>
              <div className="card-pad">
                <LineChart
                  yFloor={0.02}
                  xMax={12}
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

      {mk.length > 0 && <MarketTable />}
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
