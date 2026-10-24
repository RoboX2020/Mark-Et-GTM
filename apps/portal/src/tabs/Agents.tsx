import { useMemo, useState } from "react";
import type { AdoptionState, Persona } from "@market/core";
import { useNav, useRun } from "../lib/context";
import { label, money, pct, sentimentClass, STATE_LABEL } from "../lib/format";

export function Agents() {
  const { state } = useRun();
  const nav = useNav();
  const [q, setQ] = useState("");
  const [fState, setFState] = useState<AdoptionState | "all">("all");
  const [fSeg, setFSeg] = useState("all");
  const [fBackend, setFBackend] = useState("all");
  const segs = [...state.nodes.values()].filter((n) => n.kind === "segment");
  const backends = [...new Set([...state.personas.values()].map((p) => state.agentState.get(p.id)?.backend ?? p.backend))];

  const list = useMemo(() => {
    const ql = q.toLowerCase();
    return [...state.personas.values()].filter((p) => {
      const d = state.agentState.get(p.id);
      if (fState !== "all" && (d?.state ?? "unaware") !== fState) return false;
      if (fSeg !== "all" && p.segmentId !== fSeg) return false;
      if (fBackend !== "all" && (d?.backend ?? p.backend) !== fBackend) return false;
      if (ql && !`${p.name} ${p.role} ${p.bio}`.toLowerCase().includes(ql)) return false;
      return true;
    });
  }, [state.eventCount, q, fState, fSeg, fBackend]); // eslint-disable-line react-hooks/exhaustive-deps

  const selected = nav.selectedAgent && state.personas.get(nav.selectedAgent) ? nav.selectedAgent : list[0]?.id ?? null;

  if (!state.personas.size) return <div className="empty"><h3>No agents yet</h3>Agents appear once the population is built from the graph.</div>;

  return (
    <div className="stack">
      <div className="row between wrap">
        <div>
          <h2>Agents</h2>
          <div className="muted" style={{ fontSize: 13 }}>
            Synthetic customers sampled from aggregate segment patterns, never modelled on any real individual.
          </div>
        </div>
        <div className="row wrap">
          <input className="select" style={{ backgroundImage: "none", cursor: "text", width: 180 }} placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />
          <select className="select" value={fState} onChange={(e) => setFState(e.target.value as AdoptionState | "all")}>
            <option value="all">All states</option>
            {(Object.keys(STATE_LABEL) as AdoptionState[]).map((s) => (
              <option key={s} value={s}>{STATE_LABEL[s]}</option>
            ))}
          </select>
          <select className="select" value={fSeg} onChange={(e) => setFSeg(e.target.value)}>
            <option value="all">All segments</option>
            {segs.map((s) => (
              <option key={s.id} value={s.id}>{s.label}</option>
            ))}
          </select>
          <select className="select" value={fBackend} onChange={(e) => setFBackend(e.target.value)}>
            <option value="all">All models</option>
            {backends.map((b) => (
              <option key={b} value={b}>{b}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="split">
        <div className="card list">
          {list.slice(0, 400).map((p) => (
            <AgentRow key={p.id} p={p} on={p.id === selected} onClick={() => nav.setSelectedAgent(p.id)} />
          ))}
          {list.length > 400 && <div className="muted" style={{ padding: 12, fontSize: 12 }}>+{list.length - 400} more: narrow the filters</div>}
          {!list.length && <div className="empty">No agents match.</div>}
        </div>
        <div className="card card-pad">{selected && <AgentDetail id={selected} />}</div>
      </div>
    </div>
  );
}

function AgentRow({ p, on, onClick }: { p: Persona; on: boolean; onClick: () => void }) {
  const { state } = useRun();
  const d = state.agentState.get(p.id);
  const st = d?.state ?? "unaware";
  return (
    <div className={`list-item ${on ? "on" : ""}`} onClick={onClick}>
      <div className={`avatar ${state.thinking.has(p.id) ? "thinking" : ""}`}>{p.name[0]}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="row between">
          <span>{p.name}</span>
          <span className={`chip ${st === "adopted" ? "pos" : st === "rejected" ? "neg" : st === "considering" ? "warn" : ""}`}>{STATE_LABEL[st]}</span>
        </div>
        <div className="muted" style={{ fontSize: 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {p.role} · {state.nodes.get(p.segmentId)?.label}
        </div>
      </div>
    </div>
  );
}

export function AgentDetail({ id }: { id: string }) {
  const { state } = useRun();
  const nav = useNav();
  const p = state.personas.get(id);
  if (!p) return <div className="muted">Unknown agent {id}</div>;
  const hist = state.decisions.get(id) ?? [];
  const received = state.messages.filter((m) => m.to === id);
  const sent = state.messages.filter((m) => m.from === id);
  const iv = state.interviews.get(id);
  const ties = state.socialEdges.filter((e) => e.source === id || e.target === id).length;
  const cur = state.agentState.get(id);
  const b = state.brief;
  return (
    <div>
      <div className="row between">
        <div className="row">
          <div className={`avatar ${state.thinking.has(id) ? "thinking" : ""}`} style={{ width: 40, height: 40, fontSize: 18 }}>{p.name[0]}</div>
          <div>
            <h2>{p.name}</h2>
            <div className="muted" style={{ fontSize: 12.5 }}>
              {p.role} · {p.ageBand} · {state.nodes.get(p.segmentId)?.label}
            </div>
          </div>
        </div>
        <div className="row">
          <span className="chip mono">{cur?.backend ?? p.backend}</span>
          <span className="chip mono">{p.id}</span>
        </div>
      </div>
      <p className="subtle" style={{ marginTop: 14 }}>{p.bio}</p>
      <div className="grid g2" style={{ marginTop: 6 }}>
        <div>
          {Object.entries(p.traits).map(([k, v]) => (
            <div className="trait" key={k}>
              <span>{label(k.replace(/([A-Z])/g, " $1").toLowerCase())}</span>
              <div className="bar"><i style={{ width: pct(v) }} /></div>
              <span className="mono">{v.toFixed(2)}</span>
            </div>
          ))}
        </div>
        <div style={{ fontSize: 12.5 }} className="subtle">
          <div>Prior WTP <span className="mono">{money(p.wtp, b)}</span>{cur && cur.round > 0 && <> → <span className="mono">{money(cur.wtp, b)}</span></>}</div>
          <div>Channels: {p.channelPrefs.map(label).join(", ")}</div>
          <div>Uses: {p.competitorIds.map((c) => state.nodes.get(c)?.label ?? c).join(", ") || "—"}</div>
          <div>Social ties: <span className="mono">{ties}</span></div>
          {p.anchorId && <div>Anchored to interview <span className="mono">{p.anchorId}</span></div>}
        </div>
      </div>

      <div className="eyebrow" style={{ margin: "22px 0 12px" }}>Round by round</div>
      {hist.length === 0 && <div className="muted">Not reached yet. No exposure through channels or friends.</div>}
      <div className="timeline">
        {hist.map((d) => (
          <div key={d.round} className={`tl-item ${d.state}`}>
            <div className="row wrap" style={{ fontSize: 12 }}>
              <span className="mono muted">R{d.round}</span>
              <span className={`chip ${sentimentClass(d.sentiment)}`}>{STATE_LABEL[d.previous]} → {STATE_LABEL[d.state]}</span>
              <span className="muted">via {d.exposure === "none" ? "reflection" : d.exposure === "peer" ? "friends" : d.exposure === "both" ? `${label(d.channel ?? "")} + friends` : label(d.channel ?? "")}</span>
            </div>
            {d.comment && <div className="quote">“{d.comment}”</div>}
            <div className="muted" style={{ fontSize: 12.5 }}>{d.reasoning}</div>
            {d.objection && <div style={{ fontSize: 12.5, marginTop: 4 }}><span className="muted">Objection:</span> {d.objection}</div>}
            {d.influencedBy.length > 0 && (
              <div style={{ fontSize: 12, marginTop: 4 }} className="muted">
                Influenced by{" "}
                {d.influencedBy.slice(0, 5).map((a) => (
                  <a key={a} className="cite" onClick={() => nav.openAgent(a)}>{state.personas.get(a)?.name ?? a}</a>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {(received.length > 0 || sent.length > 0) && (
        <>
          <div className="eyebrow" style={{ margin: "10px 0 8px" }}>Conversations</div>
          {[...received.map((m) => ({ m, dir: "in" as const })), ...sent.map((m) => ({ m, dir: "out" as const }))]
            .sort((a, b) => a.m.round - b.m.round)
            .slice(0, 12)
            .map(({ m, dir }, i) => (
              <div key={i} style={{ fontSize: 12.5, marginTop: 6 }}>
                <span className="mono muted">R{m.round}</span> {dir === "in" ? "from" : "to"}{" "}
                <a className="cite" onClick={() => nav.openAgent(dir === "in" ? m.from : m.to)}>{state.personas.get(dir === "in" ? m.from : m.to)?.name}</a>
                {m.transport === "fetchai" && <span className="chip mono" style={{ marginLeft: 4 }}>fetch.ai</span>} <span className="subtle">“{m.text}”</span>
              </div>
            ))}
        </>
      )}

      {iv && (
        <>
          <div className="eyebrow" style={{ margin: "22px 0 4px" }}>Interview</div>
          {iv.qa.filter(Boolean).map((x, i) => (
            <div key={i} className="qa">
              <div className="q">{x.question}</div>
              <div className="a" style={{ fontSize: 15 }}>{x.answer}</div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
