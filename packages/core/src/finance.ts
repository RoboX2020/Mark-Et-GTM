import type { BassFit, Brief, Channel, ChannelEconomics, FinanceForecast, FinanceMonth, Provenance } from "./domain.js";
import { bassF } from "./bass.js";
import { clamp01, median } from "./rng.js";

export const REVIEW_THRESHOLD = 0.5;
const FREEMIUM_PAID_SHARE = 0.05;

export interface ChannelAttribution {
  channel: Channel;
  /** Simulated adopters whose first exposure came through this channel. */
  adopterIds: string[];
  evidenceIds: string[];
}

export interface FinanceInputs {
  brief: Brief;
  bass: BassFit;
  wtp: { agentId: string; wtp: number }[];
  attribution: ChannelAttribution[];
  /** Agents and evidence behind the adoption curve itself. */
  adoptionAgentIds: string[];
  adoptionEvidenceIds: string[];
  horizon?: number;
}

export function provenance(agentIds: string[], evidenceIds: string[], confidence: number, note?: string): Provenance {
  const c = clamp01(confidence);
  return { agentIds, evidenceIds, confidence: c, needsReview: c < REVIEW_THRESHOLD, note };
}

/** Confidence from sample size: ~0.5 at 8 observations, ~0.8 at 30. */
export function sampleConfidence(n: number, evidence = 10): number {
  const sampleTerm = 1 - 1 / Math.sqrt(1 + n / 2);
  const evidenceTerm = Math.min(1, 0.55 + evidence / 25);
  return clamp01(sampleTerm * evidenceTerm);
}

export function channelSplit(brief: Brief): Map<Channel, number> {
  const paid = brief.channels.filter((c) => c !== "word_of_mouth");
  const explicit = brief.budget.channelSplit ?? {};
  const assigned = paid.reduce((a, c) => a + (explicit[c] ?? 0), 0);
  const unassigned = paid.filter((c) => explicit[c] === undefined);
  const rest = Math.max(0, 1 - assigned);
  const out = new Map<Channel, number>();
  for (const c of paid) out.set(c, explicit[c] ?? (unassigned.length ? rest / unassigned.length : 0));
  const total = [...out.values()].reduce((a, b) => a + b, 0) || 1;
  for (const [c, v] of out) out.set(c, v / total);
  return out;
}

export function computeFinance(input: FinanceInputs): FinanceForecast {
  const { brief, bass } = input;
  const horizon = input.horizon ?? 12;
  const { amount, model } = brief.price;
  const b = brief.budget;
  const reach = brief.addressableMarket;

  const months: FinanceMonth[] = [];
  let active = 0;
  let cash = b.startingCash;
  let breakEvenMonth: number | null = null;
  let minCash = cash;
  let totalNew = 0;
  let totalRevenue = 0;

  for (let t = 1; t <= horizon; t++) {
    const newCustomers = Math.max(0, Math.round(reach * bass.m * (bassF(t, bass.p, bass.q) - bassF(t - 1, bass.p, bass.q))));
    totalNew += newCustomers;
    let revenue: number;
    switch (model) {
      case "subscription_monthly":
        active = Math.round(active * (1 - b.monthlyChurn)) + newCustomers;
        revenue = active * amount;
        break;
      case "subscription_annual":
        active += newCustomers;
        revenue = newCustomers * amount; // billed upfront; renewals fall outside 12 months
        break;
      case "freemium":
        active = Math.round(active * (1 - b.monthlyChurn)) + newCustomers;
        revenue = active * FREEMIUM_PAID_SHARE * amount;
        break;
      default:
        active += newCustomers;
        revenue = newCustomers * amount;
    }
    const cogs = revenue * b.cogsPct;
    const net = revenue - cogs - b.monthlyMarketing - b.fixedMonthlyCosts;
    cash += net;
    minCash = Math.min(minCash, cash);
    totalRevenue += revenue;
    if (breakEvenMonth === null && net >= 0) breakEvenMonth = t;
    months.push({ month: t, newCustomers, activeCustomers: active, revenue, marketing: b.monthlyMarketing, cogs, fixed: b.fixedMonthlyCosts, net, cash });
  }

  const lastNet = months[months.length - 1]?.net ?? 0;
  const burn = -Math.min(0, lastNet);
  const runwayMonths = cash <= 0 ? 0 : burn > 0 ? Math.floor(cash / burn) : null;

  // Channel economics: attribute the forecast's new customers by the simulated first-touch mix.
  const totalAdopters = input.attribution.reduce((a, c) => a + c.adopterIds.length, 0) || 1;
  const split = channelSplit(brief);
  const yearSpend = b.monthlyMarketing * horizon;
  const channels: ChannelEconomics[] = [];
  const allChannels = new Set<Channel>([...split.keys(), ...input.attribution.map((a) => a.channel)]);
  for (const ch of allChannels) {
    const att = input.attribution.find((a) => a.channel === ch);
    const n = att?.adopterIds.length ?? 0;
    const share = n / totalAdopters;
    const customers = Math.round(totalNew * share);
    const spend = yearSpend * (split.get(ch) ?? 0);
    const conf = sampleConfidence(n, att?.evidenceIds.length ?? 0);
    channels.push({
      channel: ch,
      spend,
      customers,
      cac: customers > 0 ? spend / customers : null,
      conversionShare: share,
      provenance: provenance(
        att?.adopterIds ?? [],
        att?.evidenceIds ?? [],
        conf,
        n < 8 ? `Only ${n} simulated adopters came through ${ch}; treat CAC as directional.` : undefined,
      ),
    });
  }
  channels.sort((a, b) => b.customers - a.customers);

  const wtps = input.wtp.map((w) => w.wtp).filter((x) => Number.isFinite(x));
  const wtpMedian = median(wtps);
  // Revenue per active customer-month.
  const customerMonths = months.reduce((a, m) => a + m.activeCustomers, 0);
  const arpu = customerMonths ? totalRevenue / customerMonths : 0;

  const fitConf = clamp01(
    (1 - Math.min(1, bass.rmse * 20)) * Math.min(1, bass.observed.length / 6) * (input.adoptionAgentIds.length >= 20 ? 1 : 0.6),
  );
  const extrapolationPenalty = Math.min(1, (bass.observed.length || 1) / horizon) ** 0.5;
  const adoptionProv = provenance(
    input.adoptionAgentIds,
    input.adoptionEvidenceIds,
    fitConf * (0.5 + 0.5 * extrapolationPenalty),
    `Fitted on ${bass.observed.length} simulated months, extrapolated to ${horizon}.`,
  );
  const wtpProv = provenance(
    input.wtp.map((w) => w.agentId),
    [],
    sampleConfidence(wtps.length, 12),
    "Median of interviewed agents' stated willingness to pay.",
  );

  return {
    currency: brief.price.currency,
    months,
    channels,
    breakEvenMonth,
    totalRevenue12: totalRevenue,
    minCash,
    runwayMonths,
    arpu,
    wtpMedian,
    items: [
      { key: "revenue12", label: "12-month revenue", value: totalRevenue, unit: brief.price.currency, provenance: adoptionProv },
      { key: "customers12", label: "Customers acquired (12 mo)", value: totalNew, unit: "customers", provenance: adoptionProv },
      { key: "m", label: "Eventual adoption (share of addressable market)", value: bass.m, unit: "fraction", provenance: adoptionProv },
      {
        key: "breakEven",
        label: "Break-even month",
        value: breakEvenMonth ?? -1,
        unit: "month",
        provenance: { ...adoptionProv, note: breakEvenMonth ? adoptionProv.note : "No break-even within the horizon." },
      },
      { key: "minCash", label: "Lowest cash balance", value: minCash, unit: brief.price.currency, provenance: adoptionProv },
      { key: "wtpMedian", label: "Median willingness to pay", value: wtpMedian, unit: brief.price.currency, provenance: wtpProv },
    ],
  };
}
