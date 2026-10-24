import { useState } from "react";
import type { Provenance } from "@market/core";
import { useNav, useRun } from "../lib/context";
import { int, label, money, pct } from "../lib/format";
import { FinanceChart } from "../components/Charts";

export function Forecast() {
  const { state } = useRun();
  const f = state.finance;
  const b = state.brief;
  const [prov, setProv] = useState<{ title: string; p: Provenance } | null>(null);

  if (!f || !b)
    return (
      <div className="empty">
        <h3>Forecast pending</h3>The finance agent turns the fitted adoption curve, willingness to pay and channel results into a 12-month plan.
      </div>
    );

  const flagged = f.items.filter((i) => i.provenance.needsReview).length + f.channels.filter((c) => c.provenance.needsReview).length;
  const fmtItem = (v: number, unit: string) => (unit === "fraction" ? pct(v, 1) : unit === "month" ? (v < 0 ? "> 12" : `Month ${v}`) : unit === "customers" ? int(v) : money(v, b, true));

  return (
    <div className="stack">
      <div className="row between wrap">
        <div>
          <h2>Financial forecast</h2>
          <div className="muted" style={{ fontSize: 13 }}>
            12 months · {b.price.model.replaceAll("_", " ")} at {money(b.price.amount, b)} · {int(b.addressableMarket)} reachable buyers · {money(b.budget.monthlyMarketing, b, true)}/mo marketing
          </div>
        </div>
        {flagged > 0 && <span className="chip warn">⚑ {flagged} figures need human review</span>}
      </div>

      <div className="grid g3">
        {f.items.map((it) => (
          <div key={it.key} className="card metric" style={{ cursor: "pointer" }} onClick={() => setProv({ title: it.label, p: it.provenance })}>
            <div className="row between">
              <span className="eyebrow">{it.label}</span>
              <Confidence p={it.provenance} />
            </div>
            <div className="v">{fmtItem(it.value, it.unit)}</div>
            <div className="s">
              {it.provenance.agentIds.length} agents · {it.provenance.evidenceIds.length} sources
            </div>
          </div>
        ))}
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Revenue, costs and cash</h3>
          <div className="legend">
            <span><i style={{ background: "var(--pos)" }} /> revenue</span>
            <span><i style={{ background: "var(--ink-4)" }} /> costs</span>
            <span><i style={{ background: "var(--ink-3)", height: 2 }} /> cash, own scale</span>
          </div>
        </div>
        <div className="card-pad">
          <FinanceChart months={f.months} fmt={(v) => money(v, b, true)} />
        </div>
      </div>

      <div className="grid g2">
        <div className="card">
          <div className="card-head"><h3>Acquisition cost by channel</h3></div>
          <div className="card-pad" style={{ paddingTop: 6 }}>
            <table className="t">
              <thead>
                <tr><th>Channel</th><th className="n">Spend</th><th className="n">Customers</th><th className="n">CAC</th><th className="n">Conf.</th></tr>
              </thead>
              <tbody>
                {f.channels.map((c) => (
                  <tr key={c.channel} className="click" onClick={() => setProv({ title: `CAC: ${label(c.channel)}`, p: c.provenance })}>
                    <td>{label(c.channel)} {c.provenance.needsReview && <span className="flag">⚑</span>}</td>
                    <td className="n">{money(c.spend, b, true)}</td>
                    <td className="n">{int(c.customers)}</td>
                    <td className="n">{c.cac === null ? (c.spend === 0 ? "organic" : "—") : money(c.cac, b)}</td>
                    <td className="n">{pct(c.provenance.confidence)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="card">
          <div className="card-head"><h3>Monthly plan</h3></div>
          <div className="card-pad" style={{ paddingTop: 6, maxHeight: 360, overflow: "auto" }}>
            <table className="t">
              <thead>
                <tr><th>Mo</th><th className="n">New</th><th className="n">Active</th><th className="n">Revenue</th><th className="n">Net</th><th className="n">Cash</th></tr>
              </thead>
              <tbody>
                {f.months.map((m) => (
                  <tr key={m.month}>
                    <td className="mono">{m.month}{f.breakEvenMonth === m.month && <span className="chip pos" style={{ marginLeft: 6 }}>break-even</span>}</td>
                    <td className="n">{int(m.newCustomers)}</td>
                    <td className="n">{int(m.activeCustomers)}</td>
                    <td className="n">{money(m.revenue, b, true)}</td>
                    <td className="n" style={{ color: m.net < 0 ? "var(--neg)" : "var(--pos)" }}>{money(m.net, b, true)}</td>
                    <td className="n">{money(m.cash, b, true)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
      {prov && <ProvenanceDrawer title={prov.title} p={prov.p} onClose={() => setProv(null)} />}
    </div>
  );
}

function Confidence({ p }: { p: Provenance }) {
  return p.needsReview ? <span className="chip warn">⚑ review</span> : <span className="chip mono">{pct(p.confidence)} conf.</span>;
}

function ProvenanceDrawer({ title, p, onClose }: { title: string; p: Provenance; onClose: () => void }) {
  const { state } = useRun();
  const nav = useNav();
  const ev = new Map(state.evidence.map((e) => [e.id, e]));
  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <div className="drawer">
        <div className="row between">
          <span className="eyebrow">Provenance</span>
          <button className="btn icon" onClick={onClose}>×</button>
        </div>
        <h2 style={{ marginTop: 6 }}>{title}</h2>
        <div className="row wrap" style={{ marginTop: 10 }}>
          <span className={`chip ${p.needsReview ? "warn" : "pos"}`}>{p.needsReview ? "⚑ needs human review" : "above confidence threshold"}</span>
          <span className="chip mono">confidence {pct(p.confidence)}</span>
        </div>
        {p.note && <div className="callout" style={{ marginTop: 14 }}>{p.note}</div>}
        <div className="eyebrow" style={{ marginTop: 20 }}>Agents behind this number · {p.agentIds.length}</div>
        <div className="row wrap" style={{ marginTop: 8 }}>
          {p.agentIds.slice(0, 60).map((id) => (
            <a key={id} className="cite" onClick={() => nav.openAgent(id)}>{state.personas.get(id)?.name ?? id}</a>
          ))}
          {p.agentIds.length > 60 && <span className="muted">+{p.agentIds.length - 60}</span>}
        </div>
        <div className="eyebrow" style={{ marginTop: 20 }}>Evidence · {p.evidenceIds.length}</div>
        {p.evidenceIds.slice(0, 20).map((id) => {
          const e = ev.get(id);
          return (
            <div key={id} style={{ fontSize: 13, marginTop: 10, cursor: "pointer" }} onClick={() => nav.openEvidence(id)}>
              <span className="chip mono">{e?.source ?? "graph"}</span> <span className="subtle">{(e?.title ?? e?.text ?? id).slice(0, 160)}</span>
            </div>
          );
        })}
      </div>
    </>
  );
}
