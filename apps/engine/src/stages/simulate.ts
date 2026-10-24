import { z } from "zod";
import {
  channelSplit,
  clamp,
  clamp01,
  Rng,
  type AdoptionState,
  type AgentDecision,
  type AgentMessage,
  type Backend,
  type Channel,
  type Persona,
  type RoundSummary,
} from "@market/core";
import { briefSummary, lastDecision, type RunContext } from "../context.js";
import { limiter } from "../llm/types.js";
import { THEMES } from "../lexicon.js";
import { FetchBridge } from "../fetchai.js";

const DecisionSchema = z.object({
  decisions: z.array(
    z.object({
      agentId: z.string(),
      state: z.enum(["aware", "considering", "adopted", "rejected"]),
      intent: z.number().describe("0-1 probability this person buys/signs up this round"),
      sentiment: z.number().describe("-1 to 1"),
      wtp: z.number().describe("What they'd actually pay, in the product's currency and billing period"),
      comment: z.string().describe("What they'd say to a friend about it, first person, under 30 words"),
      reasoning: z.string().describe("Their private reasoning, under 40 words"),
      objection: z.string().describe("Their main hesitation in under 12 words, or empty"),
    }),
  ),
});
type DecisionOut = z.infer<typeof DecisionSchema>["decisions"][number];

interface Exposure {
  channel?: Channel;
  peers: AgentMessage[];
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

export function launchMessage(ctx: RunContext, channel: Channel): string {
  const b = ctx.brief;
  const custom = (b as { messaging?: Partial<Record<Channel, string>> }).messaging?.[channel];
  if (custom) return custom;
  const per = b.price.model === "one_time" ? "" : b.price.model === "subscription_annual" ? "/yr" : "/mo";
  const lead: Partial<Record<Channel, string>> = {
    product_hunt: `Launching today on Product Hunt: ${b.product.name}`,
    tiktok: `A creator demos ${b.product.name} in a 30-second video`,
    reddit: `A post in a ${b.product.category} subreddit about ${b.product.name}`,
    x: `A thread announcing ${b.product.name}`,
    app_store: `${b.product.name} featured in App Store search results`,
    paid_social: `A sponsored ad for ${b.product.name}`,
    seo: `A search result comparing ${b.product.name} with alternatives`,
    email: `A newsletter mention of ${b.product.name}`,
    partnerships: `A partner recommends ${b.product.name}`,
  };
  return `${lead[channel] ?? b.product.name}: ${b.product.description} — ${b.price.currency} ${b.price.amount}${per}.`;
}

function worldSystem(ctx: RunContext): string {
  const top = (kind: string, n: number) =>
    ctx.nodes
      .filter((x) => x.kind === kind)
      .sort((a, b) => b.weight - a.weight)
      .slice(0, n);
  return [
    "You simulate how real people in a market react to a new product launch. You will role-play several distinct people at once.",
    "Stay in character for each person: their budget, habits, tools they already use and skepticism. Most people ignore or postpone most launches; enthusiasm must be earned.",
    "Base reactions on the person's profile, what they actually saw this round, and what friends told them. Do not assume the product is good.",
    "Return one decision per person, using their exact agentId.",
    "",
    "## The launch",
    briefSummary(ctx.brief),
    "",
    "## What the market is saying (aggregated from public posts)",
    ...top("pain", 6).map((p) => `- Pain: ${p.label} (prevalence ${(p.weight * 100).toFixed(0)}%)`),
    ...top("trend", 4).map((p) => `- Trend/desire: ${p.label}`),
    ...top("competitor", 5).map((c) => `- Competitor: ${c.label}${c.summary ? ` — ${c.summary}` : ""}`),
    ...top("price_point", 4).map((c) => `- Price anchor: ${c.label}`),
    "",
    "## Conditions around the launch (prediction-market odds)",
    ...top("condition", 5).map((c) => `- ${c.label}: ${(c.weight * 100).toFixed(0)}% (${c.attrs?.direction ?? ""})`),
  ].join("\n");
}

function agentBlock(ctx: RunContext, p: Persona, exp: Exposure, prev: AgentDecision | undefined): string {
  const saw = [
    exp.channel ? `Saw: ${launchMessage(ctx, exp.channel)}` : "",
    ...exp.peers.map((m) => `Friend ${ctx.personas.find((x) => x.id === m.from)?.name ?? "someone"} said: "${m.text}"`),
  ].filter(Boolean);
  return [
    `### agentId: ${p.id}`,
    `${p.name}, ${p.ageBand}. ${p.bio}`,
    `Prior willingness to pay: about ${ctx.brief.price.currency} ${p.wtp}.`,
    `Current state: ${prev?.state ?? "unaware"}${prev?.comment ? ` (last said: "${prev.comment}")` : ""}`,
    saw.length ? saw.join("\n") : "Saw nothing new this round; is still mulling it over.",
  ].join("\n");
}

export async function simulate(ctx: RunContext): Promise<void> {
  const { bus, brief, llm } = ctx;
  bus.emit({ type: "stage", stage: "simulation", status: "running", detail: `${brief.rounds} rounds · ${llm.describe()}` });

  const split = channelSplit(brief);
  const paid = [...split.keys()];
  const budgetFactor = clamp(Math.sqrt(brief.budget.monthlyMarketing / 10_000), 0.3, 2.5);
  const system = worldSystem(ctx);
  const run = limiter(ctx.cfg.concurrency);
  const bridge = ctx.cfg.fetchai.enabled ? new FetchBridge(ctx.cfg.fetchai.bridgeUrl, bus) : null;
  if (bridge) await bridge.register(ctx.personas, ctx.neighbours);
  const headwind = ctx.nodes.filter((n) => n.kind === "condition" && n.attrs?.direction === "headwind").reduce((a, n) => a + n.weight, 0) / Math.max(1, ctx.nodes.filter((n) => n.kind === "condition").length);

  let inbox = new Map<string, AgentMessage[]>();
  let prevAdopted = 0;

  for (let round = 1; round <= brief.rounds; round++) {
    const month = round * brief.monthsPerRound;
    bus.emit({ type: "round.started", round, month });
    const rng = new Rng(`round:${brief.seed}:${round}`);
    const burst = round === 1 ? 1.8 : round === 2 ? 1.2 : 1;

    // 1. Exposure: paid/organic channels plus messages from friends last round.
    const toDecide: { p: Persona; exp: Exposure; prev?: AgentDecision }[] = [];
    for (const p of ctx.personas) {
      const prev = lastDecision(ctx, p.id);
      const state = prev?.state ?? "unaware";
      let channel: Channel | undefined;
      if (state === "unaware" || state === "aware") {
        for (const c of rng.shuffle([...paid])) {
          const rate = 0.07 * (split.get(c) ?? 0) * paid.length * budgetFactor * burst * (p.channelPrefs.includes(c) ? 1 : 0.25);
          if (rng.chance(clamp01(rate))) {
            channel = c;
            break;
          }
        }
      }
      const peers = inbox.get(p.id) ?? [];
      const positivePeers = peers.filter((m) => m.sentiment > 0.2).length;
      // Fence-sitters keep deliberating; people who merely noticed it only re-decide when re-exposed.
      const deliberating = state === "considering";
      const reconsider = state === "rejected" && positivePeers >= 2;
      if (state === "adopted" || (state === "rejected" && !reconsider)) continue;
      if (!channel && !peers.length && !deliberating) continue;
      if (!ctx.firstExposure.has(p.id)) ctx.firstExposure.set(p.id, channel ?? "word_of_mouth");
      toDecide.push({ p, exp: { channel, peers }, prev });
    }

    // 2. Decisions, batched per backend.
    const byBackend = new Map<Backend, typeof toDecide>();
    for (const item of toDecide) byBackend.set(item.p.backend, [...(byBackend.get(item.p.backend) ?? []), item]);
    const batches: { backend: Backend; items: typeof toDecide }[] = [];
    for (const [backend, items] of byBackend)
      for (let i = 0; i < items.length; i += ctx.cfg.swarmBatch) batches.push({ backend, items: items.slice(i, i + ctx.cfg.swarmBatch) });

    const outgoing: AgentMessage[] = [];
    await Promise.all(
      batches.map((batch) =>
        run(async () => {
          for (const it of batch.items) bus.emit({ type: "agent.thinking", round, agentId: it.p.id });
          const prompt = `Round ${round} (month ${month} after launch).\n\n${batch.items.map((it) => agentBlock(ctx, it.p, it.exp, it.prev)).join("\n\n")}`;
          const { value, served } = await llm.json(batch.backend, {
            purpose: "swarm.decide",
            system,
            prompt,
            schema: DecisionSchema,
            maxTokens: 400 * batch.items.length + 500,
            mock: () => ({ decisions: batch.items.map((it) => mockDecision(ctx, it.p, it.exp, it.prev, round, headwind)) }),
          });
          const got = new Map(value.decisions.map((d) => [d.agentId, d]));
          for (const it of batch.items) {
            const d = got.get(it.p.id) ?? mockDecision(ctx, it.p, it.exp, it.prev, round, headwind);
            const decision = resolve(ctx, it.p, it.exp, it.prev, d, round, served, rng);
            ctx.decisions.set(it.p.id, [...(ctx.decisions.get(it.p.id) ?? []), decision]);
            bus.emit({ type: "agent.decision", decision });
            outgoing.push(...messagesFrom(ctx, it.p, decision, round, rng));
          }
        }),
      ),
    );

    // 3. Word of mouth: delivered next round (optionally through Fetch.ai agents).
    const delivered = bridge ? await bridge.relay(round, outgoing) : outgoing;
    inbox = new Map();
    delivered.forEach((m, i) => {
      inbox.set(m.to, [...(inbox.get(m.to) ?? []), m]);
      if (i < 160) bus.emit({ type: "agent.message", message: m });
    });

    // 4. Round summary + adoption point.
    const counts: Record<AdoptionState, number> = { unaware: 0, aware: 0, considering: 0, adopted: 0, rejected: 0 };
    const byB: RoundSummary["byBackend"] = {};
    let sentSum = 0;
    let sentN = 0;
    for (const p of ctx.personas) {
      const d = lastDecision(ctx, p.id);
      const s = d?.state ?? "unaware";
      counts[s]++;
      const bb = (byB[d?.backend ?? p.backend] ??= { adopted: 0, total: 0 });
      bb.total++;
      if (s === "adopted") bb.adopted++;
      if (d) {
        sentSum += d.sentiment;
        sentN++;
      }
    }
    const summary: RoundSummary = { round, counts, avgSentiment: sentN ? sentSum / sentN : 0, newAdopters: counts.adopted - prevAdopted, byBackend: byB };
    prevAdopted = counts.adopted;
    bus.emit({ type: "round.completed", summary });
    const point = { month, cumulative: counts.adopted / ctx.personas.length, newAdopters: summary.newAdopters };
    ctx.adoption.push(point);
    bus.emit({ type: "adoption.point", point });
  }
  bus.emit({ type: "stage", stage: "simulation", status: "done", detail: `${prevAdopted} of ${ctx.personas.length} adopted after ${brief.rounds} rounds` });
}

/**
 * Turns a model's stated intent into a state transition. Language models
 * over-state enthusiasm, so the stated intent is blended with a structural
 * Bass-style hazard (innovation + imitation from adopted friends) and gated by
 * price fit. The model supplies reasons and words; the hazard keeps the
 * aggregate dynamics anchored.
 */
function resolve(ctx: RunContext, p: Persona, exp: Exposure, prev: AgentDecision | undefined, d: DecisionOut, round: number, served: Backend, rng: Rng): AgentDecision {
  const price = ctx.brief.price.amount;
  const adoptedWeight = (ctx.neighbours.get(p.id) ?? []).reduce((a, e) => a + (lastDecision(ctx, e.target)?.state === "adopted" ? e.weight : 0), 0);
  const pi = 0.02 + 0.1 * p.traits.innovativeness;
  const qi = 0.09 * p.traits.susceptibility;
  let hazard = 1 - (1 - pi) * Math.pow(1 - qi, adoptedWeight);
  if (!exp.channel && !exp.peers.length) hazard *= 0.6;
  const wtp = Number.isFinite(d.wtp) && d.wtp >= 0 ? d.wtp : p.wtp;
  let priceFit = sigmoid((wtp - price) / (0.25 * Math.max(price, 1)));
  if (ctx.brief.price.model === "freemium") priceFit = Math.max(priceFit, 0.6);
  const intent = clamp01(d.intent);
  const pAdopt = clamp01((0.55 * Math.pow(intent, 1.3) + 0.45 * hazard) * (0.35 + 0.65 * priceFit));
  const previous = prev?.state ?? "unaware";

  let state: AdoptionState;
  if (d.state !== "rejected" && rng.chance(pAdopt)) state = "adopted";
  else if (d.state === "rejected" && (previous === "considering" || intent < 0.2)) state = "rejected";
  else if (d.state === "adopted" || intent > 0.35 || d.state === "considering") state = "considering";
  else state = "aware";

  return {
    round,
    agentId: p.id,
    state,
    previous,
    exposure: exp.channel && exp.peers.length ? "both" : exp.channel ? "channel" : exp.peers.length ? "peer" : "none",
    channel: exp.channel,
    sentiment: clamp(d.sentiment, -1, 1),
    wtp: Math.round(wtp * 100) / 100,
    comment: d.comment.slice(0, 280),
    reasoning: d.reasoning.slice(0, 400),
    objection: d.objection?.trim() ? d.objection.slice(0, 140) : undefined,
    influencedBy: exp.peers.map((m) => m.from),
    shownNodeIds: [...p.painIds, ...p.competitorIds],
    backend: served,
  };
}

function messagesFrom(ctx: RunContext, p: Persona, d: AgentDecision, round: number, rng: Rng): AgentMessage[] {
  const changed = d.state !== d.previous;
  const strong = Math.abs(d.sentiment) > 0.45;
  if (!d.comment || (!changed && !strong) || !rng.chance(0.65)) return [];
  const ns = [...(ctx.neighbours.get(p.id) ?? [])].sort((a, b) => b.weight - a.weight);
  const fanout = d.state === "adopted" ? 3 : 2;
  return ns
    .filter((e) => rng.chance(0.3 + e.weight * 0.6))
    .slice(0, fanout)
    .map((e) => ({ round, from: p.id, to: e.target, text: d.comment, sentiment: d.sentiment, transport: "local" as const }));
}

// ── Deterministic offline agent ──────────────────────────────────────────────

export function mockDecision(ctx: RunContext, p: Persona, exp: Exposure, prev: AgentDecision | undefined, round: number, headwind: number): DecisionOut {
  const rng = new Rng(`decide:${ctx.brief.seed}:${p.id}:${round}`);
  const price = ctx.brief.price.amount;
  const priceRatio = price / Math.max(p.wtp, 0.01);
  const peerPull = exp.peers.reduce((a, m) => a + m.sentiment, 0) / Math.max(1, exp.peers.length);
  const positivePains = p.painIds.filter((id) => ctx.nodes.find((n) => n.id === id)?.kind === "trend").length;
  const score =
    -1.0 +
    1.6 * p.traits.innovativeness +
    1.6 * p.traits.susceptibility * peerPull * Math.min(1, exp.peers.length / 2) +
    0.35 * positivePains +
    (exp.channel ? 0.5 : 0) +
    (prev?.state === "considering" ? 0.35 : 0) -
    1.1 * p.traits.priceSensitivity * Math.max(0, priceRatio - 0.8) -
    0.7 * p.traits.skepticism -
    0.6 * headwind * p.traits.priceSensitivity -
    0.12 * p.competitorIds.length +
    rng.normal(0, 0.45);
  const intent = clamp01(sigmoid(score * 1.5));
  const state: DecisionOut["state"] = intent > 0.62 ? "adopted" : intent > 0.38 ? "considering" : intent < 0.12 && rng.chance(0.5) ? "rejected" : "aware";

  const painThemes = p.painIds.map((id) => THEMES.find((t) => `pain_${t.id}` === id)).filter(Boolean) as typeof THEMES;
  const negative = painThemes.filter((t) => t.polarity < 0);
  const objectionTheme = priceRatio > 1.1 && p.traits.priceSensitivity > 0.5 ? THEMES[0] : negative[0] ?? (p.traits.skepticism > 0.6 ? THEMES.find((t) => t.id === "ai_trust") : undefined);
  const comp = ctx.nodes.find((n) => n.id === p.competitorIds[0])?.label ?? "what I use now";
  const name = ctx.brief.product.name;
  const cur = ctx.brief.price.currency === "USD" ? "$" : `${ctx.brief.price.currency} `;
  const lines: Record<DecisionOut["state"], string[]> = {
    adopted: [
      `Signed up for ${name}. It does the thing ${comp} never quite did.`,
      `Okay I caved and tried ${name}. Worth it so far.`,
      `Bought it. If it keeps saving me time it's a no-brainer at ${cur}${price}.`,
      `Switched from ${comp} to ${name} this week, honestly smoother.`,
    ],
    considering: [
      `${name} looks promising, waiting to see a few more reviews first.`,
      `Bookmarked ${name}. If a friend vouches I'll try it.`,
      `Tempted by ${name}, but ${objectionTheme ? objectionTheme.label.toLowerCase() : "the price"} is giving me pause.`,
    ],
    aware: [`Saw ${name} going around. Not sure it's for me yet.`, `Another ${ctx.brief.product.category} launch. I'll pass for now.`, `Heard of ${name}, haven't looked closely.`],
    rejected: [
      `Not for me. ${objectionTheme?.objection ?? "Doesn't solve a problem I have"}.`,
      `Tried the page, I'm sticking with ${comp}.`,
      `Pass. ${cur}${price} is too much for what it is.`,
    ],
  };
  const comment = rng.pick(lines[state]);
  return {
    agentId: p.id,
    state,
    intent,
    sentiment: clamp(intent * 2 - 1 + rng.normal(0, 0.15), -1, 1),
    wtp: Math.round(p.wtp * (0.85 + rng.next() * 0.3) * 100) / 100,
    comment,
    reasoning: `${p.traits.innovativeness > 0.6 ? "I like trying new tools" : "I'm not in a rush to switch"}; ${priceRatio > 1 ? "price is above what I'd normally pay" : "price is within my range"}${exp.peers.length ? `; ${exp.peers.length} friend(s) mentioned it` : ""}.`,
    objection: state === "adopted" ? "" : objectionTheme?.objection ?? "",
  };
}
