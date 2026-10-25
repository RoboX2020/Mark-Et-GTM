import type { EventEnvelope } from "@market/core";
import { fetchRun, fetchRuns, type RunEntry } from "../lib/player";
import { scriptedBrief, scriptedRun, type WorldBriefInput } from "./scriptedRun";

export type SourceMode = "auto" | "recorded" | "scripted";

export type SourceKind = "engine" | "recorded" | "scripted";

export interface RunSource {
  kind: SourceKind;
  /** Shown on the tower and in the HUD. */
  displayName: string;
  /** One line explaining where the events come from. */
  note: string;
  /** Recorded and scripted runs arrive whole. */
  envs?: EventEnvelope[];
  /** Engine runs stream; call to start polling. Resolves when the run completes or fails. */
  stream?: (push: (env: EventEnvelope) => void, signal: AbortSignal) => Promise<void>;
}

const GENERIC = new Set(["live", "models", "claude", "gemini", "smart", "the", "app", "demo", "offline", "mock", "smoke", "your", "keys", "backtest", "product"]);

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !GENERIC.has(t));
}

/** Finds a recorded run whose product name overlaps the typed one ("meta" → Ray-Ban Meta glasses). */
export function matchRecorded(runs: RunEntry[], name: string): RunEntry | undefined {
  const want = tokens(name);
  if (!want.length) return undefined;
  let best: { entry: RunEntry; score: number } | undefined;
  for (const entry of runs) {
    if (entry.kind === "market_backtest") continue;
    const have = tokens(entry.label.split("·")[0]);
    const score = want.filter((t) => have.some((h) => h === t || (t.length >= 4 && h.startsWith(t)) || (h.length >= 4 && t.startsWith(h)))).length;
    const bonus = (entry.mode === "live" ? 0.5 : 0) - (/smoke/i.test(entry.label) ? 0.4 : 0);
    if (score && (!best || score + bonus > best.score)) best = { entry, score: score + bonus };
  }
  return best?.entry;
}

export function engineUrl(): string {
  try {
    const saved = localStorage.getItem("world.engineUrl");
    if (saved !== null) return saved.trim();
  } catch {
    /* private mode */
  }
  return (import.meta.env.VITE_ENGINE_URL ?? "").trim();
}

export function saveEngineUrl(url: string) {
  try {
    localStorage.setItem("world.engineUrl", url.trim());
  } catch {
    /* private mode */
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    t = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(t);
  }
}

/** Starts a run on a local engine (`pnpm --filter @market/engine serve`) and streams its events. */
async function engineSource(base: string, input: WorldBriefInput): Promise<RunSource> {
  const root = base.replace(/\/$/, "");
  const brief = scriptedBrief(input);
  const res = await withTimeout(
    fetch(`${root}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        product: { name: brief.product.name, description: brief.product.description },
        price: { amount: brief.price.amount, model: brief.price.model },
        population: Math.min(brief.population, 200),
      }),
    }),
    6000,
    "engine",
  );
  if (!res.ok) throw new Error(`engine ${res.status}: ${(await res.text()).slice(0, 120)}`);
  const { runId, mode } = (await res.json()) as { runId: string; mode: string };
  return {
    kind: "engine",
    displayName: brief.product.name,
    note: `Real engine run (${mode} mode) streaming from ${root}`,
    stream: async (push, signal) => {
      let from = 0;
      let idle = 0;
      while (!signal.aborted) {
        const r = await fetch(`${root}/runs/${encodeURIComponent(runId)}/events?from=${from}`, { signal });
        if (!r.ok) throw new Error(`engine ${r.status}`);
        const body = (await r.json()) as { events: EventEnvelope[]; done: boolean; error?: string };
        for (const env of body.events) push(env);
        from += body.events.length;
        idle = body.events.length ? 0 : idle + 1;
        if (body.done && body.error) throw new Error(body.error);
        if (body.done) return;
        if (idle > 600) throw new Error("engine stopped sending events");
        await new Promise((ok) => setTimeout(ok, body.events.length ? 250 : 1000));
      }
    },
  };
}

export interface ResolveResult {
  source: RunSource;
  /** Earlier sources that were tried and why they were skipped. */
  fallbacks: string[];
}

export async function resolveSource(input: WorldBriefInput, mode: SourceMode): Promise<ResolveResult> {
  const fallbacks: string[] = [];
  const url = engineUrl();
  if (mode === "auto" && url) {
    try {
      return { source: await engineSource(url, input), fallbacks };
    } catch (err) {
      fallbacks.push(`Engine at ${url} unavailable (${(err as Error).message}).`);
    }
  } else if (mode === "auto") {
    fallbacks.push("No engine connected, so a recorded run is used when one matches.");
  }

  if (mode !== "scripted") {
    try {
      const runs = await withTimeout(fetchRuns(), 5000, "run catalogue");
      const hit = matchRecorded(runs, input.name);
      if (hit) {
        const envs = await withTimeout(fetchRun(hit), 12000, "recorded run");
        if (envs.length) {
          const realName = hit.label.split("·")[0].trim();
          return {
            source: { kind: "recorded", displayName: realName, note: `Recorded run: ${hit.label} (${hit.mode} mode)`, envs },
            fallbacks,
          };
        }
      }
      fallbacks.push(`No recorded run matches "${input.name}".`);
    } catch (err) {
      fallbacks.push(`Recorded runs unavailable (${(err as Error).message}).`);
    }
  }

  return {
    source: {
      kind: "scripted",
      displayName: input.name.trim() || "Your product",
      note: "Scripted demo: seeded diffusion, no models called",
      envs: scriptedRun(input),
    },
    fallbacks,
  };
}

export const PRESETS: (WorldBriefInput & { tag: string })[] = [
  {
    tag: "Humane Ai Pin",
    name: "Humane Ai Pin",
    price: 699,
    description: "A screenless wearable AI assistant that clips to your clothing and projects a small laser display onto your palm.",
  },
  {
    tag: "Ray-Ban Meta",
    name: "Ray-Ban Meta smart glasses",
    price: 299,
    description: "Everyday sunglasses with a camera, open-ear speakers and a voice assistant.",
  },
  {
    tag: "Rabbit R1",
    name: "Rabbit R1",
    price: 199,
    description: "A small orange handheld that uses your apps for you: order food, book a ride, answer questions.",
  },
  {
    tag: "Tandem",
    name: "Tandem",
    price: 8,
    priceModel: "subscription_monthly",
    description: "An AI study planner that turns your syllabus and deadlines into a realistic weekly plan.",
  },
];
