import { createContext, useContext, useSyncExternalStore } from "react";
import type { RunState } from "@market/core";
import type { Player } from "./player";

export type TabId = "overview" | "graph" | "agents" | "interviews" | "forecast" | "report" | "backtest" | "evidence";

export interface Nav {
  tab: TabId;
  setTab: (t: TabId) => void;
  openAgent: (id: string) => void;
  openEvidence: (id: string) => void;
  selectedAgent: string | null;
  setSelectedAgent: (id: string | null) => void;
}

export const PlayerCtx = createContext<Player | null>(null);
export const NavCtx = createContext<Nav | null>(null);

export interface DateFilter {
  /** Inclusive YYYY-MM-DD. Evidence after this date is hidden. */
  through: string;
  setThrough: (day: string) => void;
  /** The run's pre-launch cutoff. The forecast was computed at this date. */
  cutoff: string;
}

export const DateCtx = createContext<DateFilter | null>(null);

/** Subscribes a component to the run state; re-renders at most once per frame. */
export function useRun(): { state: RunState; player: Player; version: number } {
  const player = useContext(PlayerCtx)!;
  const version = useSyncExternalStore(player.subscribe, player.getVersion);
  return { state: player.state, player, version };
}

export function useNav(): Nav {
  return useContext(NavCtx)!;
}

export function useDateFilter(): DateFilter {
  return useContext(DateCtx)!;
}
