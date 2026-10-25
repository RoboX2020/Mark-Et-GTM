import { useCallback, useRef, useSyncExternalStore } from "react";
import { useFrame } from "@react-three/fiber";
import type { EventEnvelope, RunState } from "@market/core";
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

/** Re-renders when any of several players changes, for views that compare towns. */
export function usePlayersVersion(players: Player[]): number {
  const subscribe = useCallback(
    (cb: () => void) => {
      const offs = players.map((p) => p.subscribe(cb));
      return () => offs.forEach((o) => o());
    },
    [players],
  );
  return useSyncExternalStore(subscribe, () => players.reduce((a, p) => a + p.getVersion(), 0));
}

export * from "../lib/verdict";
