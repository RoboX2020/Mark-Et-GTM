import {
  computeFinance,
  fitBass,
  Rng,
  type AdoptionPoint,
  type AdoptionState,
  type AgentDecision,
  type Brief,
  type Channel,
  type EventEnvelope,
  type MarketEvent,
  type Persona,
  type PriceModel,
  type RoundSummary,
  type SocialEdge,
} from "@market/core";

/**
 * An offline, deterministic run for Market World. It emits the same event
 * types as the engine, so the town, the HUD and the report tabs replay it like
 * any recorded log. The adoption logic is a small Bass-style diffusion gated
 * by price fit; the Bass curve and finance come from @market/core, the same
 * maths the engine uses. It never calls a model, which is why it is labelled
 * "scripted" everywhere it is shown.
 */

export interface WorldBriefInput {
  name: string;
  price: number;
  description: string;
  priceModel?: PriceModel;
  population?: number;
}

interface SegmentSpec {
  id: string;
  label: string;
  summary: string;
  share: number;
  wtpMult: number;
  innov: number;
  suscept: number;
  skeptic: number;
  roles: string[];
}

const SEGMENTS: SegmentSpec[] = [
  { id: "seg_early", label: "Early adopters", summary: "Try new things first and like to show them off.", share: 0.16, wtpMult: 1.6, innov: 0.7, suscept: 0.4, skeptic: 0.2, roles: ["designer", "founder", "developer", "creator"] },
  { id: "seg_busy", label: "Busy professionals", summary: "Pay for anything that saves time, if it works on day one.", share: 0.22, wtpMult: 1.25, innov: 0.4, suscept: 0.55, skeptic: 0.4, roles: ["consultant", "nurse", "manager", "lawyer"] },
  { id: "seg_budget", label: "Budget-minded", summary: "Interested, but every new subscription has to earn its place.", share: 0.24, wtpMult: 0.6, innov: 0.3, suscept: 0.6, skeptic: 0.45, roles: ["student", "teacher", "barista", "parent"] },
  { id: "seg_social", label: "Follow-the-group", summary: "Buy what their friends already use.", share: 0.2, wtpMult: 0.95, innov: 0.15, suscept: 0.9, skeptic: 0.35, roles: ["retail lead", "athlete", "musician", "planner"] },
  { id: "seg_skeptic", label: "Skeptics", summary: "Happy with what they have and wary of hype.", share: 0.18, wtpMult: 0.75, innov: 0.08, suscept: 0.3, skeptic: 0.8, roles: ["engineer", "accountant", "farmer", "retiree"] },
];

const NAMES = ["Ada", "Bea", "Cal", "Dev", "Eli", "Fay", "Gus", "Hal", "Ivy", "Jon", "Kai", "Lea", "Max", "Nia", "Oto", "Pia", "Quin", "Rae", "Sol", "Tia", "Uma", "Vic", "Wes", "Xan", "Yara", "Zed"];

const OBJECTIONS = {
  price: (p: string) => `Too expensive at ${p}`,
  need: "Not sure I need another gadget or app",
  trust: "Worried it won't work as promised",
  phone: "My phone already does most of this",
  reviews: "Want to see real reviews first",
  privacy: "Not comfortable with the privacy trade-off",
};

function money(n: number): string {
  return n >= 100 ? `$${Math.round(n)}` : `$${n.toFixed(n % 1 ? 2 : 0)}`;
}

export function scriptedBrief(input: WorldBriefInput): Brief {
  const price = Math.max(0, input.price || 0);
  const model: PriceModel = input.priceModel ?? (price <= 30 ? "subscription_monthly" : "one_time");
  return {
    product: { name: input.name.trim() || "Your product", description: input.description.trim() || "A new product.", category: "new product" },
    price: { amount: price, currency: "USD", model },
    targetMarket: "mainstream buyers in a mid-sized town",
    geography: "US",
    competitors: ["the status quo", "a free alternative"],
    channels: ["tiktok", "reddit", "x", "word_of_mouth"],
    launchDate: new Date().toISOString().slice(0, 10),
    addressableMarket: 20_000,
    population: Math.min(600, Math.max(60, input.population ?? 240)),
    rounds: 6,
    monthsPerRound: 1,
    seed: [...input.name].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7),
    budget: { startingCash: 400_000, monthlyMarketing: 25_000, fixedMonthlyCosts: 30_000, cogsPct: model === "one_time" ? 0.45 : 0.18, monthlyChurn: 0.05 },
  };
}

export function scriptedRun(input: WorldBriefInput, runId = `world_${Date.now().toString(36)}`): EventEnvelope[] {
  const brief = scriptedBrief(input);
  const rng = new Rng(`world:${brief.product.name}:${brief.price.amount}`);
  const price = brief.price.amount;
  const priceText = `${money(price)}${brief.price.model === "subscription_monthly" ? "/mo" : ""}`;
  // A reference price for the category: monthly plans are judged against ~$10, one-off products against ~$150.
  const ref = brief.price.model === "subscription_monthly" ? 10 : 150;
  const desc = brief.product.description.toLowerCase();
  const riskyHardware = /wear|device|glasses|pin|gadget|hardware|headset|ring/.test(desc);
  const name = brief.product.name;

  const envs: EventEnvelope[] = [];
  let ts = Date.now();
  let seq = 0;
  const emit = (event: MarketEvent, gap = 40) => {
    ts += gap;
    envs.push({ runId, seq: seq++, ts, event });
  };
  const stage = (s: Parameters<typeof stageEv>[0], status: Parameters<typeof stageEv>[1], detail?: string, gap = 500) => emit(stageEv(s, status, detail), gap);

  emit({ type: "run.started", brief, mode: "scripted", label: `${name} · scripted demo`, cutoff: new Date().toISOString() }, 0);
  emit({ type: "log", level: "info", message: "Scripted demo: no models called. Adoption uses a seeded diffusion model so the world always has a run to show." });
  stage("ingest", "running", "scripted run, no live data");
  stage("ingest", "done", "0 posts (scripted)", 400);
  stage("graph", "running", "laying out segments");
  emit({ type: "graph.node", node: { id: "product", kind: "product", label: name, weight: 1, summary: brief.product.description, evidenceIds: [] } }, 120);
  for (const s of SEGMENTS)
    emit({ type: "graph.node", node: { id: s.id, kind: "segment", label: s.label, weight: s.share, summary: s.summary, evidenceIds: [] } }, 220);
  stage("graph", "done", `${SEGMENTS.length} segments`, 300);

  // ── Population ───────────────────────────────────────────────
  stage("population", "running", `${brief.population} agents`, 300);
  const personas: Persona[] = [];
  const segOf = new Map<string, SegmentSpec>();
  for (let i = 0; i < brief.population; i++) {
    const s = rng.weighted(SEGMENTS, (x) => x.share);
    const wtp = Math.max(1, ref * s.wtpMult * Math.exp(rng.normal(0, 0.35)));
    const p: Persona = {
      id: `ag_${String(i).padStart(4, "0")}`,
      name: `${rng.pick(NAMES)}`,
      segmentId: s.id,
      ageBand: rng.pick(["18-24", "25-34", "35-44", "45-54", "55-64"]),
      role: rng.pick(s.roles),
      bio: `A ${rng.pick(s.roles)} in the "${s.label}" neighbourhood. ${s.summary}`,
      traits: {
        innovativeness: rng.beta01(s.innov),
        susceptibility: rng.beta01(s.suscept),
        priceSensitivity: rng.beta01(s.wtpMult < 1 ? 0.75 : 0.4),
        skepticism: rng.beta01(s.skeptic),
      },
      wtp: Math.round(wtp * 100) / 100,
      painIds: [],
      channelPrefs: rng.sample(["tiktok", "reddit", "x", "word_of_mouth"] as Channel[], 2),
      competitorIds: [],
      backend: "mock",
    };
    personas.push(p);
    segOf.set(p.id, s);
    emit({ type: "agent.created", persona: p }, 6);
  }
  stage("population", "done", `${personas.length} agents across ${SEGMENTS.length} segments`, 200);

  // ── Network: neighbourhood-heavy small world ─────────────────
  stage("network", "running", undefined, 200);
  const edges: SocialEdge[] = [];
  const bySeg = new Map<string, Persona[]>();
  for (const p of personas) bySeg.set(p.segmentId, [...(bySeg.get(p.segmentId) ?? []), p]);
  const neighbours = new Map<string, string[]>();
  const link = (a: string, b: string) => {
    if (a === b || neighbours.get(a)?.includes(b)) return;
    edges.push({ source: a, target: b, weight: rng.range(0.3, 1) });
    neighbours.set(a, [...(neighbours.get(a) ?? []), b]);
    neighbours.set(b, [...(neighbours.get(b) ?? []), a]);
  };
  for (const p of personas) {
    const local = bySeg.get(p.segmentId)!;
    for (let k = 0; k < 2; k++) link(p.id, rng.pick(local).id);
    if (rng.chance(0.35)) link(p.id, rng.pick(personas).id);
  }
  emit({ type: "network.edges", edges }, 200);
  stage("network", "done", `${edges.length} ties`, 200);

  // ── Rounds ───────────────────────────────────────────────────
  stage("simulation", "running", `${brief.rounds} rounds · scripted`, 300);
  const state = new Map<string, AdoptionState>(personas.map((p) => [p.id, "unaware"]));
  const adoption: AdoptionPoint[] = [];
  const lastDecision = new Map<string, AgentDecision>();
  // Keeps a round watchable at any population: bigger towns get shorter gaps per agent.
  const pace = Math.min(1, 160 / personas.length);
  for (let round = 1; round <= brief.rounds; round++) {
    emit({ type: "round.started", round, month: round }, 900);
    const adoptedBefore = new Set([...state].filter(([, s]) => s === "adopted").map(([id]) => id));
    let newAdopters = 0;
    for (const p of rng.shuffle([...personas])) {
      const s = segOf.get(p.id)!;
      const prev = state.get(p.id)!;
      if (prev === "adopted" || prev === "rejected") continue;
      const peers = (neighbours.get(p.id) ?? []).filter((id) => adoptedBefore.has(id));
      const seen = prev !== "unaware" || peers.length > 0 || rng.chance(0.18 + 0.3 * p.traits.innovativeness);
      if (!seen) continue;
      const fit = 1 / (1 + Math.exp(-(p.wtp - price) / Math.max(1, 0.25 * price)));
      const hazard = (0.04 + 0.22 * p.traits.innovativeness + 0.22 * p.traits.susceptibility * Math.min(1, peers.length / 2)) * fit * (1 - 0.5 * p.traits.skepticism) * (riskyHardware ? 0.8 : 1);
      const roll = rng.next();
      let next: AdoptionState;
      if (roll < hazard * 1.6) next = "adopted";
      else if (roll < hazard * 1.6 + (1 - fit) * 0.18 + p.traits.skepticism * 0.08) next = "rejected";
      else next = prev === "unaware" ? (rng.chance(0.55) ? "considering" : "aware") : "considering";
      if (next === "adopted") newAdopters++;
      state.set(p.id, next);

      const objection =
        next === "adopted"
          ? undefined
          : fit < 0.45
            ? OBJECTIONS.price(priceText)
            : p.traits.skepticism > 0.6
              ? rng.pick([OBJECTIONS.trust, OBJECTIONS.phone])
              : riskyHardware && rng.chance(0.3)
                ? OBJECTIONS.privacy
                : rng.pick([OBJECTIONS.need, OBJECTIONS.reviews]);
      const comment = commentFor(rng, next, name, priceText, objection, peers.length > 0);
      const exposure = peers.length && prev === "unaware" ? "peer" : prev === "unaware" ? "channel" : peers.length ? "both" : "none";
      emit({ type: "agent.thinking", round, agentId: p.id }, Math.round(30 * pace));
      const d: AgentDecision = {
        round,
        agentId: p.id,
        state: next,
        previous: prev,
        exposure,
        channel: exposure === "channel" || exposure === "both" ? rng.pick(p.channelPrefs) : undefined,
        sentiment: next === "adopted" ? rng.range(0.4, 0.9) : next === "rejected" ? rng.range(-0.8, -0.2) : rng.range(-0.2, 0.4),
        wtp: p.wtp,
        comment,
        reasoning: reasoningFor(next, s, p.wtp, price, peers.length),
        objection,
        influencedBy: peers.slice(0, 3),
        shownNodeIds: [s.id],
        backend: "mock",
      };
      lastDecision.set(p.id, d);
      emit({ type: "agent.decision", decision: d }, Math.round(90 * pace));
      if ((next === "adopted" || next === "rejected") && rng.chance(0.55)) {
        const to = rng.pick(neighbours.get(p.id) ?? [p.id]);
        if (to !== p.id)
          emit({ type: "agent.message", message: { round, from: p.id, to, text: comment, sentiment: d.sentiment, transport: "local" } }, Math.round(60 * pace));
      }
    }
    const counts: Record<AdoptionState, number> = { unaware: 0, aware: 0, considering: 0, adopted: 0, rejected: 0 };
    for (const s of state.values()) counts[s]++;
    const summary: RoundSummary = { round, counts, avgSentiment: 0, newAdopters, byBackend: { mock: { adopted: counts.adopted, total: personas.length } } };
    emit({ type: "round.completed", summary }, 300);
    const point: AdoptionPoint = { month: round, cumulative: counts.adopted / personas.length, newAdopters };
    adoption.push(point);
    emit({ type: "adoption.point", point }, 80);
  }
  stage("simulation", "done", `${adoption[adoption.length - 1].cumulative * personas.length} of ${personas.length} adopted`, 300);

  // ── Fit, finance, short report ───────────────────────────────
  stage("bass", "running", "fitting 6 simulated months", 400);
  const final = [...state.values()];
  const share = (s: AdoptionState) => final.filter((x) => x === s).length / final.length;
  const mPrior = Math.min(0.95, share("adopted") + 0.45 * share("considering") + 0.08 * share("unaware"));
  const bass = fitBass(adoption, { horizon: 12, mPrior, priorWeight: 0.08 });
  emit({ type: "bass.fit", fit: bass }, 200);
  stage("bass", "done", `m=${(bass.m * 100).toFixed(1)}%`, 200);

  stage("finance", "running", undefined, 300);
  const adopters = personas.filter((p) => state.get(p.id) === "adopted");
  const finance = computeFinance({
    brief,
    bass,
    wtp: adopters.map((p) => ({ agentId: p.id, wtp: p.wtp })),
    attribution: [],
    adoptionAgentIds: adopters.map((p) => p.id),
    adoptionEvidenceIds: [],
  });
  emit({ type: "finance.computed", finance }, 200);
  stage("finance", "done", finance.breakEvenMonth ? `break-even month ${finance.breakEvenMonth}` : "break-even beyond 12 months", 200);

  const objectionCounts = new Map<string, number>();
  for (const d of lastDecision.values()) if (d.objection) objectionCounts.set(d.objection, (objectionCounts.get(d.objection) ?? 0) + 1);
  const topObjections = [...objectionCounts].sort((a, b) => b[1] - a[1]).slice(0, 3);
  const segLines = SEGMENTS.map((s) => {
    const members = personas.filter((p) => p.segmentId === s.id);
    const rate = members.filter((p) => state.get(p.id) === "adopted").length / Math.max(1, members.length);
    return { s, rate, n: members.length };
  }).sort((a, b) => b.rate - a.rate);

  stage("report", "running", "scripted summary", 300);
  const sections: [string, string, string][] = [
    [
      "verdict",
      "Verdict",
      `**This is a scripted demo run, not a model forecast.** In it, about **${(bass.m * 100).toFixed(1)}%** of the town eventually adopts ${name} at ${priceText}. ${finance.breakEvenMonth ? `The plan breaks even in **month ${finance.breakEvenMonth}**.` : "The plan **does not break even within 12 months**."} Run the engine with live models for a real read.`,
    ],
    [
      "segments",
      "Who to target first",
      segLines.map((x, i) => `${i + 1}. **${x.s.label}**: ${(x.rate * 100).toFixed(0)}% adopted of ${x.n}. ${x.s.summary}`).join("\n"),
    ],
    ["objections", "Top objections", topObjections.map(([o, n]) => `- ${o} (${n} people)`).join("\n") || "- None recorded"],
    [
      "limits",
      "What this run can't know",
      "No posts were read and no models were called. The town, decisions and comments come from a seeded diffusion model and comment templates, so the numbers show how the simulator behaves, not how the market will.",
    ],
  ];
  sections.forEach(([id, title, text], i) => {
    emit({ type: "report.section", id, title, order: i }, 200);
    for (const chunk of text.match(/.{1,60}(\s|$)/g) ?? [text]) emit({ type: "report.delta", id, text: chunk }, 25);
    emit({ type: "report.section.done", id }, 60);
  });
  stage("report", "done", `${sections.length} sections`, 200);
  stage("interviews", "skipped", undefined, 10);
  stage("backtest", "skipped", undefined, 10);
  emit({ type: "run.completed", status: "ok", usage: {} }, 300);
  return envs;
}

function stageEv(stage: Extract<MarketEvent, { type: "stage" }>["stage"], status: Extract<MarketEvent, { type: "stage" }>["status"], detail?: string): MarketEvent {
  return { type: "stage", stage, status, detail };
}

function commentFor(rng: Rng, state: AdoptionState, name: string, price: string, objection: string | undefined, fromPeer: boolean): string {
  switch (state) {
    case "adopted":
      return rng.pick([
        `${fromPeer ? "My neighbour swears by it, so" : "Honestly,"} I'm getting ${name}.`,
        `Bought it. ${price} feels fair for what it does.`,
        `Signed up. If it saves me time it pays for itself.`,
        `Ordered one. Curious to see if it lives up to the demo.`,
      ]);
    case "rejected":
      return rng.pick([`Pass. ${objection ?? "Not for me."}`, `Not for me. ${objection ?? ""}`.trim(), `I'll stick with what I have.`]);
    case "considering":
      return rng.pick([`Maybe. ${objection ?? "I need to think about it."}`, `Interesting, but ${objection?.toLowerCase() ?? "I'll wait"}.`, `Waiting to see what friends think.`]);
    default:
      return "";
  }
}

function reasoningFor(state: AdoptionState, s: SegmentSpec, wtp: number, price: number, peers: number): string {
  const fit = wtp >= price ? `would pay up to $${wtp.toFixed(0)}, above the $${price} price` : `would only pay about $${wtp.toFixed(0)}, below the $${price} price`;
  const social = peers ? `${peers} connected neighbour${peers > 1 ? "s" : ""} already adopted` : "no neighbours have it yet";
  const verdict = state === "adopted" ? "That was enough to buy." : state === "rejected" ? "Not convinced." : "Holding off for now.";
  return `${s.label}: ${fit}; ${social}. ${verdict}`;
}
