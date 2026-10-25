import { applyEvent, emptyState, parseJsonl, type EventEnvelope, type RunState } from "@market/core";

export interface RunEntry {
  id: string;
  file: string;
  label: string;
  kind: "simulation" | "backtest" | "market_backtest";
  mode: string;
  createdAt: string;
}

const MAX_GAP_MS = 3000;

type Listener = () => void;

/**
 * Feeds a run's events into the shared fold. Two modes:
 *  - replay: a recorded JSONL log played back on a virtual clock at any speed,
 *    with long idle gaps (slow model calls) compressed so replays stay watchable;
 *  - live: envelopes pushed in as they arrive from SpacetimeDB.
 * Either way the UI sees the same RunState.
 */
export class Player {
  state: RunState = emptyState();
  version = 0;
  envs: EventEnvelope[] = [];
  /** Compressed playback offset (ms) of each envelope. */
  private at: number[] = [];
  idx = 0;
  vt = 0;
  speed = 4;
  playing = false;
  live = false;
  private listeners = new Set<Listener>();
  private raf = 0;
  private last = 0;
  private notifyQueued = false;

  subscribe = (l: Listener) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  getVersion = () => this.version;

  private notify() {
    if (this.notifyQueued) return;
    this.notifyQueued = true;
    requestAnimationFrame(() => {
      this.notifyQueued = false;
      this.version++;
      for (const l of this.listeners) l();
    });
  }

  get duration() {
    return this.at.length ? this.at[this.at.length - 1] : 0;
  }
  get progress() {
    return this.live ? 1 : this.duration ? Math.min(1, this.vt / this.duration) : 0;
  }

  load(envs: EventEnvelope[], { autoplay = true } = {}) {
    this.stop();
    this.live = false;
    this.open = false;
    this.envs = envs;
    this.at = [];
    let t = 0;
    for (let i = 0; i < envs.length; i++) {
      if (i > 0) t += Math.min(MAX_GAP_MS, Math.max(0, envs[i].ts - envs[i - 1].ts));
      this.at.push(t);
    }
    this.reset();
    if (autoplay) this.play();
    else this.notify();
  }

  /** Jumps to the end immediately (e.g. "show final results"). */
  finish() {
    this.seek(1);
    this.pause();
  }

  private reset() {
    this.state = emptyState();
    this.idx = 0;
    this.vt = 0;
  }

  play() {
    if (this.live || this.playing) return;
    if (this.idx >= this.envs.length && !this.open) this.reset();
    this.playing = true;
    this.last = performance.now();
    const loop = (now: number) => {
      if (!this.playing) return;
      this.advance((now - this.last) * this.speed);
      this.last = now;
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
    this.notify();
  }

  pause() {
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.notify();
  }

  private stop() {
    this.playing = false;
    cancelAnimationFrame(this.raf);
  }

  setSpeed(s: number) {
    this.speed = s;
    this.notify();
  }

  seek(fraction: number) {
    const target = fraction * this.duration;
    if (target < this.vt) this.reset();
    this.vt = target;
    while (this.idx < this.envs.length && this.at[this.idx] <= this.vt) applyEvent(this.state, this.envs[this.idx++]);
    this.notify();
  }

  private advance(dt: number) {
    this.vt += dt;
    if (this.open) this.vt = Math.min(this.vt, this.duration);
    let n = 0;
    while (this.idx < this.envs.length && this.at[this.idx] <= this.vt) {
      applyEvent(this.state, this.envs[this.idx++]);
      n++;
    }
    if (this.idx >= this.envs.length && !this.open) this.pause();
    if (n) this.notify();
  }

  // ── Streamed replay: events arrive over time but keep the replay clock ──
  private open = false;
  /** Starts an empty replay that grows with `append`; speed and seek still apply. */
  beginStream() {
    this.load([], { autoplay: false });
    this.open = true;
    this.play();
  }
  append(env: EventEnvelope) {
    const n = this.envs.length;
    const t = n ? this.at[n - 1] + Math.min(MAX_GAP_MS, Math.max(0, env.ts - this.envs[n - 1].ts)) : 0;
    this.envs.push(env);
    this.at.push(t);
  }
  endStream() {
    this.open = false;
  }
  get streaming() {
    return this.open;
  }

  // ── Live (SpacetimeDB) ──────────────────────────────────────────
  private pending = new Map<number, EventEnvelope>();
  startLive() {
    this.stop();
    this.live = true;
    this.envs = [];
    this.at = [];
    this.pending.clear();
    this.reset();
    this.notify();
  }
  push(env: EventEnvelope) {
    if (env.event.type === "run.started") {
      this.reset();
      this.pending.clear();
      this.idx = env.seq;
    }
    this.pending.set(env.seq, env);
    // Apply strictly in sequence; rows can arrive out of order.
    let next = this.pending.get(this.idx);
    while (next) {
      this.pending.delete(this.idx);
      applyEvent(this.state, next);
      this.envs.push(next);
      this.idx++;
      next = this.pending.get(this.idx);
    }
    this.notify();
  }
}

export async function fetchRuns(): Promise<RunEntry[]> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}runs/index.json`, { cache: "no-store" });
    if (!res.ok) return [];
    return (await res.json()) as RunEntry[];
  } catch {
    return [];
  }
}

export async function fetchRun(entry: RunEntry): Promise<EventEnvelope[]> {
  const res = await fetch(`${import.meta.env.BASE_URL}runs/${entry.file}`, { cache: "no-store" });
  return parseJsonl(await res.text());
}

export async function loadLocalFile(file: File): Promise<EventEnvelope[]> {
  return parseJsonl(await file.text());
}
