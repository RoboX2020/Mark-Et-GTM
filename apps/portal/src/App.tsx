import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { DateCtx, NavCtx, PlayerCtx, useDateFilter, useNav, useRun, type Nav, type TabId } from "./lib/context";
import { fetchRun, fetchRuns, loadLocalFile, Player, type RunEntry } from "./lib/player";
import { connectLive, liveAvailable, type LiveHandle, type LiveRun } from "./lib/spacetime";
import { clock } from "./lib/format";
import { Rail } from "./components/Rail";
import { Overview } from "./tabs/Overview";
import { Graph } from "./tabs/Graph";
import { Agents, AgentDetail } from "./tabs/Agents";
import { Interviews } from "./tabs/Interviews";
import { Forecast } from "./tabs/Forecast";
import { Report } from "./tabs/Report";
import { Backtest } from "./tabs/Backtest";
import { Evidence, Post } from "./tabs/Evidence";
import { NewBrief } from "./components/NewBrief";

const MarketWorld = lazy(() => import("./world/MarketWorld"));

const TABS: { id: TabId; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "graph", label: "Graph" },
  { id: "agents", label: "Agents" },
  { id: "interviews", label: "Interviews" },
  { id: "forecast", label: "Forecast" },
  { id: "report", label: "Report" },
  { id: "backtest", label: "Backtest" },
  { id: "evidence", label: "Evidence" },
];

const SPEEDS = [1, 4, 10, 40, 200];

const PREFERRED_RUNS = ["backtest_humane-ai-pin", "backtest_meta-rayban", "backtest_rabbit-r1", "live_tandem", "demo"];

function RunDate({ children }: { children: ReactNode }) {
  const { state } = useRun();
  const [boundRun, setBoundRun] = useState<string | null>(null);
  const [through, setThrough] = useState("");
  if (state.runId !== boundRun) {
    setBoundRun(state.runId);
    setThrough((state.cutoff ?? "").slice(0, 10));
  } else if (!through && state.cutoff) {
    setThrough(state.cutoff.slice(0, 10));
  }
  return (
    <DateCtx.Provider value={{ through, setThrough, cutoff: (state.cutoff ?? "").slice(0, 10) }}>
      {children}
    </DateCtx.Provider>
  );
}

function readHash(): TabId {
  const h = location.hash.replace("#", "") as TabId;
  return TABS.some((t) => t.id === h) ? h : "overview";
}

export function App() {
  const player = useMemo(() => new Player(), []);
  const [tab, setTabState] = useState<TabId>(readHash());
  const [drawer, setDrawer] = useState<{ kind: "agent" | "evidence"; id: string } | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [world, setWorldState] = useState(() => new URLSearchParams(location.search).has("world"));
  const setWorld = (open: boolean) => {
    setWorldState(open);
    const url = new URL(location.href);
    if (open) url.searchParams.set("world", "1");
    else url.searchParams.delete("world");
    try {
      history.replaceState(null, "", url);
    } catch {
      /* sandboxed frames may refuse URL changes */
    }
  };

  const nav: Nav = {
    tab,
    setTab: (t) => {
      setTabState(t);
      try {
        history.replaceState(null, "", `#${t}`);
      } catch {
        /* sandboxed frames may refuse URL changes */
      }
    },
    openAgent: (id) => setDrawer({ kind: "agent", id }),
    openEvidence: (id) => setDrawer({ kind: "evidence", id }),
    selectedAgent,
    setSelectedAgent,
  };

  return (
    <PlayerCtx.Provider value={player}>
      <NavCtx.Provider value={nav}>
        <RunDate>
        <div className="shell">
          <TopBar onWorld={() => setWorld(true)} />
          <div className="body">
            <main className="main">
              <div className="main-inner">
                <Tabs />
                {tab === "overview" && <Overview />}
                {tab === "graph" && <Graph />}
                {tab === "agents" && <Agents />}
                {tab === "interviews" && <Interviews />}
                {tab === "forecast" && <Forecast />}
                {tab === "report" && <Report />}
                {tab === "backtest" && <Backtest />}
                {tab === "evidence" && <Evidence />}
              </div>
            </main>
            <Rail />
          </div>
        </div>
        {drawer && <Drawer kind={drawer.kind} id={drawer.id} onClose={() => setDrawer(null)} />}
        {world && (
          <Suspense fallback={<div className="world-loading">Building the town…</div>}>
            <MarketWorld onClose={() => setWorld(false)} />
          </Suspense>
        )}
        </RunDate>
      </NavCtx.Provider>
    </PlayerCtx.Provider>
  );
}

function Tabs() {
  const { state } = useRun();
  const nav = useNav();
  const counts: Partial<Record<TabId, number>> = {
    graph: state.nodes.size,
    agents: state.personas.size,
    interviews: state.interviews.size,
    evidence: state.evidence.length,
  };
  return (
    <nav className="tabs">
      {TABS.map((t) => (
        <button key={t.id} className={`tab ${nav.tab === t.id ? "on" : ""}`} onClick={() => nav.setTab(t.id)}>
          {t.label}
          {counts[t.id] ? <span className="count">{counts[t.id]}</span> : null}
        </button>
      ))}
    </nav>
  );
}


function TopBar({ onWorld }: { onWorld: () => void }) {
  const { state, player } = useRun();
  const date = useDateFilter();
  const [source, setSource] = useState<"replay" | "live">(import.meta.env.VITE_STREAM_SOURCE === "spacetime" ? "live" : "replay");
  const [runs, setRuns] = useState<RunEntry[]>([]);
  const [current, setCurrent] = useState<string>("");
  const [liveRuns, setLiveRuns] = useState<LiveRun[]>([]);
  const [livePick, setLivePick] = useState("");
  const [liveErr, setLiveErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [briefOpen, setBriefOpen] = useState(false);
  const live = useRef<LiveHandle | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [theme, setTheme] = useState<string>(() => {
    try {
      return localStorage.getItem("theme") ?? "auto";
    } catch {
      return "auto";
    }
  });

  useEffect(() => {
    if (theme === "auto") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem("theme", theme);
    } catch {
      /* private mode */
    }
  }, [theme]);

  useEffect(() => {
    if (source !== "replay") return;
    fetchRuns().then((r) => {
      setRuns(r);
      const pick =
        new URLSearchParams(location.search).get("run") ??
        PREFERRED_RUNS.map((id) => r.find((x) => x.id === id)).find(Boolean)?.id ??
        r[0]?.id;
      if (pick) choose(r, pick);
    });
  }, [source]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (source !== "live") return;
    let cancelled = false;
    connectLive(player)
      .then((h) => {
        if (cancelled) return h.disconnect();
        live.current = h;
        h.onRuns(() => {
          const list = h.runs();
          setLiveRuns(list);
          setLivePick((cur) => (cur && list.some((r) => r.runId === cur) ? cur : list[0]?.runId ?? ""));
        });
        setLiveErr(null);
      })
      .catch((e) => setLiveErr((e as Error).message));
    return () => {
      cancelled = true;
      live.current?.disconnect();
      live.current = null;
    };
  }, [source, player]);

  useEffect(() => {
    if (source === "live" && livePick) live.current?.watch(livePick);
  }, [source, livePick]);

  async function choose(list: RunEntry[], id: string) {
    const entry = list.find((r) => r.id === id);
    if (!entry) return;
    setCurrent(id);
    player.load(await fetchRun(entry));
    const url = new URL(location.href);
    url.searchParams.set("run", id);
    try {
      history.replaceState(null, "", url);
    } catch {
      /* sandboxed frames may refuse URL changes */
    }
  }

  const elapsed = player.live ? (state.lastTs ?? 0) - (state.startedAt ?? 0) : player.vt;

  return (
    <>
    <header className="topbar">
      <div className="brand">
        <span className="mark">Mark-Et</span>
        <span className="tag">launch simulator</span>
      </div>
      <div className="seg">
        <button className={source === "replay" ? "on" : ""} onClick={() => setSource("replay")}>replay</button>
        <button
          className={source === "live" ? "on" : ""}
          onClick={() => {
            if (!liveAvailable()) {
              setNote("Live mode needs a SpacetimeDB server. Recorded runs keep playing here.");
              return;
            }
            setNote(null);
            setSource("live");
          }}
          title={liveAvailable() ? "Subscribe to SpacetimeDB" : "SpacetimeDB bindings are not in this build"}
        >
          live
        </button>
      </div>
      {date.cutoff && (
        <label className="field date-filter" title="Hide posts published after this day. The forecast was computed using only data on or before the pre-launch cutoff.">
          Data through
          <input type="date" max={date.cutoff} value={date.through || date.cutoff} onChange={(e) => date.setThrough(e.target.value)} />
        </label>
      )}
      {source === "replay" && note && <span className="top-note">{note}</span>}
      {source === "replay" ? (
        <>
          <select className="select" value={current} onChange={(e) => choose(runs, e.target.value)}>
            {!runs.length && <option value="">No recorded runs</option>}
            {runs.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label} · {r.kind.replace("_", " ")}
              </option>
            ))}
          </select>
          <button className="btn" onClick={() => fileRef.current?.click()} title="Open an event log (.jsonl)">Open log</button>
          <input
            ref={fileRef}
            type="file"
            accept=".jsonl,.ndjson,.txt"
            hidden
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (f) player.load(await loadLocalFile(f));
            }}
          />
          <div className="spacer" />
          <div className="player">
            <button className="btn icon" onClick={() => (player.playing ? player.pause() : player.play())} aria-label={player.playing ? "Pause" : "Play"}>
              {player.playing ? "❚❚" : "▶"}
            </button>
            <input className="scrub" type="range" min={0} max={1000} value={Math.round(player.progress * 1000)} onChange={(e) => player.seek(Number(e.target.value) / 1000)} />
            <span className="clock">
              {clock(elapsed)} / {clock(player.duration)}
            </span>
            <div className="seg">
              {SPEEDS.map((s) => (
                <button key={s} className={player.speed === s ? "on" : ""} onClick={() => player.setSpeed(s)}>
                  {s}×
                </button>
              ))}
            </div>
            <button className="btn" onClick={() => player.finish()}>Skip to end</button>
          </div>
        </>
      ) : (
        <>
          <select className="select" value={livePick} onChange={(e) => setLivePick(e.target.value)}>
            <option value="" disabled>
              {liveErr ? "Not connected" : liveRuns.length ? "Choose a live run" : "Waiting for runs…"}
            </option>
            {liveRuns.map((r) => (
              <option key={r.runId} value={r.runId}>
                {r.label} · {r.status}
              </option>
            ))}
          </select>
          {liveErr && <span className="muted" style={{ fontSize: 12 }}>{liveErr}</span>}
          <div className="spacer" />
          <span className="status">
            <span className={`dot ${state.status === "running" ? "live" : ""}`} /> SpacetimeDB {liveErr ? "offline" : "connected"}
          </span>
        </>
      )}
      <button className="btn world-btn" onClick={onWorld} title="Watch a launch play out in a 3D town">Market World</button>
      <button className="btn" onClick={() => setBriefOpen(true)}>New brief</button>
      <button className="btn icon" onClick={() => setTheme(theme === "auto" ? "dark" : theme === "dark" ? "light" : "auto")} title={`Theme: ${theme}`}>
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
          {theme !== "light" && <path d={theme === "dark" ? "M8 1.8a6.2 6.2 0 0 0 0 12.4z" : "M8 1.8a6.2 6.2 0 0 1 0 12.4z"} fill="currentColor" />}
        </svg>
      </button>
      </header>
      {briefOpen && <NewBrief onClose={() => setBriefOpen(false)} />}
    </>
    );
  }

function Drawer({ kind, id, onClose }: { kind: "agent" | "evidence"; id: string; onClose: () => void }) {
  const { state } = useRun();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const ev = state.evidence.find((e) => e.id === id);
  const sig = state.signals.find((s) => s.id === id);
  const anchor = state.anchors.find((a) => a.id === id);
  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <div className="drawer">
        <div className="row between" style={{ marginBottom: 12 }}>
          <span className="eyebrow">{kind === "agent" ? "Agent" : "Evidence"}</span>
          <button className="btn icon" onClick={onClose} aria-label="Close">×</button>
        </div>
        {kind === "agent" && <AgentDetail id={id} />}
        {kind === "evidence" && (
          <div className="card">
            {ev && <Post e={ev} />}
            {sig && (
              <div className="card-pad">
                <span className="chip mono">{sig.venue}</span>
                <h3 style={{ marginTop: 8 }}>{sig.question}</h3>
                <div className="mono" style={{ marginTop: 6 }}>{(sig.probability * 100).toFixed(0)}% as of {sig.asOf.slice(0, 10)}</div>
              </div>
            )}
            {anchor && (
              <div className="card-pad">
                <span className="chip mono">anchor interview</span>
                <h3 style={{ marginTop: 8 }}>{anchor.segmentHint}</h3>
                <p className="subtle">{anchor.summary}</p>
                {anchor.quotes.map((q, i) => <div key={i} className="quote">“{q}”</div>)}
              </div>
            )}
            {!ev && !sig && !anchor && <div className="card-pad muted">Evidence {id} is not in this run.</div>}
          </div>
        )}
      </div>
    </>
  );
}
