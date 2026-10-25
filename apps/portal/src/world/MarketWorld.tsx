import { Component, useEffect, useRef, useState, type ReactNode } from "react";
import type { PriceModel, RunState } from "@market/core";
import { Player } from "../lib/player";
import { useNav, useRun } from "../lib/context";
import { Town, MOOD_COLOR, PALETTE, hoodsOf, type Selection } from "./Town";
import { countMoods, moodOf, topObjection, usePlayerVersion, verdictOf } from "./useWorld";
import { engineUrl, PRESETS, resolveSource, saveEngineUrl, type RunSource, type SourceMode } from "./sources";
import { scriptedRun, type WorldBriefInput } from "./scriptedRun";
import "./world.css";

const SPEEDS = [0.5, 1, 2, 4, 8];
/** Outside the social rounds (ingest, interviews, report writing) the world fast-forwards. */
const BOOST = 40;

interface TownRun {
  key: number;
  input: WorldBriefInput;
  player: Player;
  source: RunSource | null;
  notes: string[];
  error: string | null;
  abort: AbortController;
}

const BILLING: { id: PriceModel; label: string }[] = [
  { id: "one_time", label: "one-time" },
  { id: "subscription_monthly", label: "/ month" },
  { id: "subscription_annual", label: "/ year" },
  { id: "freemium", label: "freemium" },
];

const EMPTY: WorldBriefInput = { name: "", price: 49, description: "", priceModel: "one_time", population: 240 };

function money(n: number): string {
  return n >= 100 ? `$${Math.round(n).toLocaleString()}` : `$${n.toFixed(n % 1 ? 2 : 0)}`;
}

export default function MarketWorld({ onClose }: { onClose: () => void }) {
  const main = useRun().player;
  const nav = useNav();
  const [phase, setPhase] = useState<"setup" | "play">("setup");
  const [forms, setForms] = useState<[WorldBriefInput, WorldBriefInput]>([{ ...PRESETS[0], priceModel: "one_time", population: 240 }, { ...PRESETS[2], priceModel: "one_time", population: 240 }]);
  const [compare, setCompare] = useState(false);
  const [mode, setMode] = useState<SourceMode>("auto");
  const [towns, setTowns] = useState<TownRun[]>([]);
  const [speed, setSpeed] = useState(1);
  const [orbit, setOrbit] = useState(true);
  const [selections, setSelections] = useState<Selection[]>([null, null]);
  const keyRef = useRef(0);

  const townsRef = useRef(towns);
  townsRef.current = towns;
  useEffect(() => () => townsRef.current.forEach((t) => stopTown(t)), []);

  function stopTown(t: TownRun) {
    t.abort.abort();
    t.player.pause();
  }

  function patchTown(key: number, patch: Partial<TownRun>) {
    setTowns((list) => list.map((t) => (t.key === key ? { ...t, ...patch } : t)));
  }

  async function boot(t: TownRun) {
    const { source, fallbacks } = await resolveSource(t.input, mode).catch((err: Error) => ({
      source: { kind: "scripted", displayName: t.input.name || "Your product", note: "Scripted demo: seeded diffusion, no models called", envs: scriptedRun(t.input) } as RunSource,
      fallbacks: [`Could not resolve a run (${err.message}).`],
    }));
    if (t.abort.signal.aborted) return;
    patchTown(t.key, { source, notes: fallbacks });
    t.player.setSpeed(speedRef.current);
    if (source.envs) {
      t.player.load(source.envs);
      return;
    }
    t.player.beginStream();
    try {
      await source.stream!((env) => t.player.append(env), t.abort.signal);
      t.player.endStream();
    } catch (err) {
      if (t.abort.signal.aborted) return;
      t.player.endStream();
      const fb = await resolveSource(t.input, "recorded");
      patchTown(t.key, { source: fb.source, notes: [...fallbacks, `Engine run failed (${(err as Error).message}); switched to a ${fb.source.kind} run.`, ...fb.fallbacks] });
      t.player.load(fb.source.envs ?? scriptedRun(t.input));
    }
  }

  const speedRef = useRef(speed);
  speedRef.current = speed;

  function launch() {
    towns.forEach(stopTown);
    const inputs = compare ? forms : [forms[0]];
    const next = inputs.map((input) => ({
      key: ++keyRef.current,
      input: { ...input, name: input.name.trim() || "Your product" },
      player: new Player(),
      source: null,
      notes: [],
      error: null,
      abort: new AbortController(),
    }));
    setTowns(next);
    setSelections([null, null]);
    setPhase("play");
    next.forEach((t) => void boot(t));
  }

  // Fast-forward the slow non-visual stages so the town spends its time on the rounds.
  useEffect(() => {
    if (phase !== "play") return;
    const id = setInterval(() => {
      for (const t of towns) {
        const s = t.player.state;
        const total = s.brief?.rounds ?? 6;
        const inRounds = s.currentRound > 0 && s.rounds.length < total;
        const want = inRounds || t.player.streaming ? speed : Math.max(speed, BOOST);
        if (t.player.speed !== want) t.player.setSpeed(want);
      }
    }, 150);
    return () => clearInterval(id);
  }, [phase, towns, speed]);

  const allPlaying = usePlayingFlag(towns);

  function togglePlay() {
    const anyPlaying = towns.some((t) => t.player.playing);
    for (const t of towns) (anyPlaying ? t.player.pause() : t.player.play());
  }
  function restart() {
    for (const t of towns) {
      t.player.seek(0);
      t.player.play();
    }
    setSelections([null, null]);
  }
  function skip() {
    for (const t of towns) t.player.finish();
  }
  function openReport(t: TownRun) {
    main.load(t.player.envs.slice(), { autoplay: false });
    main.finish();
    nav.setTab("report");
    onClose();
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === "Escape") {
        if (selections.some(Boolean)) setSelections([null, null]);
        else if (phase === "play") setPhase("setup");
        else onClose();
      } else if (e.key === " " && phase === "play") {
        e.preventDefault();
        togglePlay();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="world">
      {phase === "setup" && (
        <LaunchPanel
          forms={forms}
          setForms={setForms}
          compare={compare}
          setCompare={setCompare}
          mode={mode}
          setMode={setMode}
          onLaunch={launch}
          onClose={onClose}
          canResume={towns.length > 0}
          onResume={() => setPhase("play")}
        />
      )}
      {phase === "play" && (
        <>
          <div className={`w-towns ${towns.length > 1 ? "split" : ""}`}>
            {towns.map((t, i) => (
              <div className="w-pane" key={t.key}>
                <WorldBoundary>
                  <Town
                    player={t.player}
                    name={t.source?.displayName ?? t.input.name}
                    selection={selections[i]}
                    onSelect={(s) => setSelections((cur) => cur.map((c, j) => (j === i ? s : c)))}
                    onOpenReport={() => openReport(t)}
                    autoOrbit={orbit}
                  />
                </WorldBoundary>
                <Hud town={t} compact={towns.length > 1} label={towns.length > 1 ? (i === 0 ? "Town A" : "Town B") : null} />
                {selections[i] && (
                  <SelectionPanel
                    player={t.player}
                    selection={selections[i]}
                    price={t.input.price}
                    onClose={() => setSelections((cur) => cur.map((c, j) => (j === i ? null : c)))}
                  />
                )}
              </div>
            ))}
          </div>
          <div className="w-controls">
            <button className="w-btn icon" onClick={togglePlay} aria-label={allPlaying ? "Pause" : "Play"}>
              {allPlaying ? "❚❚" : "▶"}
            </button>
            <div className="w-seg" role="group" aria-label="Playback speed">
              {SPEEDS.map((s) => (
                <button key={s} className={speed === s ? "on" : ""} onClick={() => setSpeed(s)}>
                  {s}×
                </button>
              ))}
            </div>
            <button className="w-btn" onClick={restart}>Restart</button>
            <button className="w-btn" onClick={skip}>Skip to verdict</button>
            <button className={`w-btn ${orbit ? "on" : ""}`} onClick={() => setOrbit(!orbit)} title="Slow cinematic orbit">Orbit</button>
            <span className="w-controls-gap" />
            <button className="w-btn" onClick={() => setPhase("setup")}>New launch</button>
            <button className="w-btn" onClick={onClose}>Exit world</button>
          </div>
        </>
      )}
    </div>
  );
}

function usePlayingFlag(towns: TownRun[]): boolean {
  const [flag, setFlag] = useState(false);
  useEffect(() => {
    const update = () => setFlag(towns.some((t) => t.player.playing));
    update();
    const offs = towns.map((t) => t.player.subscribe(update));
    return () => offs.forEach((o) => o());
  }, [towns]);
  return flag;
}

// ── Launch panel ────────────────────────────────────────────────────

function LaunchPanel(props: {
  forms: [WorldBriefInput, WorldBriefInput];
  setForms: (f: [WorldBriefInput, WorldBriefInput]) => void;
  compare: boolean;
  setCompare: (b: boolean) => void;
  mode: SourceMode;
  setMode: (m: SourceMode) => void;
  onLaunch: () => void;
  onClose: () => void;
  canResume: boolean;
  onResume: () => void;
}) {
  const { forms, setForms, compare } = props;
  const [url, setUrl] = useState(engineUrl());
  const [showEngine, setShowEngine] = useState(Boolean(engineUrl()));
  const set = (i: 0 | 1, patch: Partial<WorldBriefInput>) => setForms((i === 0 ? [{ ...forms[0], ...patch }, forms[1]] : [forms[0], { ...forms[1], ...patch }]) as [WorldBriefInput, WorldBriefInput]);
  const valid = forms.slice(0, compare ? 2 : 1).every((f) => f.name.trim() && Number.isFinite(f.price) && f.price >= 0);

  return (
    <div className="w-setup">
      <div className="w-setup-bg" aria-hidden="true">
        {Array.from({ length: 18 }, (_, i) => (
          <span key={i} className="w-voxel" style={{ left: `${(i * 37) % 100}%`, top: `${(i * 53) % 100}%`, background: PALETTE[i % PALETTE.length], animationDelay: `${(i % 6) * -1.3}s` }} />
        ))}
      </div>
      <div className="w-card">
        <div className="w-card-head">
          <div>
            <div className="w-kicker">Market World</div>
            <h1 className="w-title">Launch a product into the town</h1>
            <p className="w-sub">Every resident is one simulated customer. Watch them hear about it, talk to neighbours and decide.</p>
          </div>
          <button className="w-btn icon ghost" onClick={props.onClose} aria-label="Close Market World">×</button>
        </div>

        <div className="w-presets">
          <span className="w-label">Try</span>
          {PRESETS.map((p) => (
            <button key={p.tag} className="w-chip" onClick={() => set(0, { name: p.name, price: p.price, description: p.description, priceModel: p.priceModel ?? "one_time" })}>
              {p.tag}
            </button>
          ))}
        </div>

        <div className={`w-forms ${compare ? "two" : ""}`}>
          {(compare ? [0, 1] : [0]).map((i) => (
            <ProductForm key={i} title={compare ? (i === 0 ? "Town A" : "Town B") : null} value={forms[i]} onChange={(p) => set(i as 0 | 1, p)} />
          ))}
        </div>

        <div className="w-options">
          <label className="w-toggle">
            <input type="checkbox" checked={compare} onChange={(e) => props.setCompare(e.target.checked)} />
            <span>Side by side: two products, two towns</span>
          </label>
          <div className="w-seg" role="group" aria-label="Run source">
            {(
              [
                ["auto", "Best available"],
                ["recorded", "Recorded run"],
                ["scripted", "Scripted demo"],
              ] as [SourceMode, string][]
            ).map(([m, label]) => (
              <button key={m} className={props.mode === m ? "on" : ""} onClick={() => props.setMode(m)}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <p className="w-help">
          {props.mode === "auto" &&
            (url
              ? "Starts a real run on your engine. If it is unreachable or fails, a matching recorded run plays instead, then the scripted demo."
              : "Plays a recorded engine run when one matches the product name (Humane, Ray-Ban Meta, Rabbit, Tandem), otherwise the scripted demo. Connect an engine to run any product live.")}
          {props.mode === "recorded" && "Replays a recorded engine run that matches the product name, or the scripted demo if none matches."}
          {props.mode === "scripted" && "A seeded diffusion run made in the browser. No models are called, so it always works and is labelled as a demo."}
        </p>

        <div className="w-engine">
          <button className="w-link" onClick={() => setShowEngine(!showEngine)}>
            {showEngine ? "Hide engine connection" : "Connect a local engine for real runs"}
          </button>
          {showEngine && (
            <div className="w-engine-row">
              <input
                className="w-input mono"
                placeholder="http://127.0.0.1:8787"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onBlur={() => saveEngineUrl(url)}
              />
              <span className="w-help">
                Run <code>pnpm --filter @market/engine serve</code> on your machine. It only listens on 127.0.0.1 and uses your own keys.
              </span>
            </div>
          )}
        </div>

        <div className="w-card-foot">
          {props.canResume && (
            <button className="w-btn" onClick={props.onResume}>
              Back to the town
            </button>
          )}
          <button
            className="w-btn launch"
            disabled={!valid}
            onClick={() => {
              saveEngineUrl(url);
              props.onLaunch();
            }}
          >
            Launch ▸
          </button>
        </div>
      </div>
    </div>
  );
}

function ProductForm({ title, value, onChange }: { title: string | null; value: WorldBriefInput; onChange: (p: Partial<WorldBriefInput>) => void }) {
  return (
    <div className="w-form">
      {title && <div className="w-form-title">{title}</div>}
      <label className="w-field">
        <span className="w-label">Product name</span>
        <input className="w-input big" value={value.name} maxLength={60} placeholder="e.g. Glowbrew smart mug" onChange={(e) => onChange({ name: e.target.value })} />
      </label>
      <div className="w-row">
        <label className="w-field">
          <span className="w-label">Price (USD)</span>
          <input className="w-input mono" type="number" min={0} step="any" value={Number.isFinite(value.price) ? value.price : ""} onChange={(e) => onChange({ price: e.target.value === "" ? NaN : Number(e.target.value) })} />
        </label>
        <label className="w-field">
          <span className="w-label">Billing</span>
          <select className="w-input" value={value.priceModel ?? "one_time"} onChange={(e) => onChange({ priceModel: e.target.value as PriceModel })}>
            {BILLING.map((b) => (
              <option key={b.id} value={b.id}>
                {b.label}
              </option>
            ))}
          </select>
        </label>
        <label className="w-field">
          <span className="w-label">Residents</span>
          <select className="w-input" value={value.population ?? 240} onChange={(e) => onChange({ population: Number(e.target.value) })} title="Used by scripted and engine runs; recorded runs keep their own size">
            {[120, 240, 500].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="w-field">
        <span className="w-label">What it does</span>
        <textarea className="w-input" rows={3} maxLength={400} value={value.description} placeholder="One or two sentences a customer would read." onChange={(e) => onChange({ description: e.target.value })} />
      </label>
    </div>
  );
}

// ── HUD ─────────────────────────────────────────────────────────────

function Hud({ town, compact, label }: { town: TownRun; compact: boolean; label: string | null }) {
  usePlayerVersion(town.player);
  const s = town.player.state;
  const c = countMoods(s);
  const total = s.brief?.rounds ?? 6;
  const mpr = s.brief?.monthsPerRound ?? 1;
  const obj = topObjection(s);
  const stage = currentStage(s);
  const verdict = s.status === "ok" ? verdictOf(s) : null;
  const [showNotes, setShowNotes] = useState(false);
  const src = town.source;

  return (
    <div className={`w-hud ${compact ? "compact" : ""}`}>
      <div className="w-hud-card">
        <div className="w-hud-top">
          {label && <span className="w-town-tag">{label}</span>}
          <span className="w-hud-name">{src?.displayName ?? town.input.name}</span>
          {src && (
            <button className={`w-badge ${src.kind}`} title={src.note} onClick={() => setShowNotes(!showNotes)}>
              {src.kind === "engine" ? "live engine" : src.kind === "recorded" ? "recorded run" : "scripted demo"}
            </button>
          )}
        </div>
        {(showNotes || (!src && town.notes.length === 0)) && (
          <div className="w-notes">
            {src ? <div>{src.note}</div> : <div>Finding a run…</div>}
            {town.notes.map((n, i) => (
              <div key={i} className="muted">{n}</div>
            ))}
          </div>
        )}
        <div className="w-round">
          {s.currentRound > 0 ? (
            <>
              <span className="w-round-big">Round {Math.min(s.currentRound, total)}</span>
              <span className="muted"> / {total} · month {Math.min(s.currentRound, total) * mpr}</span>
            </>
          ) : (
            <span className="muted">{s.status === "idle" ? "Waiting for the run…" : `Setting up: ${stage}`}</span>
          )}
          {s.currentRound > 0 && s.rounds.length >= total && s.status === "running" && <span className="muted"> · writing the report</span>}
        </div>
        <div className="w-counts">
          <Count color={MOOD_COLOR.adopt} sign="+" label="adopt" n={c.adopt} />
          <Count color={MOOD_COLOR.wait} sign="?" label="wait" n={c.wait} />
          <Count color={MOOD_COLOR.reject} sign="–" label="reject" n={c.reject} />
          <span className="w-count other" title="Not reached yet (unaware or only aware)">
            {c.other} <small>not reached</small>
          </span>
        </div>
        <MiniCurve state={s} />
        {obj && (
          <div className="w-objection">
            <span className="w-label">Top objection so far</span>
            <span>“{obj.text}”</span>
            <span className="muted mono"> ×{obj.count}</span>
          </div>
        )}
        {verdict && (
          <div className={`w-hud-verdict ${verdict.tone}`}>
            <strong>{verdict.headline}</strong> <span>{verdict.detail}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function currentStage(s: RunState): string {
  const order = ["ingest", "graph", "population", "network", "simulation"] as const;
  const running = order.find((k) => s.stages[k].status === "running");
  const names: Record<string, string> = { ingest: "reading the market", graph: "mapping segments", population: "moving residents in", network: "introducing neighbours", simulation: "starting" };
  return names[running ?? "ingest"];
}

function Count({ color, sign, label, n }: { color: string; sign: string; label: string; n: number }) {
  return (
    <span className="w-count">
      <span className="w-count-icon" style={{ background: color }}>{sign}</span>
      <strong className="mono">{n}</strong>
      <small>{label}</small>
    </span>
  );
}

function MiniCurve({ state }: { state: RunState }) {
  const W = 220;
  const H = 64;
  const total = state.brief?.rounds ?? 6;
  const mpr = state.brief?.monthsPerRound ?? 1;
  const pts = [{ month: 0, cumulative: 0 }, ...state.adoption.map((a) => ({ month: a.month, cumulative: a.cumulative }))];
  const pop = state.personas.size;
  if (state.currentRound > state.adoption.length && pop && state.status === "running") {
    pts.push({ month: Math.min(state.currentRound, total) * mpr, cumulative: countMoods(state).adopt / pop });
  }
  const bass = state.bass?.curve ?? [];
  const xMax = Math.max(total * mpr, bass.length ? bass[bass.length - 1].month : 0, 1);
  const yMax = Math.max(0.08, ...pts.map((p) => p.cumulative), ...bass.map((b) => b.cumulative)) * 1.15;
  const x = (m: number) => (m / xMax) * (W - 8) + 4;
  const y = (v: number) => H - 6 - (v / yMax) * (H - 14);
  const line = (arr: { month: number; cumulative: number }[]) => arr.map((p, i) => `${i ? "L" : "M"}${x(p.month).toFixed(1)},${y(p.cumulative).toFixed(1)}`).join(" ");
  const last = pts[pts.length - 1];
  return (
    <div className="w-curve">
      <div className="w-curve-head">
        <span className="w-label">Adoption</span>
        <span className="mono">{(last.cumulative * 100).toFixed(1)}%</span>
      </div>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Adoption curve">
        <line x1={4} x2={W - 4} y1={H - 6} y2={H - 6} className="w-curve-axis" />
        {bass.length > 0 && <path d={line(bass)} className="w-curve-bass" />}
        <path d={`${line(pts)} L${x(last.month)},${H - 6} L4,${H - 6} Z`} className="w-curve-fill" />
        <path d={line(pts)} className="w-curve-line" />
        <circle cx={x(last.month)} cy={y(last.cumulative)} r={3} className="w-curve-dot" />
      </svg>
      {bass.length > 0 && <div className="w-curve-legend muted">dashed: fitted 12-month Bass curve</div>}
    </div>
  );
}

// ── Selection panels ────────────────────────────────────────────────

function SelectionPanel({ player, selection, price, onClose }: { player: Player; selection: NonNullable<Selection>; price: number; onClose: () => void }) {
  usePlayerVersion(player);
  const s = player.state;
  return (
    <aside className="w-panel">
      <button className="w-btn icon ghost w-panel-close" onClick={onClose} aria-label="Close">×</button>
      {selection.kind === "agent" ? <AgentInfo state={s} id={selection.id} price={s.brief?.price.amount ?? price} /> : <HoodInfo state={s} id={selection.id} />}
    </aside>
  );
}

const STATE_LABEL: Record<string, string> = { unaware: "Hasn't heard of it", aware: "Heard of it", considering: "Thinking about it", adopted: "Adopted", rejected: "Said no" };

function AgentInfo({ state, id, price }: { state: RunState; id: string; price: number }) {
  const p = state.personas.get(id);
  const d = state.agentState.get(id);
  const history = state.decisions.get(id) ?? [];
  const seg = p ? state.nodes.get(p.segmentId) : undefined;
  const segIdx = hoodsOf(state).findIndex((n) => n.id === p?.segmentId);
  if (!p) return <div className="muted">This resident is not in the run.</div>;
  const mood = moodOf(d?.state);
  const wtp = d?.wtp ?? p.wtp;
  return (
    <div className="w-info">
      <div className="w-kicker" style={{ color: PALETTE[Math.max(0, segIdx) % PALETTE.length] }}>{seg?.label ?? p.segmentId}</div>
      <h2 className="w-info-title">{p.name}</h2>
      <div className="muted">
        {p.role} · {p.ageBand}
      </div>
      <div className={`w-state ${mood}`}>{STATE_LABEL[d?.state ?? "unaware"]}{d ? ` · round ${d.round}` : ""}</div>
      <div className="w-wtp">
        <div>
          <span className="w-label">Willing to pay</span>
          <strong className="mono">{money(wtp)}</strong>
        </div>
        <div>
          <span className="w-label">Price</span>
          <strong className="mono">{money(price)}</strong>
        </div>
        <div className={wtp >= price ? "pos" : "neg"}>{wtp >= price ? "fits" : `${Math.round((1 - wtp / Math.max(price, 0.01)) * 100)}% short`}</div>
      </div>
      {d?.comment && <blockquote className="w-quote">“{d.comment}”</blockquote>}
      {d?.reasoning && (
        <div className="w-block">
          <span className="w-label">Reasoning</span>
          <p>{d.reasoning}</p>
        </div>
      )}
      {d?.objection && (
        <div className="w-block">
          <span className="w-label">Objection</span>
          <p>{d.objection}</p>
        </div>
      )}
      {history.length > 0 && (
        <div className="w-block">
          <span className="w-label">By round</span>
          <div className="w-history">
            {history.map((h) => (
              <span key={h.round} className={`w-hist ${moodOf(h.state)}`} title={`Round ${h.round}: ${STATE_LABEL[h.state]}`}>
                {h.round}
              </span>
            ))}
          </div>
        </div>
      )}
      {d && d.influencedBy.length > 0 && <div className="muted small">Heard about it from {d.influencedBy.map((x) => state.personas.get(x)?.name ?? x).join(", ")}.</div>}
      {!d && <p className="muted">{p.bio}</p>}
    </div>
  );
}

function HoodInfo({ state, id }: { state: RunState; id: string }) {
  const node = state.nodes.get(id);
  const c = countMoods(state, id);
  const obj = topObjection(state, id);
  const idx = hoodsOf(state).findIndex((n) => n.id === id);
  const wtps = [...state.personas.values()].filter((p) => p.segmentId === id).map((p) => state.agentState.get(p.id)?.wtp ?? p.wtp);
  const avg = wtps.length ? wtps.reduce((a, b) => a + b, 0) / wtps.length : 0;
  const bar = (n: number) => `${c.total ? (n / c.total) * 100 : 0}%`;
  return (
    <div className="w-info">
      <div className="w-kicker" style={{ color: PALETTE[Math.max(0, idx) % PALETTE.length] }}>Neighbourhood</div>
      <h2 className="w-info-title">{node?.label ?? id}</h2>
      {node?.summary && <p className="w-summary">{node.summary}</p>}
      <div className="w-bar" aria-label="Adoption mix">
        <span style={{ width: bar(c.adopt), background: MOOD_COLOR.adopt }} />
        <span style={{ width: bar(c.wait), background: MOOD_COLOR.wait }} />
        <span style={{ width: bar(c.reject), background: MOOD_COLOR.reject }} />
      </div>
      <div className="w-counts">
        <Count color={MOOD_COLOR.adopt} sign="+" label="adopt" n={c.adopt} />
        <Count color={MOOD_COLOR.wait} sign="?" label="wait" n={c.wait} />
        <Count color={MOOD_COLOR.reject} sign="–" label="reject" n={c.reject} />
      </div>
      <div className="w-wtp">
        <div>
          <span className="w-label">Residents</span>
          <strong className="mono">{c.total}</strong>
        </div>
        <div>
          <span className="w-label">Adopted</span>
          <strong className="mono">{c.total ? Math.round((c.adopt / c.total) * 100) : 0}%</strong>
        </div>
        <div>
          <span className="w-label">Avg. willing to pay</span>
          <strong className="mono">{money(avg)}</strong>
        </div>
      </div>
      {obj && (
        <div className="w-block">
          <span className="w-label">Top objection here</span>
          <p>“{obj.text}” <span className="muted mono">×{obj.count}</span></p>
        </div>
      )}
    </div>
  );
}

// ── WebGL guard ─────────────────────────────────────────────────────

class WorldBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(err: Error) {
    return { error: err.message };
  }
  render() {
    if (this.state.error)
      return (
        <div className="w-fallback">
          <strong>The 3D town could not start here.</strong>
          <span className="muted">{this.state.error}. The run keeps playing and the HUD, counts and report still work.</span>
        </div>
      );
    return this.props.children;
  }
}
