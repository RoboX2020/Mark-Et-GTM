import { z } from "zod";
import { Rng, type AdoptionState, type Interview, type Persona } from "@market/core";
import { briefSummary, lastDecision, type RunContext } from "../context.js";
import { limiter } from "../llm/types.js";
import { THEMES } from "../lexicon.js";

export const QUESTIONS = [
  "In your own words, what is this product and who is it for?",
  "Walk me through how you decided what to do about it.",
  "What bothers you about it, or would stop you from using it?",
  "What would you realistically pay, and why that number?",
  "Where would you expect to hear about something like this, and what message would convince you?",
  "Would you recommend it to a friend? What exactly would you tell them?",
];

const InterviewSchema = z.object({
  answers: z.array(z.string()).describe("One answer per question, in order, first person, 1-3 sentences each"),
  wtp: z.number().describe("Realistic willingness to pay in the product's currency and billing period"),
  priceVerdict: z.enum(["too_cheap", "fair", "too_expensive"]),
  topObjection: z.string().describe("Single biggest hesitation in under 15 words"),
  wouldRecommend: z.boolean(),
});

const SYSTEM = `You are conducting a qualitative customer interview. You answer as the simulated person described, staying fully in character: their background, what they saw, what friends told them, and the decision they made.
Answer honestly and specifically, including doubts. Do not be more positive than the person's history supports. Never claim to be a real, identifiable person.`;

/** Stratified sample across final states so interviews cover adopters, fence-sitters and rejecters. */
export function sampleForInterview(ctx: RunContext): Persona[] {
  const rng = new Rng(`interview:${ctx.brief.seed}`);
  const target = Math.min(24, Math.max(8, Math.round(ctx.personas.length * 0.06)));
  const groups: Record<AdoptionState, Persona[]> = { adopted: [], considering: [], rejected: [], aware: [], unaware: [] };
  for (const p of ctx.personas) groups[lastDecision(ctx, p.id)?.state ?? "unaware"].push(p);
  const quota: [AdoptionState, number][] = [
    ["adopted", 0.35],
    ["considering", 0.3],
    ["rejected", 0.25],
    ["aware", 0.1],
  ];
  const out: Persona[] = [];
  for (const [state, share] of quota) out.push(...rng.sample(groups[state], Math.round(target * share)));
  for (const p of rng.shuffle([...ctx.personas])) {
    if (out.length >= target) break;
    if (!out.includes(p) && lastDecision(ctx, p.id)) out.push(p);
  }
  return out.slice(0, target);
}

export async function runInterviews(ctx: RunContext): Promise<void> {
  const { bus, llm } = ctx;
  const sample = sampleForInterview(ctx);
  bus.emit({ type: "stage", stage: "interviews", status: "running", detail: `${sample.length} interviews with ${llm.reasoningBackend}` });
  const run = limiter(4);
  const system = `${SYSTEM}\n\n## The product they encountered\n${briefSummary(ctx.brief)}`;

  await Promise.all(
    sample.map((p) =>
      run(async () => {
        bus.emit({ type: "interview.started", agentId: p.id });
        const hist = ctx.decisions.get(p.id) ?? [];
        const prompt = [
          `## Who you are\n${p.name}, ${p.ageBand}, ${p.role}. ${p.bio}`,
          `## What happened\n${hist.map((d) => `Round ${d.round}: ${d.exposure === "none" ? "thought it over" : `exposed via ${d.channel ?? "friends"}`}; became ${d.state}. Said: "${d.comment}". Thought: ${d.reasoning}`).join("\n") || "You only heard of it in passing."}`,
          `## Questions\n${QUESTIONS.map((q, i) => `${i + 1}. ${q}`).join("\n")}`,
        ].join("\n\n");
        const { value } = await llm.json(llm.reasoningBackend, { purpose: "interview", system, prompt, schema: InterviewSchema, maxTokens: 6000, mock: () => mockInterview(ctx, p) });
        if (ctx.anon) for (const a of value.answers) for (const leak of ctx.anon.leaks(a)) ctx.leakageWarnings.push(`Interview with ${p.id} mentioned the real product term "${leak}".`);
        const qa = QUESTIONS.map((question, i) => ({ question, answer: value.answers[i] ?? "" }));
        qa.forEach((x, index) => bus.emit({ type: "interview.answer", agentId: p.id, index, question: x.question, answer: x.answer }));
        const interview: Interview = {
          agentId: p.id,
          qa,
          wtp: Math.max(0, value.wtp),
          priceVerdict: value.priceVerdict,
          topObjection: value.topObjection,
          wouldRecommend: value.wouldRecommend,
          evidenceIds: ctx.nodes.filter((n) => p.painIds.includes(n.id)).flatMap((n) => n.evidenceIds.slice(0, 2)),
        };
        ctx.interviews.push(interview);
        bus.emit({ type: "interview.completed", interview });
      }),
    ),
  );
  bus.emit({ type: "stage", stage: "interviews", status: "done", detail: `${ctx.interviews.length} interviews` });
}

function mockInterview(ctx: RunContext, p: Persona): z.infer<typeof InterviewSchema> {
  const rng = new Rng(`iv:${ctx.brief.seed}:${p.id}`);
  const d = lastDecision(ctx, p.id);
  const state = d?.state ?? "aware";
  const b = ctx.brief;
  const cur = b.price.currency === "USD" ? "$" : `${b.price.currency} `;
  const pain = THEMES.find((t) => p.painIds.includes(`pain_${t.id}`) && t.polarity < 0);
  const comp = ctx.nodes.find((n) => n.id === p.competitorIds[0])?.label;
  const wtp = Math.round((d?.wtp ?? p.wtp) * 100) / 100;
  const verdict = wtp < b.price.amount * 0.9 ? "too_expensive" : wtp > b.price.amount * 1.6 ? "too_cheap" : "fair";
  const objection = d?.objection || pain?.objection || (p.traits.skepticism > 0.6 ? "Not convinced it beats what I already use" : "Need to see it work for someone like me");
  const channel = d?.channel ?? p.channelPrefs[0] ?? "word_of_mouth";
  const recommend = state === "adopted" || (state === "considering" && rng.chance(0.4));
  return {
    answers: [
      `It's a ${b.product.category} tool — ${b.product.description.toLowerCase()} Mostly aimed at people like me in ${b.targetMarket}, I think.`,
      state === "adopted"
        ? `I saw it ${channel === "word_of_mouth" ? "from a friend" : `on ${channel.replaceAll("_", " ")}`}, tried it, and it fit how I already work${comp ? ` better than ${comp}` : ""}.`
        : state === "rejected"
          ? `I looked, but ${objection.toLowerCase()}. ${comp ? `${comp} is good enough for me.` : "It wasn't worth switching."}`
          : `I'm still deciding. ${d?.reasoning ?? "I haven't had a reason to try it yet."}`,
      `${objection}.${pain?.id === "privacy" ? " I'd want to know exactly what happens to my data." : ""}`,
      `Honestly about ${cur}${wtp}. ${verdict === "too_expensive" ? `${cur}${b.price.amount} feels like a lot next to free options.` : verdict === "too_cheap" ? "I'd pay more if it really saves time." : "That's in line with what I pay for similar tools."}`,
      `${channel === "word_of_mouth" ? "From friends" : `On ${channel.replaceAll("_", " ")}`}. Show me a real before-and-after, not a hype video.`,
      recommend ? `Yes — I'd say "${d?.comment ?? "it's worth a look"}"` : `Not yet. I'd tell them to wait until ${objection.toLowerCase()} is sorted.`,
    ],
    wtp,
    priceVerdict: verdict,
    topObjection: objection,
    wouldRecommend: recommend,
  };
}
