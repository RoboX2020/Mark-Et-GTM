import type { Brief, Channel } from "@market/core";
import { FRAMING_MARGIN_TOKENS, PRICES } from "./budget.js";

// Public input contract for POST /api/runs. The founder gives a company/product name
// and the idea in plain language; everything else has a default and a hard limit.
// Field caps match the validated V11 server limits (name 120, description 800, category 80).
export interface RunInput {
  name?: string;
  idea?: string;
  category?: string;
  price?: number;
  market?: string;
  competitors?: string[];
  population?: number;
}

export class InputError extends Error {}

const LIMITS = {
  name: 120,
  idea: 800,
  category: 80,
  market: 120,
  competitors: 8,
  competitorLen: 60,
  priceMin: 0,
  priceMax: 10_000,
  populationMin: 40,
  populationMax: 300, // product cap: bounds swarm calls per run
} as const;

const DEFAULT_CHANNELS: Channel[] = ["tiktok", "reddit", "x", "product_hunt", "app_store", "word_of_mouth"];

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** Validates untrusted JSON into a Brief. Throws InputError on anything out of bounds. */
export function buildBrief(input: unknown, today = new Date()): Brief {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new InputError("body must be a JSON object");
  const body = input as Record<string, unknown>;

  const idea = str(body.idea);
  if (!idea) throw new InputError("idea is required");
  if (idea.length > LIMITS.idea) throw new InputError(`idea must be at most ${LIMITS.idea} characters`);

  const name = str(body.name) || "Untitled product";
  if (name.length > LIMITS.name) throw new InputError(`name must be at most ${LIMITS.name} characters`);

  const category = str(body.category) || "product";
  if (category.length > LIMITS.category) throw new InputError(`category must be at most ${LIMITS.category} characters`);

  let price = 0;
  if (body.price !== undefined) {
    price = Number(body.price);
    if (!Number.isFinite(price) || price < LIMITS.priceMin || price > LIMITS.priceMax)
      throw new InputError(`price must be between ${LIMITS.priceMin} and ${LIMITS.priceMax}`);
  }

  const market = str(body.market) || "general consumers";
  if (market.length > LIMITS.market) throw new InputError(`market must be at most ${LIMITS.market} characters`);

  let competitors: string[] = [];
  if (body.competitors !== undefined) {
    if (!Array.isArray(body.competitors)) throw new InputError("competitors must be an array of names");
    competitors = body.competitors.map(str).filter(Boolean);
    if (competitors.length > LIMITS.competitors) throw new InputError(`at most ${LIMITS.competitors} competitors`);
    if (competitors.some((c) => c.length > LIMITS.competitorLen)) throw new InputError(`competitor names must be at most ${LIMITS.competitorLen} characters`);
  }

  let population = 120;
  if (body.population !== undefined) {
    population = Number(body.population);
    if (!Number.isInteger(population) || population < LIMITS.populationMin || population > LIMITS.populationMax)
      throw new InputError(`population must be an integer between ${LIMITS.populationMin} and ${LIMITS.populationMax}`);
  }

  // Launch "tomorrow" so all admissible evidence is already in the past.
  const launch = new Date(today.getTime() + 86400_000);
  return {
    product: { name, description: idea, category },
    price: { amount: price, currency: "USD", model: price > 0 ? "subscription_monthly" : "freemium" },
    targetMarket: market,
    geography: "US",
    competitors,
    channels: DEFAULT_CHANNELS,
    launchDate: launch.toISOString().slice(0, 10),
    addressableMarket: 60_000,
    population,
    rounds: 6,
    monthsPerRound: 1,
    seed: 42,
    budget: {
      startingCash: 250_000,
      monthlyMarketing: 15_000,
      fixedMonthlyCosts: 22_000,
      cogsPct: 0.18,
      monthlyChurn: 0.06,
    },
  };
}

/**
 * Worst-case LLM cost bound for one run of this brief, in USD, at the given model's
 * list price. Mirrors the engine's call pattern exactly:
 * - graph: 1 freeform call, maxTokens 32000, prompt bounded at 64 KB;
 * - swarm.decide: worst case every persona re-decides every round, batched by
 *   swarmBatch; each batch maxTokens = 400 * batchSize + 500, prompt ~900 B/agent;
 * - interviews: min(24, max(8, 6% of population)) calls, maxTokens 6000, ~6 KB in;
 * - report: 8 streamed sections, maxTokens 4000, ~8 KB in each;
 * - graph backtest scoring is skipped for product runs.
 * A 25% margin covers retries (the graph stage's corrective retry) and estimation error.
 * This is a bound for gating, not a forecast.
 */
export function estimateRunCostUsd(brief: Brief, model: string, swarmBatch = 8): number {
  const price = PRICES[model];
  if (!price) throw new Error(`no verified price for ${model}`);
  const tok = (inputBytes: number, outTokens: number) => (inputBytes + FRAMING_MARGIN_TOKENS) * price.in + outTokens * price.out;

  const graph = tok(60_000, 32_000); // graph prompts are capped at MAX_REQUEST_BYTES

  const decisions = brief.population * brief.rounds;
  let swarm = 0;
  for (let done = 0; done < decisions; ) {
    const n = Math.min(swarmBatch, decisions - done);
    swarm += tok(n * 900, 400 * n + 500);
    done += n;
  }

  const interviewCount = Math.min(24, Math.max(8, Math.round(brief.population * 0.06)));
  const interviews = interviewCount * tok(6_000, 6_000);

  const report = 8 * tok(8_000, 4_000);

  return (graph + swarm + interviews + report) * 1.25;
}
