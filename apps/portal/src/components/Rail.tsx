import { STAGES } from "@market/core";
import { useNav, useRun } from "../lib/context";
import { clock, label } from "../lib/format";

const STAGE_SHORT: Record<string, string> = {
  ingest: "Signal",
  graph: "Graph",
  population: "Agents",
  network: "Network",
  simulation: "Rounds",
  interviews: "Interviews",
  bass: "Bass fit",
  finance: "Finance",
  report: "Report",
  backtest: "Backtest",
};

/** The live activity rail: pipeline progress plus every decision as it happens. */
export function Rail() {
  const { state } = useRun();
  const nav = useNav();
  const running = STAGES.find((s) => state.stages[s].status === "running");
  const lastDone = [...STAGES].reverse().find((s) => state.stages[s].status === "done");
  const detail = running ? state.stages[running].detail : lastDone ? state.stages[lastDone].detail : "";
  const items = [...state.activity].reverse().slice(0, 160);
  const t0 = state.startedAt ?? 0;

  return (
    <aside className="rail">
      <div className="rail-head">
        <div className="row between">
          <span className="eyebrow">Live activity</span>
          <span className="status">
            <span className={`dot ${state.status === "running" ? "live" : state.status === "ok" ? "ok" : state.status === "error" ? "err" : ""}`} />
            {state.status === "running" ? (running ? label(running) : "running") : state.status === "idle" ? "idle" : state.status === "ok" ? "complete" : "failed"}
          </span>
        </div>
        <ul className="stages">
          {STAGES.map((s) => (
            <li key={s} className={state.stages[s].status}>
              <div className="tick" />
              {STAGE_SHORT[s]}
            </li>
          ))}
        </ul>
        <div className="stage-detail">{detail}</div>
      </div>
      <div className="feed">
        {items.length === 0 && <div className="empty">Waiting for the first event…</div>}
        {items.map((it) => (
          <div
            key={it.seq}
            className={`feed-item ${it.tone ?? ""} ${it.agentId ? "click" : ""}`}
            onClick={() => it.agentId && nav.openAgent(it.agentId)}
          >
            <span className="k" />
            <div>
              <div>{it.text}</div>
              <div className="meta">
                {clock(it.ts - t0)} · {it.kind}
              </div>
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
}
