import { useRef, useSyncExternalStore } from "react";
import { useFrame } from "@react-three/fiber";
import type { AdoptionState, EventEnvelope, RunState } from "@market/core";
import type { Player } from "../lib/player";

/** Re-renders only when the selected primitive changes, not on every event. */
export function usePlayerKey<T extends string | number | boolean | null>(player: Player, select: (s: RunState) => T): T {
  return useSyncExternalStore(player.subscribe, () => select(player.state));
}

/** Re-renders on every player notification (at most once per frame). For DOM HUDs. */
export function usePlayerVersion(player: Player): number {
  return useSyncExternalStore(player.subscribe, player.getVersion);
}

/**
 * Calls `onEvent` for every envelope the player has applied since the last
 * frame, so effects (icon pops, pulses, bubbles) follow the real log. Large
 * jumps (seek, skip to end) are applied silently instead of firing hundreds
 * of effects at once.
 */
export function useEventFeed(player: Player, onEvent: (env: EventEnvelope, t: number) => void, onReset?: () => void) {
  const cursor = useRef(0);
  const envs = useRef<EventEnvelope[] | null>(null);
  useFrame(({ clock }) => {
    if (player.envs !== envs.current || player.idx < cursor.current) {
      envs.current = player.envs;
      cursor.current = 0;
      onReset?.();
    }
    const end = player.idx;
    if (end - cursor.current > 400) {
      cursor.current = end;
      return;
    }
    const t = clock.elapsedTime;
    for (; cursor.current < end; cursor.current++) onEvent(player.envs[cursor.current], t);
  });
}

export type Mood = "adopt" | "wait" | "reject" | "none";

export function moodOf(s: AdoptionState | undefined): Mood {
  return s === "adopted" ? "adopt" : s === "considering" ? "wait" : s === "rejected" ? "reject" : "none";
}

export interface Counts {
  adopt: number;
  wait: number;
  reject: number;
  other: number;
  total: number;
}

export function countMoods(state: RunState, segmentId?: string): Counts {
  const c: Counts = { adopt: 0, wait: 0, reject: 0, other: 0, total: 0 };
  for (const p of state.personas.values()) {
    if (segmentId && p.segmentId !== segmentId) continue;
    c.total++;
    const m = moodOf(state.agentState.get(p.id)?.state);
    if (m === "none") c.other++;
    else c[m]++;
  }
  return c;
}

function normaliseObjection(s: string): string {
  return s.trim().replace(/[.!]+$/, "");
}

/** Most frequent objection among agents' latest decisions. */
export function topObjection(state: RunState, segmentId?: string): { text: string; count: number } | null {
  const counts = new Map<string, { text: string; count: number }>();
  for (const d of state.agentState.values()) {
    if (!d.objection || d.state === "adopted") continue;
    if (segmentId && state.personas.get(d.agentId)?.segmentId !== segmentId) continue;
    const text = normaliseObjection(d.objection);
    const k = text.toLowerCase();
    const cur = counts.get(k) ?? { text, count: 0 };
    cur.count++;
    counts.set(k, cur);
  }
  let best: { text: string; count: number } | null = null;
  for (const v of counts.values()) if (!best || v.count > best.count) best = v;
  return best;
}

export function verdictOf(state: RunState): { headline: string; tone: "pos" | "warn" | "neg"; detail: string } | null {
  const b = state.bass;
  if (!b) return null;
  const m = b.m;
  const headline = m > 0.25 ? "Strong launch" : m > 0.1 ? "Moderate launch" : "Slow launch";
  const tone = m > 0.25 ? "pos" : m > 0.1 ? "warn" : "neg";
  const be = state.finance ? (state.finance.breakEvenMonth ? `Break-even month ${state.finance.breakEvenMonth}` : "No break-even within 12 months") : "Finance pending";
  return { headline, tone, detail: `${(m * 100).toFixed(1)}% eventual adoption · ${be}` };
}
