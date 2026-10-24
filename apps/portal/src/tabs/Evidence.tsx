import { useState } from "react";
import type { EvidenceItem } from "@market/core";
import { useRun } from "../lib/context";
import { pct } from "../lib/format";

export function Evidence() {
  const { state } = useRun();
  const [src, setSrc] = useState("all");
  const sources = [...new Set(state.evidence.map((e) => e.source))];
  const items = state.evidence.filter((e) => src === "all" || e.source === src);

  return (
    <div className="stack">
      <div className="row between wrap">
        <div>
          <h2>Evidence</h2>
          <div className="muted" style={{ fontSize: 13 }}>
            What the market was saying before {state.cutoff?.slice(0, 10)}. Author identities are dropped at ingestion.
          </div>
        </div>
        <div className="seg">
          <button className={src === "all" ? "on" : ""} onClick={() => setSrc("all")}>all {state.evidence.length}</button>
          {sources.map((s) => (
            <button key={s} className={src === s ? "on" : ""} onClick={() => setSrc(s)}>
              {s.replaceAll("_", " ")} {state.evidence.filter((e) => e.source === s).length}
            </button>
          ))}
        </div>
      </div>

      <div className="grid g2">
        <div className="card">
          <div className="card-head"><h3>Prediction markets</h3><span className="muted" style={{ fontSize: 12 }}>Kalshi · Polymarket</span></div>
          <div className="card-pad" style={{ paddingTop: 6 }}>
            <table className="t">
              <tbody>
                {state.signals.map((s) => (
                  <tr key={s.id} id={`ev-${s.id}`}>
                    <td>
                      {s.question} {s.synthetic && <span className="chip mono">fixture</span>}
                      <div className="muted mono" style={{ fontSize: 11 }}>{s.venue} · {s.category}</div>
                    </td>
                    <td className="n" style={{ width: 90 }}>
                      <div>{pct(s.probability)}</div>
                      <div className="bar" style={{ marginTop: 6 }}><i style={{ width: pct(s.probability) }} /></div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="card">
          <div className="card-head"><h3>Anchor interviews</h3><span className="muted" style={{ fontSize: 12 }}>real people, summarised</span></div>
          <div className="card-pad" style={{ paddingTop: 6 }}>
            {state.anchors.map((a) => (
              <div key={a.id} className="qa" id={`ev-${a.id}`}>
                <div className="q">{a.segmentHint} {a.synthetic && <span className="chip mono">fixture</span>}</div>
                <div className="a" style={{ fontSize: 15 }}>“{a.quotes[0]}”</div>
                <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{a.summary}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="card">
        {items.map((e) => <Post key={e.id} e={e} />)}
        {!items.length && <div className="empty">No posts yet.</div>}
      </div>
    </div>
  );
}

export function Post({ e }: { e: EvidenceItem }) {
  return (
    <div id={`ev-${e.id}`} style={{ padding: "14px 22px", borderBottom: "1px solid var(--line)" }}>
      <div className="row wrap" style={{ fontSize: 11.5 }}>
        <span className="chip mono">{e.source.replaceAll("_", " ")}</span>
        <span className="muted mono">{e.publishedAt.slice(0, 10)}</span>
        <span className="muted mono">engagement {e.engagement}</span>
        {e.synthetic && <span className="chip warn">fixture</span>}
        <span className="muted mono" style={{ marginLeft: "auto" }}>{e.id}</span>
      </div>
      {e.title && <div style={{ marginTop: 6, fontWeight: 500 }}>{e.title}</div>}
      <div className="subtle" style={{ marginTop: 4 }}>{e.text}</div>
      {e.url && (
        <a href={e.url} target="_blank" rel="noreferrer" className="muted" style={{ fontSize: 12 }}>
          source ↗
        </a>
      )}
    </div>
  );
}
