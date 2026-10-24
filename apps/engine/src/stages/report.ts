import type { Analytics } from "../analytics.js";
import { briefSummary, type RunContext } from "../context.js";

// The report is written section by section and streamed into the event log.
// Each section gets the same deterministic data bundle; citations use
// [[A:agent_id]] for agents and [[E:evidence_id]] for evidence, which the
// portal renders as links into the Agents and Evidence views.

interface Section {
  id: string;
  title: string;
  ask: string;
  mock: (ctx: RunContext, a: Analytics) => string;
}

const pct = (x: number, d = 0) => `${(x * 100).toFixed(d)}%`;
const money = (ctx: RunContext, x: number) => `${ctx.brief.price.currency === "USD" ? "$" : ctx.brief.price.currency + " "}${Math.round(x).toLocaleString("en-US")}`;
const cite = (ids: string[], kind: "A" | "E", n = 3) => ids.slice(0, n).map((id) => `[[${kind}:${id}]]`).join(" ");

const SECTIONS: Section[] = [
  {
    id: "verdict",
    title: "Verdict",
    ask: "Give the founder the bottom line in 4–6 sentences: will this launch land, how big, how fast, and the single most important change to make. Lead with the answer.",
    mock: (ctx, a) => {
      const f = ctx.finance!;
      const b = ctx.bass!;
      const top = a.segments[0];
      const obj = a.objections[0];
      return `The simulation points to a **${b.m > 0.25 ? "strong" : b.m > 0.1 ? "moderate" : "slow"} launch**: about **${pct(b.m, 1)}** of the addressable market eventually adopts, with new sign-ups peaking around **month ${Math.max(1, Math.round(b.peakMonth))}**. ${top ? `Momentum comes from **${top.label}** (${pct(top.adoptionRate)} adoption) ${cite(top.sampleAgentIds, "A", 2)}.` : ""} ${obj ? `The biggest drag is *${obj.label.toLowerCase()}*, raised by ${obj.count} agents ${cite(obj.agentIds, "A", 2)}.` : ""} At the current plan the business ${f.breakEvenMonth ? `breaks even in **month ${f.breakEvenMonth}**` : "**does not break even within 12 months**"}, with cash bottoming at ${money(ctx, f.minCash)}. **Most important change:** ${obj?.suggestedAnswer ?? "tighten the message to the segment that is already converting."}`;
    },
  },
  {
    id: "adoption",
    title: "Predicted adoption",
    ask: "Explain the Bass diffusion fit (p, q, m, peak month) in plain language, what drives it (innovation vs. word of mouth), and how confident the fit is given how many months were simulated.",
    mock: (ctx, a) => {
      const b = ctx.bass!;
      const wom = b.q / (b.p + b.q);
      return `The adoption curve was fitted to ${b.observed.length} simulated months with a Bass model: innovation coefficient **p = ${b.p.toFixed(4)}**, imitation coefficient **q = ${b.q.toFixed(3)}** and eventual adoption **m = ${pct(b.m, 1)}** (fit RMSE ${b.rmse.toFixed(4)}).\n\nAbout **${pct(wom)} of growth comes from word of mouth**, not from launch exposure. ${wom > 0.85 ? "Early adopters' recommendations matter more than ad spend; seed the right communities." : "Launch-day exposure carries a large share, so the first two weeks matter disproportionately."} Months beyond ${b.observed.length} are extrapolated, so treat the tail as a scenario, not a measurement.\n\nAdoption differed by model backend: ${a.backends.map((x) => `${x.backend} ${pct(x.rate)} (${x.agents} agents)`).join(", ")}. ${a.backends.length > 1 ? "The spread between backends is a rough read on model bias." : ""}`;
    },
  },
  {
    id: "segments",
    title: "Who to target first",
    ask: "Rank the segments to target first with adoption rate, sentiment and willingness to pay, and say why. Cite example agents.",
    mock: (ctx, a) =>
      `${a.segments
        .slice(0, 4)
        .map((s, i) => `${i + 1}. **${s.label}**: ${pct(s.adoptionRate)} adopted, ${s.considering} still considering, median WTP ${money(ctx, s.medianWtp)}, sentiment ${s.avgSentiment.toFixed(2)}. ${cite(s.sampleAgentIds, "A", 2)}`)
        .join("\n")}\n\nStart with **${a.segments[0]?.label ?? "the leading segment"}**: it converts fastest, and its members recommend the product into neighbouring segments.`,
  },
  {
    id: "objections",
    title: "Top objections and how to answer them",
    ask: "List the top objections with how many agents raised them, a representative quote, the supporting public evidence, and a concrete answer the founder can put on the landing page.",
    mock: (_ctx, a) =>
      a.objections
        .slice(0, 5)
        .map((o) => `**${o.label}**: ${o.count} agents. “${o.quotes[0]?.text ?? ""}” ${cite(o.agentIds, "A", 2)} ${cite(o.evidenceIds, "E", 2)}\n→ *Answer:* ${o.suggestedAnswer ?? "Address it directly in the first screen of the landing page."}`)
        .join("\n\n"),
  },
  {
    id: "pricing",
    title: "Is the price right?",
    ask: "Compare the price to the willingness-to-pay distribution and interview verdicts. Recommend keep, raise, lower or restructure (tiers/annual/free tier) with reasoning.",
    mock: (ctx, a) => {
      const p = a.price;
      const rec = p.verdict === "too_expensive" ? "Introduce a free tier or a lower entry plan, and keep the current price as the main paid tier." : p.verdict === "too_cheap" ? "Test a higher tier; the top quartile would pay meaningfully more." : "Keep the price, and add an annual plan to lift cash early.";
      return `At **${money(ctx, p.price)}**, interviewed agents' median willingness to pay is **${money(ctx, p.wtpMedian)}** (IQR ${money(ctx, p.wtpP25)}–${money(ctx, p.wtpP75)}). **${pct(p.shareAbovePrice)}** would pay at least the list price. Interview verdicts: ${p.verdicts.fair} fair, ${p.verdicts.too_expensive} too expensive, ${p.verdicts.too_cheap} too cheap. ${cite(p.interviewAgentIds, "A", 3)}\n\n**Recommendation:** ${rec}`;
    },
  },
  {
    id: "channels",
    title: "Channels and messages to lead with",
    ask: "Rank channels by simulated conversion and CAC, say which to lead with and which to cut, and propose the lead message for the top two channels grounded in what agents said.",
    mock: (ctx, a) => {
      const fin = ctx.finance!;
      const rows = a.channels
        .filter((c) => c.exposed > 0)
        .slice(0, 6)
        .map((c) => {
          const econ = fin.channels.find((x) => x.channel === c.channel);
          return `- **${c.channel.replaceAll("_", " ")}**: ${c.adopted}/${c.exposed} converted (${pct(c.conversion)}), CAC ${econ?.cac ? money(ctx, econ.cac) : c.channel === "word_of_mouth" ? "organic" : "n/a"}${econ?.provenance.needsReview ? " ⚑ low confidence" : ""}`;
        });
      const pos = a.adopterQuotes[0];
      const lead = a.channels.filter((c) => c.channel !== "word_of_mouth" && c.exposed > 0).sort((x, y) => y.adopted - x.adopted || y.conversion - x.conversion)[0];
      const wom = a.channels.find((c) => c.channel === "word_of_mouth");
      return `${rows.join("\n")}\n\nLead with **${lead?.channel.replaceAll("_", " ") ?? "your top channel"}**${wom && wom.adopted ? `, and design for word of mouth: ${wom.adopted} adopters arrived through friends` : ""}. Use the language adopters already use: “${pos?.text ?? "it just works"}” ${pos ? cite([pos.agentId], "A") : ""}`;
    },
  },
  {
    id: "finance",
    title: "Financial forecast",
    ask: "Summarise the 12-month revenue forecast, customer acquisition cost by channel, break-even month and cash impact. State which figures are low-confidence and need human review, and why.",
    mock: (ctx) => {
      const f = ctx.finance!;
      const review = [...f.items.filter((i) => i.provenance.needsReview).map((i) => i.label), ...f.channels.filter((c) => c.provenance.needsReview).map((c) => `CAC — ${c.channel}`)];
      return `12-month revenue: **${money(ctx, f.totalRevenue12)}** from ${f.months.reduce((a, m) => a + m.newCustomers, 0).toLocaleString()} customers (ARPU ${money(ctx, f.arpu)}/month). Break-even: **${f.breakEvenMonth ? `month ${f.breakEvenMonth}` : "not within 12 months"}**. Lowest cash balance: **${money(ctx, f.minCash)}**${f.runwayMonths !== null ? `, runway after month 12 ≈ ${f.runwayMonths} months` : ""}.\n\n${review.length ? `⚑ **Needs human review:** ${review.join(", ")}. These rest on few simulated adopters or long extrapolation.` : "No figures fell below the confidence threshold."}`;
    },
  },
  {
    id: "limits",
    title: "What this simulation can't know",
    ask: "Be candid about the limits: synthetic agents vs. real buyers, model positivity bias, data coverage (note any fixture/synthetic data), extrapolation, execution quality, competitor responses, and anything specific to this run.",
    mock: (ctx) => {
      const synth = ctx.evidence.filter((e) => e.synthetic).length;
      return [
        `- **Agents are not customers.** Personas are drawn from aggregate patterns in ${ctx.evidence.length} public posts${synth ? ` (**${synth} of them offline fixtures, not real data**)` : ""} and ${ctx.anchors.length} anchor interviews${ctx.anchors.some((x) => x.synthetic) ? " (fixtures; no Listen Labs data loaded)" : ""}.`,
        "- **Language models skew positive.** Stated intent is blended with a structural diffusion model and gated by price fit to damp this, but some optimism likely remains.",
        `- **Extrapolation.** Only ${ctx.bass?.observed.length ?? 0} months were simulated; months beyond that come from the fitted curve.`,
        "- **Execution and product quality** (onboarding, bugs, support) are invisible to the simulation.",
        "- **Competitor responses** such as price cuts or feature launches after your launch are not modelled.",
        `- **Macro conditions** enter as prediction-market odds at the cutoff (${ctx.cutoff.slice(0, 10)}); shocks after that date are not modelled.`,
      ].join("\n");
    },
  },
];

const SYSTEM = `You are the lead analyst writing a launch-readiness report for a founder. Write tight, specific Markdown (no top-level heading — the section title is shown separately).
Use only the numbers in the data bundle; never invent figures. Cite agents as [[A:agent_id]] and evidence as [[E:evidence_id]] next to the claims they support, using only ids present in the bundle.
Flag any figure whose provenance has needsReview=true with "⚑ needs review". Be honest about uncertainty and about any synthetic/fixture data. Keep each section under 250 words.`;

export async function writeReport(ctx: RunContext, analytics: Analytics): Promise<void> {
  const { bus, llm } = ctx;
  bus.emit({ type: "stage", stage: "report", status: "running", detail: `writing with ${llm.reasoningBackend}` });
  const bundle = JSON.stringify(
    {
      brief: briefSummary(ctx.brief),
      cutoff: ctx.cutoff,
      bass: ctx.bass && { p: ctx.bass.p, q: ctx.bass.q, m: ctx.bass.m, rmse: ctx.bass.rmse, peakMonth: ctx.bass.peakMonth, observed: ctx.bass.observed, curve: ctx.bass.curve },
      analytics,
      finance: ctx.finance && { ...ctx.finance, items: ctx.finance.items.map((i) => ({ ...i, provenance: { ...i.provenance, agentIds: i.provenance.agentIds.slice(0, 8) } })) },
      data: { posts: ctx.evidence.length, syntheticPosts: ctx.evidence.filter((e) => e.synthetic).length, signals: ctx.signals.map((s) => ({ id: s.id, q: s.question, p: s.probability })), anchors: ctx.anchors.length, syntheticAnchors: ctx.anchors.filter((a) => a.synthetic).length },
      leakageWarnings: ctx.leakageWarnings,
    },
    null,
    1,
  );
  const system = `${SYSTEM}\n\n## Data bundle\n${bundle}`;

  for (const [order, s] of SECTIONS.entries()) {
    bus.emit({ type: "report.section", id: s.id, title: s.title, order });
    let text = "";
    for await (const chunk of llm.stream(llm.reasoningBackend, { purpose: `report.${s.id}`, system, prompt: `Write the section "${s.title}". ${s.ask}`, maxTokens: 4000, mock: () => s.mock(ctx, analytics) })) {
      text += chunk;
      bus.emit({ type: "report.delta", id: s.id, text: chunk });
    }
    if (ctx.anon) for (const leak of ctx.anon.leaks(text)) ctx.leakageWarnings.push(`Report section "${s.title}" named the real product term "${leak}".`);
    bus.emit({ type: "report.section.done", id: s.id });
  }
  bus.emit({ type: "stage", stage: "report", status: "done", detail: `${SECTIONS.length} sections` });
}
