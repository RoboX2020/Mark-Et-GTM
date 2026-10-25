import { config as loadDotenv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, "../../..");
loadDotenv({ path: path.join(REPO_ROOT, ".env") });

export type Mode = "live" | "cache" | "mock";

const env = (k: string, d = "") => (process.env[k] ?? d).trim();

export interface EngineConfig {
  mode: Mode;
  dataDir: string;
  anthropic: { apiKey: string; model: string; effort: "low" | "medium" | "high" | "xhigh" | "max" };
  gemini: { apiKey: string; model: string };
  runpod: { apiKey: string; endpointId: string; model: string };
  swarmMix: Record<string, number>;
  swarmBatch: number;
  concurrency: number;
  brightdata: { token: string; serpZone: string; datasets: { reddit: string; x: string; tiktok: string }; xProfileUrls: string[] };
  apify: { token: string; actors: Record<string, string> };
  kalshi: { base: string };
  polymarket: { gamma: string; clob: string };
  listenlabs: { apiKey: string; studyId: string };
  fetchai: { enabled: boolean; bridgeUrl: string };
  spacetime: { uri: string; db: string; token: string; enabled: boolean };
}

function parseMix(s: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of s.split(",")) {
    const [k, v] = part.split(":").map((x) => x.trim());
    if (k && v && Number.isFinite(Number(v))) out[k] = Number(v);
  }
  return out;
}

export function loadConfig(overrides: Partial<{ mode: Mode; spacetime: boolean }> = {}): EngineConfig {
  const mode = (overrides.mode ?? (env("MARKET_MODE", "cache") as Mode)) || "cache";
  return {
    mode,
    dataDir: path.join(REPO_ROOT, "data"),
    anthropic: {
      apiKey: env("ANTHROPIC_API_KEY"),
      model: env("CLAUDE_MODEL", "claude-opus-5-5"),
      effort: env("CLAUDE_EFFORT", "high") as EngineConfig["anthropic"]["effort"],
    },
    gemini: { apiKey: env("GEMINI_API_KEY"), model: env("GEMINI_MODEL", "gemini-2.5-flash") },
    runpod: { apiKey: env("RUNPOD_API_KEY"), endpointId: env("RUNPOD_ENDPOINT_ID"), model: env("RUNPOD_MODEL", "Qwen/Qwen3-8B") },
    swarmMix: parseMix(env("SWARM_MIX", "runpod:0.5,gemini:0.5")),
    swarmBatch: Number(env("SWARM_BATCH", "8")),
    concurrency: Number(env("SWARM_CONCURRENCY", "8")),
    brightdata: {
      token: env("BRIGHTDATA_API_TOKEN"),
      serpZone: env("BRIGHTDATA_SERP_ZONE", "serp_api1"),
      datasets: { reddit: env("BRIGHTDATA_DATASET_REDDIT"), x: env("BRIGHTDATA_DATASET_X"), tiktok: env("BRIGHTDATA_DATASET_TIKTOK") },
      xProfileUrls: env("BRIGHTDATA_X_PROFILE_URLS")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    },
    apify: {
      token: env("APIFY_TOKEN"),
      actors: {
        reddit: env("APIFY_ACTOR_REDDIT", "trudax~reddit-scraper-lite"),
        product_hunt: env("APIFY_ACTOR_PRODUCTHUNT"),
        app_store: env("APIFY_ACTOR_APPSTORE"),
        play_store: env("APIFY_ACTOR_PLAYSTORE"),
        tiktok: env("APIFY_ACTOR_TIKTOK", "clockworks~tiktok-scraper"),
        x: env("APIFY_ACTOR_X", "apidojo~tweet-scraper"),
      },
    },
    kalshi: { base: env("KALSHI_API_BASE", "https://api.elections.kalshi.com/trade-api/v2") },
    polymarket: { gamma: env("POLYMARKET_GAMMA_BASE", "https://gamma-api.polymarket.com"), clob: env("POLYMARKET_CLOB_BASE", "https://clob.polymarket.com") },
    listenlabs: { apiKey: env("LISTENLABS_API_KEY"), studyId: env("LISTENLABS_STUDY_ID") },
    fetchai: { enabled: env("FETCH_ENABLED") === "true", bridgeUrl: env("FETCH_BRIDGE_URL", "http://127.0.0.1:8100") },
    spacetime: {
      uri: env("SPACETIMEDB_URI", "ws://127.0.0.1:3000"),
      db: env("SPACETIMEDB_DB_NAME", "market-sim"),
      token: env("SPACETIMEDB_TOKEN"),
      enabled: overrides.spacetime ?? env("SPACETIMEDB_ENABLED") === "true",
    },
  };
}
