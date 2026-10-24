import { useState } from "react";
import { useNav, useRun } from "../lib/context";
import { label, money, STATE_LABEL } from "../lib/format";

export function Interviews() {
  const { state } = useRun();
  const nav = useNav();
  const ivs = [...state.interviews.values()];
  const [sel, setSel] = useState<string | null>(null);
  const current = (sel && state.interviews.get(sel)) || ivs[ivs.length - 1];

  if (!ivs.length)
    return (
      <div className="empty">
        <h3>No interviews yet</h3>A stratified sample of adopters, fence-sitters and rejecters is interviewed after the final round.
      </div>
    );

  const done = ivs.filter((i) => i.done);
  const recommend = done.filter((i) => i.done!.wouldRecommend).length;
  const b = state.brief;

  return (
    <div className="stack">
      <div className="row between wrap">
        <div>
          <h2>Interviews</h2>
          <div className="muted" style={{ fontSize: 13 }}>
            {ivs.length} agents interviewed · {recommend}/{done.length} would recommend · real anchor interviews: {state.anchors.filter((a) => !a.synthetic).length}
          </div>
        </div>
      </div>
      <div className="split">
        <div className="card list">
          {ivs.map((iv) => {
            const p = state.personas.get(iv.agentId);
            const st = state.agentState.get(iv.agentId)?.state ?? "aware";
            return (
              <div key={iv.agentId} className={`list-item ${current?.agentId === iv.agentId ? "on" : ""}`} onClick={() => setSel(iv.agentId)}>
                <div className={`avatar ${iv.done ? "" : "thinking"}`}>{p?.name[0]}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="row between">
                    <span>{p?.name}</span>
                    <span className={`chip ${st === "adopted" ? "pos" : st === "rejected" ? "neg" : ""}`}>{STATE_LABEL[st]}</span>
                  </div>
                  <div className="muted" style={{ fontSize: 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {iv.done ? `“${iv.done.topObjection}”` : "answering…"}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        {current && (
          <div className="card card-pad">
            <div className="row between wrap">
              <div>
                <span className="eyebrow">Interview</span>
                <h2 style={{ marginTop: 4 }}>
                  <a style={{ cursor: "pointer", textDecoration: "none" }} onClick={() => nav.openAgent(current.agentId)}>
                    {state.personas.get(current.agentId)?.name}
                  </a>
                </h2>
                <div className="muted" style={{ fontSize: 12.5 }}>
                  {state.personas.get(current.agentId)?.role} · {state.nodes.get(state.personas.get(current.agentId)?.segmentId ?? "")?.label}
                </div>
              </div>
              {current.done && (
                <div className="row wrap">
                  <span className="chip mono">WTP {money(current.done.wtp, b)}</span>
                  <span className={`chip ${current.done.priceVerdict === "too_expensive" ? "neg" : current.done.priceVerdict === "too_cheap" ? "pos" : ""}`}>{label(current.done.priceVerdict)}</span>
                  <span className={`chip ${current.done.wouldRecommend ? "pos" : ""}`}>{current.done.wouldRecommend ? "would recommend" : "wouldn't recommend yet"}</span>
                </div>
              )}
            </div>
            <div style={{ marginTop: 10 }}>
              {current.qa.filter(Boolean).map((x, i) => (
                <div key={i} className="qa">
                  <div className="q">{x.question}</div>
                  <div className="a">{x.answer}</div>
                </div>
              ))}
              {!current.done && (
                <div className="qa">
                  <span className="caret" />
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
