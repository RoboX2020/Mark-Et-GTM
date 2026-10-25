import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { PriceModel, RunState } from "@market/core";
import { Player } from "../lib/player";
import { useNav, useRun } from "../lib/context";
import { Town, MOOD_COLOR, PALETTE, hoodsOf, type Selection } from "./Town";
import { compact as compactNum, countMoods, moodOf, narrate, segmentStats, topObjection, usePlayersVersion, usePlayerVersion, verdictOf } from "./useWorld";
import { BarGroup } from "../components/Bars";
import { OUTCOME_TONE, outcomeFor } from "../lib/outcomes";
import { engineUrl, PRESETS, resolveSource, saveEngineUrl, type RunSource, type SourceMode } from "./sources";
import { scriptedRun, type WorldBriefInput } from "./scriptedRun";
import "./world.css";

const SPEEDS = [0.5, 1, 2, 4, 8];
/** Outside the social rounds (ingest, interviews, report writing) the world fast-forwards. */
const BOOST = 40;
/** Real milliseconds the town holds after residents move in, so the launch reads as a moment. */
const INTRO_MS = 2600;

/**
 * Plays the social rounds at the chosen speed and fast-forwards everything
 * else (reading the market, interviews, report writing), with a short hold
 * before round 1 for the launch.
 */
function withPacing(player: Player): Player {
  let seen: RunState | null = null;
  let introEnd = 0;
  player.boost = (s) => {
    if (s !== seen) {
      seen = s;
      introEnd = 0;
    }
    const total = s.brief?.rounds ?? 6;
    if (s.currentRound > 0 && s.rounds.length < total) return 1;
    if (s.currentRound === 0 && s.personas.size && s.stages.population.status === "done") {
      if (!introEnd) introEnd = performance.now() + INTRO_MS;
      if (performance.now() < introEnd) return 0;
    }
    return BOOST;
  };
  return player;
}

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

  function launch() {
    towns.forEach(stopTown);
    const inputs = compare ? forms : [forms[0]];
    const next = inputs.map((input) => ({
      key: ++keyRef.current,
      input: { ...input, name: input.name.trim() || "Your product" },
      player: withPacing(new Player()),
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

  useEffect(() => {
    for (const t of towns) t.player.setSpeed(speed);
  }, [towns, speed]);

  const allPlaying = usePlayingFlag(towns);
  const players = useMemo(() => towns.map((t) => t.player), [towns]);

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
                    compact={towns.length > 1}
                  />
                </WorldBoundary>
                <Caption player={t.player} compact={towns.length > 1} />
                <Hud
                  town={t}
                  peers={players}
                  compact={towns.length > 1}
                  label={towns.length > 1 ? (i === 0 ? "Town A" : "Town B") : null}
                  onHood={(id) => setSelections((cur) => cur.map((c, j) => (j === i ? { kind: "hood", id } : c)))}
                />
                {!selections[i] && <ResultPanel town={t} compact={towns.length > 1} onOpenReport={() => openReport(t)} />}
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
          {towns.length > 1 && <HeadToHead towns={towns} />}
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
  const [active, setActive] = useState<0 | 1>(0);
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
          <span className="w-label">{compare ? `Try in Town ${active === 0 ? "A" : "B"}` : "Try"}</span>
          {PRESETS.map((p) => (
            <button key={p.tag} className="w-chip" onClick={() => set(compare ? active : 0, { name: p.name, price: p.price, description: p.description, priceModel: p.priceModel ?? "one_time" })}>
              {p.tag}
            </button>
          ))}
        </div>

        <div className={`w-forms ${compare ? "two" : ""}`}>
          {(compare ? [0, 1] : [0]).map((i) => (
            <ProductForm
              key={i}
              title={compare ? (i === 0 ? "Town A" : "Town B") : null}
              active={compare && active === i}
              onFocus={() => setActive(i as 0 | 1)}
              value={forms[i]}
              onChange={(p) => set(i as 0 | 1, p)}
            />
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

function ProductForm({
  title,
  active,
  onFocus,
  value,
  onChange,
}: {
  title: string | null;
  active: boolean;
  onFocus: () => void;
  value: WorldBriefInput;
  onChange: (p: Partial<WorldBriefInput>) => void;
}) {
  return (
    <div className={`w-form ${active ? "active" : ""}`} onFocusCapture={onFocus} onClick={onFocus}>
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

function Hud({ town, peers, compact, label, onHood }: { town: TownRun; peers: Player[]; compact: boolean; label: string | null; onHood: (id: string) => void }) {
  usePlayersVersion(peers);
  const s = town.player.state;
  const c = countMoods(s);
  const total = s.brief?.rounds ?? 6;
  const mpr = s.brief?.monthsPerRound ?? 1;
  const stage = currentStage(s);
  const [showNotes, setShowNotes] = useState(false);
  const src = town.source;
  const hoods = hoodsOf(s);
  const stats = segmentStats(s, hoods);
  const yMax = sharedCurveMax(peers.map((p) => p.state));

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
              <span className="w-round-big">Month {Math.min(s.currentRound, total) * mpr}</span>
              <span className="muted"> · round {Math.min(s.currentRound, total)} of {total}</span>
            </>
          ) : (
            <span className="muted">{s.status === "idle" ? "Waiting for the run…" : `Setting up: ${stage}`}</span>
          )}
        </div>
        <div className="w-counts">
          <Count color={MOOD_COLOR.adopt} sign="+" label="bought" n={c.adopt} />
          <Count color={MOOD_COLOR.wait} sign="?" label="thinking" n={c.wait} />
          <Count color={MOOD_COLOR.reject} sign="–" label="said no" n={c.reject} />
          <span className="w-count other" title="Has not heard of it yet, or only just heard">
            {c.other} <small>not reached</small>
          </span>
        </div>
        <MiniCurve state={s} yMax={yMax} shared={peers.length > 1} />
        {stats.length > 0 && (
          <div className="w-who">
            <div className="w-who-head">
              <span className="w-label">Who's buying, by customer group</span>
              <span className="w-label">bought</span>
            </div>
            {[...stats]
              .sort((x, y) => y.counts.adopt / Math.max(1, y.counts.total) - x.counts.adopt / Math.max(1, x.counts.total))
              .map((g) => {
                const idx = hoods.findIndex((h) => h.id === g.id);
                const w = (n: number) => `${g.counts.total ? (n / g.counts.total) * 100 : 0}%`;
                return (
                  <button key={g.id} className="w-who-row" onClick={() => onHood(g.id)} title={g.objection ? `Top objection: ${g.objection}` : g.label}>
                    <span className="w-who-swatch" style={{ background: PALETTE[idx % PALETTE.length] }} />
                    <span className="w-who-name">{g.label}</span>
                    <span className="w-who-bar">
                      <i style={{ width: w(g.counts.adopt), background: MOOD_COLOR.adopt }} />
                      <i style={{ width: w(g.counts.wait), background: MOOD_COLOR.wait }} />
                      <i style={{ width: w(g.counts.reject), background: MOOD_COLOR.reject }} />
                    </span>
                    <span className="w-who-n mono">
                      {g.counts.adopt}/{g.counts.total}
                      {g.fresh > 0 && s.status === "running" && <em> +{g.fresh}</em>}
                    </span>
                  </button>
                );
              })}
          </div>
        )}
        {!compact && (
          <div className="w-legend">
            <span><i className="w-count-icon" style={{ background: MOOD_COLOR.adopt }}>+</i> bought</span>
            <span><i className="w-count-icon" style={{ background: MOOD_COLOR.wait }}>?</i> thinking</span>
            <span><i className="w-count-icon" style={{ background: MOOD_COLOR.reject }}>–</i> said no</span>
            <span><i className="w-legend-arc" /> word of mouth</span>
            <span><i className="w-legend-group" /> body colour = customer group</span>
          </div>
        )}
      </div>
    </div>
  );
}

/** Plain-language caption of what is happening right now, at the top of each town. */
function Caption({ player, compact }: { player: Player; compact: boolean }) {
  usePlayerVersion(player);
  const s = player.state;
  const n = narrate(s, segmentStats(s, hoodsOf(s)));
  const v = s.status === "ok" ? verdictOf(s) : null;
  if (v && compact) return null;
  return (
    <div className={`w-caption ${compact ? "compact" : ""} ${v ? v.tone : ""}`} aria-live="polite">
      <strong>{n.title}</strong>
      <span>{n.body}</span>
    </div>
  );
}

/** End of run: what the simulation concluded, and what really happened to this product. */
function ResultPanel({ town, compact, onOpenReport }: { town: TownRun; compact: boolean; onOpenReport: () => void }) {
  usePlayerVersion(town.player);
  const s = town.player.state;
  const v = s.status === "ok" ? verdictOf(s) : null;
  const [open, setOpen] = useState(true);
  if (!v) return null;
  const outcome = outcomeFor(s.backtestCaseId, town.source?.displayName ?? town.input.name);
  const actual = s.backtest?.actual.at(-1);
  if (!open)
    return (
      <button className="w-btn w-result-reopen" onClick={() => setOpen(true)}>
        Show result
      </button>
    );
  return (
    <aside className={`w-result ${compact ? "compact" : ""}`}>
      <button className="w-btn icon ghost w-panel-close" onClick={() => setOpen(false)} aria-label="Hide result">×</button>
      <div className={`w-result-block ${v.tone}`}>
        <span className="w-label">Simulation verdict</span>
        <strong>{v.headline}</strong>
        <span>{v.detail}</span>
        {v.report && !compact && <q>{v.report}</q>}
      </div>
      {outcome ? (
        <div className={`w-result-block real ${OUTCOME_TONE[outcome.verdict]}`}>
          <span className="w-label">What actually happened</span>
          <strong>{outcome.headline}</strong>
          <div className="w-result-nums">
            <div>
              <b className="mono">{outcome.units >= 1e6 ? `${outcome.units / 1e6}M+` : `≈${Math.round(outcome.units / 1000)}k`}</b>
              <small>units sold</small>
            </div>
            <div>
              <b className="mono">${compact_(outcome.revenue)}</b>
              <small>{outcome.revenueNote.includes("estimate") ? "revenue (est.)" : "lifetime revenue"}</small>
            </div>
            {actual && (
              <div>
                <b className="mono">{Math.round(actual.cumulative * 100)}%</b>
                <small>of target market by month {actual.month}</small>
              </div>
            )}
          </div>
          {!compact && (
            <ul>
              {outcome.facts.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          )}
          {!compact && <span className="w-result-src">{outcome.sources}</span>}
        </div>
      ) : (
        <div className="w-result-block muted-block">
          <span className="w-label">Real world</span>
          <span>This product has no recorded real launch to compare with. Try Humane Ai Pin, Ray-Ban Meta or Rabbit R1 to see a forecast next to what happened.</span>
        </div>
      )}
      <button className="w-btn" onClick={onOpenReport}>Open full report</button>
    </aside>
  );
}

const compact_ = compactNum;

/** Side-by-side mode: both towns on one shared scale per measure. */
function HeadToHead({ towns }: { towns: TownRun[] }) {
  const players = useMemo(() => towns.map((t) => t.player), [towns]);
  usePlayersVersion(players);
  const [open, setOpen] = useState(true);
  const done = towns.every((t) => t.player.state.status === "ok");
  if (!done) return null;
  if (!open)
    return (
      <button className="w-btn w-h2h-reopen" onClick={() => setOpen(true)}>
        Compare A vs B
      </button>
    );
  const rows = towns.map((t, i) => {
    const s = t.player.state;
    const v = verdictOf(s);
    return {
      name: `${i === 0 ? "A" : "B"} · ${(t.source?.displayName ?? t.input.name).replace(/ smart glasses$/i, "")}`,
      color: i === 0 ? "var(--c-a)" : "var(--c-b)",
      v,
      revenue: s.finance?.totalRevenue12 ?? null,
      outcome: outcomeFor(s.backtestCaseId, t.source?.displayName ?? t.input.name),
    };
  });
  const usd = (n: number) => `${n < 0 ? "−" : ""}$${compactNum(Math.abs(n))}`;
  const bothReal = rows.every((r) => r.outcome);
  return (
    <div className="w-h2h">
      <div className="w-h2h-head">
        <span className="w-kicker">Head to head · same scale</span>
        <button className="w-btn icon ghost" onClick={() => setOpen(false)} aria-label="Hide comparison">×</button>
      </div>
      <div className="w-h2h-grid">
        <BarGroup title="Bought by the last round" fmt={(x) => `${Math.round(x * 100)}%`} rows={rows.map((r) => ({ label: r.name, value: r.v?.observed ?? null, color: r.color }))} />
        <BarGroup title="Simulated 12-month revenue" fmt={usd} rows={rows.map((r) => ({ label: r.name, value: r.revenue, color: r.color }))} />
        <BarGroup
          title="Simulated 12-month profit"
          fmt={usd}
          rows={rows.map((r) => ({ label: r.name, value: r.v?.profit12 ?? null, color: r.color, text: r.v?.profit12 == null ? undefined : `${usd(r.v.profit12)}${r.v.breakEven ? ` · pays back m${r.v.breakEven}` : " · never pays back"}` }))}
        />
        {bothReal && (
          <BarGroup title="Real revenue" fmt={usd} rows={rows.map((r) => ({ label: `${r.name} · ${r.outcome!.verdict}`, value: r.outcome!.revenue, color: r.color }))} />
        )}
      </div>
    </div>
  );
}

function sharedCurveMax(states: RunState[]): number {
  let m = 0.08;
  for (const st of states) {
    const pop = st.personas.size;
    for (const a of st.adoption) m = Math.max(m, a.cumulative);
    for (const b of st.bass?.curve ?? []) m = Math.max(m, b.cumulative);
    for (const a of st.backtest?.actual ?? []) m = Math.max(m, a.cumulative);
    if (pop) m = Math.max(m, countMoods(st).adopt / pop);
  }
  return Math.min(1, Math.ceil((m * 1.12) / 0.05) * 0.05);
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

function MiniCurve({ state, yMax, shared }: { state: RunState; yMax: number; shared: boolean }) {
  const W = 260;
  const H = 86;
  const L = 30;
  const total = state.brief?.rounds ?? 6;
  const mpr = state.brief?.monthsPerRound ?? 1;
  const pts = [{ month: 0, cumulative: 0 }, ...state.adoption.map((a) => ({ month: a.month, cumulative: a.cumulative }))];
  const pop = state.personas.size;
  if (state.currentRound > state.adoption.length && pop && state.status === "running") {
    pts.push({ month: Math.min(state.currentRound, total) * mpr, cumulative: countMoods(state).adopt / pop });
  }
  const bass = state.bass?.curve ?? [];
  const actual = state.backtest?.actual ?? [];
  const xMax = 12;
  const x = (m: number) => L + (Math.min(m, xMax) / xMax) * (W - L - 6);
  const y = (v: number) => H - 14 - (Math.min(v, yMax) / yMax) * (H - 22);
  const line = (arr: { month: number; cumulative: number }[]) => arr.filter((p) => p.month <= xMax).map((p, i) => `${i ? "L" : "M"}${x(p.month).toFixed(1)},${y(p.cumulative).toFixed(1)}`).join(" ");
  const last = pts[pts.length - 1];
  const ticks = [0, yMax / 2, yMax];
  return (
    <div className="w-curve">
      <div className="w-curve-head">
        <span className="w-label">Share who bought{shared ? " · same scale as other town" : ""}</span>
        <span className="mono">{(last.cumulative * 100).toFixed(0)}%</span>
      </div>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Adoption curve">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={L} x2={W - 6} y1={y(t)} y2={y(t)} className="w-curve-grid" />
            <text x={L - 4} y={y(t) + 3} className="w-curve-tick" textAnchor="end">{Math.round(t * 100)}%</text>
          </g>
        ))}
        {[3, 6, 9, 12].map((m) => (
          <text key={m} x={x(m)} y={H - 2} className="w-curve-tick" textAnchor="middle">{m === 12 ? "12 mo" : m}</text>
        ))}
        {bass.length > 0 && <path d={line(bass)} className="w-curve-bass" />}
        <path d={`${line(pts)} L${x(last.month)},${y(0)} L${x(0)},${y(0)} Z`} className="w-curve-fill" />
        <path d={line(pts)} className="w-curve-line" />
        <circle cx={x(last.month)} cy={y(last.cumulative)} r={3} className="w-curve-dot" />
        {actual.length > 0 && (
          <>
            <path d={line([{ month: 0, cumulative: 0 }, ...actual])} className="w-curve-actual" />
            {actual.map((a) => (
              <rect key={a.month} x={x(a.month) - 3} y={y(a.cumulative) - 3} width={6} height={6} className="w-curve-actual-pt" />
            ))}
          </>
        )}
      </svg>
      <div className="w-curve-legend">
        <span><i className="sim" /> simulated</span>
        {bass.length > 0 && <span><i className="fit" /> 12-month forecast</span>}
        {actual.length > 0 && <span><i className="real" /> real world</span>}
      </div>
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
      <div className={`w-state ${mood}`}>{STATE_LABEL[d?.state ?? "unaware"]}{d && d.round > 0 ? ` · round ${d.round}` : ""}</div>
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
      {!d?.reasoning && <p className="w-summary">{p.bio}</p>}
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
