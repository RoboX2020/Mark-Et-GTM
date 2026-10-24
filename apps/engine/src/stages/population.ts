import { clamp, tokens, type Backend, type Channel, type GraphNode, type Persona, type SocialEdge } from "@market/core";
import type { RunContext } from "../context.js";

const FIRST_NAMES = [
  "Ada", "Bea", "Cyrus", "Dara", "Eli", "Fern", "Gus", "Hana", "Ivo", "Juno", "Kai", "Lena", "Milo", "Noor", "Otto", "Pia", "Quin", "Rhea", "Sami", "Tova",
  "Umi", "Vik", "Wren", "Xan", "Yara", "Zeb", "Arlo", "Bex", "Cleo", "Dev", "Esme", "Fin", "Gia", "Hugo", "Iris", "Jude", "Kira", "Leo", "Mae", "Nico",
  "Oona", "Pax", "Rafa", "Sage", "Teo", "Uma", "Vera", "Wes", "Yuki", "Zara",
];

/**
 * Grows the synthetic population. Each persona is a draw from its segment's
 * aggregate profile (traits, WTP, pains, channels): no persona is modelled on
 * any single real person. Anchor interviews shift the profile of the segment
 * they match, and the persona notes which anchor informed it.
 */
export async function buildPopulation(ctx: RunContext): Promise<void> {
  const { bus, brief, rng } = ctx;
  bus.emit({ type: "stage", stage: "population", status: "running", detail: `${brief.population} agents` });

  const segments = ctx.nodes.filter((n) => n.kind === "segment");
  const byId = new Map(ctx.nodes.map((n) => [n.id, n]));
  const out = (src: string, rel: string) => ctx.edges.filter((e) => e.source === src && e.relation === rel);

  // Backend assignment by quota so the configured mix holds exactly.
  const backends: Backend[] = [];
  for (const { backend, share } of ctx.llm.swarmBackends) for (let i = 0; i < Math.round(share * brief.population); i++) backends.push(backend);
  while (backends.length < brief.population) backends.push(ctx.llm.swarmBackends[0].backend);
  rng.shuffle(backends);

  const anchorFor = new Map<string, (typeof ctx.anchors)[number]>();
  for (const s of segments) {
    const st = tokens(`${s.label} ${s.summary ?? ""}`);
    let best: (typeof ctx.anchors)[number] | undefined;
    let bestScore = 0;
    for (const a of ctx.anchors) {
      const at = tokens(`${a.segmentHint} ${a.summary}`);
      const score = [...st].filter((w) => at.has(w)).length;
      if (score > bestScore) [best, bestScore] = [a, score];
    }
    if (best) anchorFor.set(s.id, best);
  }

  const personas: Persona[] = [];
  for (let i = 0; i < brief.population; i++) {
    const seg = rng.weighted(segments, (s) => s.weight);
    const prof = ctx.profiles.get(seg.id)!;
    const anchor = anchorFor.get(seg.id);
    const pains = out(seg.id, "feels").sort((a, b) => b.weight - a.weight);
    const painIds = pains.filter((e) => rng.chance(0.35 + e.weight * 0.6)).slice(0, 3).map((e) => e.target);
    if (!painIds.length && pains[0]) painIds.push(pains[0].target);
    const channelPrefs = out(seg.id, "prefers")
      .filter((e) => rng.chance(0.4 + e.weight * 0.5))
      .map((e) => e.target as Channel);
    if (!channelPrefs.length) channelPrefs.push(rng.pick(brief.channels));
    const competitorIds = out(seg.id, "uses").filter((e) => rng.chance(e.weight)).map((e) => e.target);

    let wtp = brief.price.amount * prof.wtpMultiple * Math.exp(rng.normal(0, 0.35));
    if (anchor?.statedWtp) wtp = 0.7 * wtp + 0.3 * anchor.statedWtp * Math.exp(rng.normal(0, 0.2));

    const name = `${FIRST_NAMES[i % FIRST_NAMES.length]}${i >= FIRST_NAMES.length ? ` ${String.fromCharCode(65 + Math.floor(i / FIRST_NAMES.length) - 1)}.` : ""}`;
    const role = rng.pick(prof.roles);
    const painLabels = painIds.map((id) => byId.get(id)?.label).filter(Boolean) as string[];
    const compLabels = competitorIds.map((id) => byId.get(id)?.label).filter(Boolean) as string[];
    const traits = {
      innovativeness: rng.beta01(prof.innovativeness),
      susceptibility: rng.beta01(prof.socialInfluence),
      priceSensitivity: rng.beta01(prof.priceSensitivity),
      skepticism: rng.beta01(prof.skepticism),
    };
    personas.push({
      id: `ag_${String(i).padStart(4, "0")}`,
      name,
      segmentId: seg.id,
      ageBand: prof.ageBand,
      role,
      bio: bio(role, seg, painLabels, compLabels, traits, anchor?.quotes[0], anchor?.synthetic),
      traits,
      wtp: Math.round(wtp * 100) / 100,
      painIds,
      channelPrefs,
      competitorIds,
      backend: backends[i],
      anchorId: anchor?.id,
    });
  }
  for (const persona of personas) bus.emit({ type: "agent.created", persona });
  ctx.personas = personas;
  bus.emit({ type: "stage", stage: "population", status: "done", detail: `${personas.length} agents across ${segments.length} segments` });
}

function bio(role: string, seg: GraphNode, pains: string[], comps: string[], t: Persona["traits"], anchorQuote?: string, anchorSynthetic?: boolean): string {
  const adj = [
    t.innovativeness > 0.6 ? "loves trying new tools" : t.innovativeness < 0.3 ? "rarely switches tools" : "tries new tools occasionally",
    t.priceSensitivity > 0.65 ? "watches every subscription" : t.priceSensitivity < 0.3 ? "pays for convenience" : "is moderately price-aware",
    t.skepticism > 0.65 ? "is skeptical of hype" : "is open-minded",
    t.susceptibility > 0.65 ? "follows friends' recommendations" : "decides independently",
  ];
  return [
    `A ${role} in the "${seg.label}" segment who ${adj.join(", ")}.`,
    comps.length ? `Currently uses ${comps.join(" and ")}.` : "",
    pains.length ? `Cares most about: ${pains.join("; ")}.` : "",
    anchorQuote ? `Shares the outlook of ${anchorSynthetic ? "an anchor interview (fixture)" : "a real interviewee"} who said: "${anchorQuote}"` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * Small-world social graph (Watts–Strogatz) with homophily: agents in the same
 * segment are placed next to each other on the ring, so most ties stay in the
 * segment while rewired shortcuts carry influence across segments.
 */
export async function buildNetwork(ctx: RunContext): Promise<void> {
  const { bus, rng } = ctx;
  bus.emit({ type: "stage", stage: "network", status: "running" });
  const ring = [...ctx.personas].sort((a, b) => a.segmentId.localeCompare(b.segmentId) || a.id.localeCompare(b.id));
  const n = ring.length;
  const k = clamp(Math.round(Math.log(n) * 1.3), 4, 10);
  const rewire = 0.12;
  const key = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const edges = new Map<string, SocialEdge>();
  for (let i = 0; i < n; i++) {
    for (let j = 1; j <= k / 2; j++) {
      let a = ring[i];
      let b = ring[(i + j) % n];
      if (rng.chance(rewire)) b = ring[rng.int(0, n - 1)];
      if (a.id === b.id || edges.has(key(a.id, b.id))) continue;
      const same = a.segmentId === b.segmentId;
      edges.set(key(a.id, b.id), { source: a.id, target: b.id, weight: Math.round((same ? rng.range(0.5, 1) : rng.range(0.2, 0.6)) * 100) / 100 });
    }
  }
  const list = [...edges.values()];
  for (const e of list) {
    ctx.neighbours.set(e.source, [...(ctx.neighbours.get(e.source) ?? []), e]);
    ctx.neighbours.set(e.target, [...(ctx.neighbours.get(e.target) ?? []), { source: e.target, target: e.source, weight: e.weight }]);
  }
  for (let i = 0; i < list.length; i += 250) bus.emit({ type: "network.edges", edges: list.slice(i, i + 250) });
  bus.emit({ type: "stage", stage: "network", status: "done", detail: `${list.length} ties, avg degree ${((2 * list.length) / n).toFixed(1)}` });
}
