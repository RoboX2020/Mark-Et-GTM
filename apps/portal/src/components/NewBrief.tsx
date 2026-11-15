import { useEffect, useState, type ChangeEvent } from "react";
import type { Brief, Channel, PriceModel } from "@market/core";
import { fetchHealth, startServerRun, type RunEntry, type ServerHealth } from "../lib/player";

const CHANNELS: Channel[] = ["tiktok", "reddit", "x", "product_hunt", "app_store", "word_of_mouth"];

function briefFrom(form: {
  name: string;
  description: string;
  category: string;
  price: string;
  market: string;
  competitors: string;
  launchDate: string;
  population: string;
}): Brief {
  const competitors = form.competitors.split(",").map((s) => s.trim()).filter(Boolean);
  return {
    product: { name: form.name.trim() || "Untitled", description: form.description.trim(), category: form.category.trim() || "product" },
    price: { amount: Number(form.price) || 0, currency: "USD", model: "subscription_monthly" as PriceModel },
    targetMarket: form.market.trim() || "general",
    geography: "US",
    competitors,
    channels: CHANNELS,
    launchDate: form.launchDate,
    addressableMarket: 60000,
    population: Math.min(1000, Math.max(40, Number(form.population) || 120)),
    rounds: 6,
    monthsPerRound: 1,
    seed: 42,
    budget: {
      startingCash: 250000,
      monthlyMarketing: 15000,
      fixedMonthlyCosts: 22000,
      cogsPct: 0.18,
      monthlyChurn: 0.06,
    },
  };
}

/** Compose a launch brief; run it on the Mark8 server when one is reachable, else download it. */
export function NewBrief({ onClose, onStarted }: { onClose: () => void; onStarted?: (entry: RunEntry) => void }) {
  const [form, setForm] = useState({
    name: "",
    description: "",
    category: "",
    price: "8",
    market: "",
    competitors: "",
    launchDate: "2026-09-01",
    population: "120",
  });
  const [copied, setCopied] = useState(false);
  const [health, setHealth] = useState<ServerHealth | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm({ ...form, [k]: e.target.value });

  useEffect(() => {
    let cancelled = false;
    fetchHealth().then((h) => {
      if (!cancelled) setHealth(h);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function runNow() {
    setStarting(true);
    setError(null);
    try {
      const entry = await startServerRun({
        name: form.name.trim() || undefined,
        idea: form.description.trim(),
        category: form.category.trim() || undefined,
        price: Number(form.price) || 0,
        market: form.market.trim() || undefined,
        competitors: form.competitors.split(",").map((s) => s.trim()).filter(Boolean),
        population: Number(form.population) || 120,
      });
      onStarted?.(entry);
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setStarting(false);
    }
  }

  function download() {
    const brief = briefFrom(form);
    const blob = new Blob([JSON.stringify(brief, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${brief.product.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "brief"}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function copyCommand() {
    const name = form.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-") || "brief";
    const cmd = `pnpm --filter @market/engine simulate -- --mode live --brief data/briefs/${name}.json --population ${form.population || 120}`;
    await navigator.clipboard.writeText(cmd);
    setCopied(true);
  }

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <div className="drawer">
        <div className="row between" style={{ marginBottom: 12 }}>
          <span className="eyebrow">New brief</span>
          <button className="btn icon" onClick={onClose} aria-label="Close">×</button>
        </div>
        {health ? (
          <p className="subtle" style={{ marginTop: 0 }}>
            Runs now on the server ({health.mode === "live" ? `live ${health.model} agents` : "demo agents - no model calls"}). A population of AI-generated
            synthetic customers reacts and sits for interviews. <strong>Results are simulated - not real customer validation.</strong>
            {health.budget && health.budget.billableRuns !== "operator-only" ? ` Test budget remaining: $${health.budget.remainingUsd.toFixed(2)}.` : ""}
          </p>
        ) : (
          <p className="subtle" style={{ marginTop: 0 }}>
            The hosted site replays finished runs. Save this brief, then run the engine where your API keys live. The new log shows up in the run picker after you publish it into <span className="mono">apps/portal/public/runs</span>.
          </p>
        )}
        <div className="stack">
          <label className="field">Name<input value={form.name} onChange={set("name")} placeholder="Tandem" /></label>
          <label className="field">What it does<textarea value={form.description} onChange={set("description")} rows={3} placeholder="One sentence a customer would recognise." /></label>
          <label className="field">Category<input value={form.category} onChange={set("category")} placeholder="study planner" /></label>
          <div className="row wrap">
            <label className="field" style={{ flex: 1 }}>Monthly price (USD)<input value={form.price} onChange={set("price")} inputMode="decimal" /></label>
            <label className="field" style={{ flex: 1 }}>Launch<input type="date" value={form.launchDate} onChange={set("launchDate")} /></label>
          </div>
          <label className="field">Who it is for<input value={form.market} onChange={set("market")} placeholder="university students" /></label>
          <label className="field">Competitors, comma separated<input value={form.competitors} onChange={set("competitors")} placeholder="Notion, MyStudyLife" /></label>
          <label className="field">Synthetic customers<input value={form.population} onChange={set("population")} inputMode="numeric" /></label>
          {error && <p className="subtle" style={{ color: "var(--bad, #c33)", margin: 0 }}>{error}</p>}
          <div className="row wrap">
            {health && health.budget?.billableRuns === "operator-only" ? (
              // Visitors must see the restriction plainly, not a button that 403s.
              <p className="subtle" style={{ margin: 0 }}>
                Live runs are operator-only while the runtime budget is being settled. Every finished run below is open.
              </p>
            ) : health && !health.budget ? (
              <button className="btn" onClick={runNow} disabled={starting || !form.description.trim()}>
                {starting ? "Starting…" : "Run simulation"}
              </button>
            ) : null}
            <button className="btn" onClick={download}>Download brief</button>
            <button className="btn" onClick={copyCommand}>{copied ? "Copied" : "Copy engine command"}</button>
          </div>
        </div>
      </div>
    </>
  );
}
