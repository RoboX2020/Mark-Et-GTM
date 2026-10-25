/**
 * What actually happened after launch, for the products we backtest. Figures
 * come from the sources listed in data/backtests/*.json; revenue marked
 * "estimate" is units sold × launch price, not a company disclosure.
 */
export interface Outcome {
  caseId: string;
  realName: string;
  verdict: "failed" | "stalled" | "success";
  /** One-line headline a judge can read in two seconds. */
  headline: string;
  units: number;
  unitsLabel: string;
  revenue: number;
  revenueNote: string;
  facts: string[];
  sources: string;
}

export const OUTCOMES: Outcome[] = [
  {
    caseId: "humane-ai-pin",
    realName: "Humane Ai Pin",
    verdict: "failed",
    headline: "Failed: about 10,000 sold, discontinued within 11 months",
    units: 10_000,
    unitsLabel: "≈10,000 sold (10% of Humane's 100,000 goal)",
    revenue: 9_000_000,
    revenueNote: "≈$9M lifetime revenue, over $1M of it returned",
    facts: [
      "Returns outpaced new sales from May to August 2024",
      "Reviews hit overheating, battery life and slow answers",
      "Shut down 28 Feb 2025; assets sold to HP for $116M after raising about $230M",
    ],
    sources: "The Verge via MacRumors and Engadget (Aug 2024), Fortune (Feb 2025)",
  },
  {
    caseId: "rabbit-r1",
    realName: "Rabbit R1",
    verdict: "stalled",
    headline: "Sold fast, then stalled: ≈130,000 units, ≈5,000 daily users",
    units: 130_000,
    unitsLabel: "≈130,000 sold by June 2024",
    revenue: 130_000 * 199,
    revenueNote: "≈$26M estimate (units × $199)",
    facts: [
      "20,000 preorders in two days at CES 2024",
      "Reviews called it unfinished and asked why it isn't an app",
      "By Sept 2024 only ≈5,000 people used one at any time",
    ],
    sources: "The Verge (Jan, Apr, Sept 2024), Forbes (June 2024)",
  },
  {
    caseId: "meta-rayban",
    realName: "Ray-Ban Meta smart glasses",
    verdict: "success",
    headline: "Success: over 2 million sold in about 16 months",
    units: 2_000_000,
    unitsLabel: "2M+ sold by Feb 2025",
    revenue: 2_000_000 * 299,
    revenueNote: "≈$600M estimate (units × $299)",
    facts: [
      "More than 1 million sold in 2024 alone",
      "The previous Ray-Ban Stories sold under 300,000",
      "EssilorLuxottica called it a great success and raised production",
    ],
    sources: "The Verge (Jan 2025), Reuters and UploadVR (Feb 2025)",
  },
];

export function outcomeFor(caseId?: string | null, name?: string | null): Outcome | undefined {
  if (caseId) {
    const hit = OUTCOMES.find((o) => o.caseId === caseId);
    if (hit) return hit;
  }
  const n = (name ?? "").toLowerCase();
  if (!n) return undefined;
  return OUTCOMES.find((o) => {
    const key = o.realName.toLowerCase();
    return n.includes(key) || key.includes(n) || key.split(" ").some((w) => w.length >= 5 && n.includes(w));
  });
}

export const OUTCOME_TONE: Record<Outcome["verdict"], "pos" | "warn" | "neg"> = { success: "pos", stalled: "warn", failed: "neg" };
export const OUTCOME_LABEL: Record<Outcome["verdict"], string> = { success: "Real outcome: success", stalled: "Real outcome: stalled", failed: "Real outcome: failed" };

/** One colour per company, used wherever the three launches sit side by side. */
export const CASE_COLOR: Record<string, string> = { "humane-ai-pin": "#7a3fb0", "rabbit-r1": "#e0662a", "meta-rayban": "#0b7f93" };
