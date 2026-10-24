import { useRun } from "../lib/context";
import { Markdown } from "../components/Markdown";

export function Report() {
  const { state } = useRun();
  const sections = [...state.report.values()].sort((a, b) => a.order - b.order);
  if (!sections.length)
    return (
      <div className="empty">
        <h3>The report is written last</h3>Every claim cites the agents and evidence behind it; low-confidence figures are flagged for review.
      </div>
    );
  const b = state.brief;
  return (
    <div className="report">
      <div className="eyebrow">Launch readiness report</div>
      <h1 style={{ marginTop: 6 }}>{b?.product.name}</h1>
      <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>
        Data up to {state.cutoff?.slice(0, 10)} · {state.personas.size} agents · {state.evidence.length} public posts · {state.signals.length} market signals
      </div>
      {sections.map((s) => (
        <section key={s.id}>
          <h2>{s.title}</h2>
          <Markdown text={s.text} streaming={!s.done} />
        </section>
      ))}
    </div>
  );
}
