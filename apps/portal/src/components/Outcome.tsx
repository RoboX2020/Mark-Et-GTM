import { OUTCOME_LABEL, OUTCOME_TONE, type Outcome } from "../lib/outcomes";
import type { Verdict } from "../lib/verdict";

const usd = (n: number) => (n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${Math.round(n / 1e6)}M` : `$${Math.round(n / 1e3)}k`);

export function OutcomeCard({ outcome, compact = false }: { outcome: Outcome; compact?: boolean }) {
  return (
    <div className={`outcome ${OUTCOME_TONE[outcome.verdict]}`}>
      <span className="outcome-tag">{OUTCOME_LABEL[outcome.verdict]}</span>
      <h3>{outcome.headline}</h3>
      <div className="outcome-nums">
        <div>
          <strong>{outcome.units >= 1e6 ? `${(outcome.units / 1e6).toFixed(0)}M+` : `≈${Math.round(outcome.units / 1000)}k`}</strong>
          <span>{outcome.unitsLabel}</span>
        </div>
        <div>
          <strong>{usd(outcome.revenue)}</strong>
          <span>{outcome.revenueNote}</span>
        </div>
      </div>
      {!compact && (
        <>
          <ul>
            {outcome.facts.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
          <div className="src">Sources: {outcome.sources}</div>
        </>
      )}
    </div>
  );
}

/** The simulation's call next to what really happened, so a wrong call is obvious. */
export function Versus({ verdict, outcome }: { verdict: Verdict; outcome: Outcome }) {
  return (
    <div className="versus">
      <div>
        <span className="eyebrow">Simulation said</span>
        <strong className={verdict.tone}>{verdict.headline}</strong>
        <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{verdict.detail}</div>
      </div>
      <div>
        <span className="eyebrow">Real world</span>
        <strong className={OUTCOME_TONE[outcome.verdict]}>{outcome.headline}</strong>
        <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{outcome.revenueNote}</div>
      </div>
    </div>
  );
}
