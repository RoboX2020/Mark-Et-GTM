import { describe, expect, it } from "vitest";
import { bassF, fitBass } from "./bass.js";
import { computeFinance, channelSplit } from "./finance.js";
import { foldAll } from "./fold.js";
import { mape, phraseOverlap } from "./metrics.js";
import { Rng } from "./rng.js";
import type { Brief } from "./domain.js";
import type { EventEnvelope } from "./events.js";

const brief: Brief = {
  product: { name: "Test", description: "x", category: "saas" },
  price: { amount: 20, currency: "USD", model: "subscription_monthly" },
  targetMarket: "devs",
  geography: "US",
  competitors: [],
  channels: ["reddit", "product_hunt", "word_of_mouth"],
  launchDate: "2026-01-01",
  addressableMarket: 100_000,
  population: 100,
  rounds: 6,
  monthsPerRound: 1,
  seed: 1,
  budget: { startingCash: 200_000, monthlyMarketing: 10_000, fixedMonthlyCosts: 20_000, cogsPct: 0.2, monthlyChurn: 0.05 },
};

describe("bass", () => {
  it("recovers parameters from a clean curve", () => {
    const [p, q, m] = [0.01, 0.4, 0.3];
    const observed = Array.from({ length: 10 }, (_, i) => ({ month: i + 1, cumulative: m * bassF(i + 1, p, q), newAdopters: 0 }));
    const fit = fitBass(observed, { mPrior: 0.3 });
    expect(fit.p).toBeCloseTo(p, 2);
    expect(fit.q).toBeCloseTo(q, 1);
    expect(fit.m).toBeCloseTo(m, 1);
    expect(fit.rmse).toBeLessThan(1e-3);
    expect(fit.curve).toHaveLength(13);
  });
});

describe("finance", () => {
  it("produces 12 months with provenance and review flags", () => {
    const fit = fitBass(
      Array.from({ length: 6 }, (_, i) => ({ month: i + 1, cumulative: 0.25 * bassF(i + 1, 0.02, 0.5), newAdopters: 0 })),
    );
    const f = computeFinance({
      brief,
      bass: fit,
      wtp: [15, 18, 22, 30].map((wtp, i) => ({ agentId: `a${i}`, wtp })),
      attribution: [
        { channel: "reddit", adopterIds: Array.from({ length: 30 }, (_, i) => `r${i}`), evidenceIds: ["e1", "e2"] },
        { channel: "product_hunt", adopterIds: ["p1", "p2"], evidenceIds: [] },
      ],
      adoptionAgentIds: Array.from({ length: 40 }, (_, i) => `a${i}`),
      adoptionEvidenceIds: ["e1"],
    });
    expect(f.months).toHaveLength(12);
    expect(f.wtpMedian).toBe(20);
    const ph = f.channels.find((c) => c.channel === "product_hunt")!;
    expect(ph.provenance.needsReview).toBe(true);
    const rd = f.channels.find((c) => c.channel === "reddit")!;
    expect(rd.provenance.confidence).toBeGreaterThan(ph.provenance.confidence);
    expect(f.months[11].cash).toBeCloseTo(brief.budget.startingCash + f.months.reduce((a, m) => a + m.net, 0));
  });

  it("splits budget across paid channels only", () => {
    const s = channelSplit({ ...brief, budget: { ...brief.budget, channelSplit: { reddit: 0.7 } } });
    expect(s.get("reddit")).toBeCloseTo(0.7);
    expect(s.get("product_hunt")).toBeCloseTo(0.3);
    expect(s.has("word_of_mouth")).toBe(false);
  });
});

describe("fold", () => {
  it("folds a minimal run", () => {
    const envs: EventEnvelope[] = [
      { runId: "r", seq: 0, ts: 0, event: { type: "run.started", brief, mode: "mock", label: "t" } },
      { runId: "r", seq: 1, ts: 1, event: { type: "graph.node", node: { id: "s1", kind: "segment", label: "Indie devs", weight: 0.4, evidenceIds: [] } } },
      { runId: "r", seq: 2, ts: 2, event: { type: "report.section", id: "x", title: "X", order: 0 } },
      { runId: "r", seq: 3, ts: 3, event: { type: "report.delta", id: "x", text: "hello " } },
      { runId: "r", seq: 4, ts: 4, event: { type: "report.delta", id: "x", text: "world" } },
    ];
    const s = foldAll(envs);
    expect(s.nodes.size).toBe(1);
    expect(s.report.get("x")!.text).toBe("hello world");
    expect(s.status).toBe("running");
  });
});

describe("metrics + rng", () => {
  it("scores", () => {
    expect(mape([{ month: 1, cumulative: 0.1 }, { month: 3, cumulative: 0.3 }], [{ month: 2, cumulative: 0.25 }])).toBeCloseTo(0.2);
    expect(phraseOverlap(["too expensive for students"], ["price too expensive"]).score).toBeGreaterThan(0.3);
    const a = new Rng(5);
    const b = new Rng(5);
    expect(a.next()).toBe(b.next());
  });
});
