import type { AdoptionState, Brief, NodeKind } from "@market/core";

export const pct = (x: number, d = 0) => `${(x * 100).toFixed(d)}%`;

export function money(x: number, brief?: Brief | null, compact = false): string {
  const cur = brief?.price.currency ?? "USD";
  const sym = cur === "USD" ? "$" : cur === "GBP" ? "£" : cur === "EUR" ? "€" : `${cur} `;
  const abs = Math.abs(x);
  const s =
    compact && abs >= 1e6 ? `${(abs / 1e6).toFixed(1)}M` : compact && abs >= 1e4 ? `${(abs / 1e3).toFixed(0)}k` : abs >= 100 ? Math.round(abs).toLocaleString("en-US") : abs.toFixed(abs >= 10 ? 0 : 2);
  return `${x < 0 ? "−" : ""}${sym}${s}`;
}

export const int = (x: number) => Math.round(x).toLocaleString("en-US");

export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export const STATE_LABEL: Record<AdoptionState, string> = {
  unaware: "Unaware",
  aware: "Aware",
  considering: "Considering",
  adopted: "Adopted",
  rejected: "Rejected",
};

export const KIND_LABEL: Record<NodeKind, string> = {
  product: "Product",
  segment: "Segment",
  pain: "Pain point",
  trend: "Trend / desire",
  competitor: "Competitor",
  price_point: "Price point",
  condition: "Market condition",
  channel: "Channel",
};

export const KIND_COLOR: Record<NodeKind, string> = {
  product: "var(--k-product)",
  segment: "var(--k-segment)",
  pain: "var(--k-pain)",
  trend: "var(--k-trend)",
  competitor: "var(--k-competitor)",
  price_point: "var(--k-price)",
  condition: "var(--k-condition)",
  channel: "var(--k-channel)",
};

export const label = (s: string) => s.replaceAll("_", " ");

export function sentimentClass(x: number): "pos" | "neg" | "" {
  return x > 0.15 ? "pos" : x < -0.15 ? "neg" : "";
}
