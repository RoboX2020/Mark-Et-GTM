import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import type { BacktestCase, Brief } from "@market/core";
import { loadConfig, REPO_ROOT, type Mode } from "./config.js";
import { runSimulation, makeSinks } from "./pipeline.js";
import { EventBus } from "./bus.js";
import { LlmRouter } from "./llm/router.js";
import { runMarketBacktest, type MarketCase } from "./stages/backtest.js";

const PORTAL_RUNS = path.join(REPO_ROOT, "apps/portal/public/runs");

interface ManifestEntry {
  id: string;
  file: string;
  label: string;
  kind: "simulation" | "backtest" | "market_backtest";
  mode: string;
  createdAt: string;
}

/** Copies a finished run into the portal's static folder so it can be replayed offline. */
function publish(file: string, entry: Omit<ManifestEntry, "file" | "createdAt">) {
  fs.mkdirSync(PORTAL_RUNS, { recursive: true });
  const name = `${entry.id}.jsonl`;
  fs.copyFileSync(file, path.join(PORTAL_RUNS, name));
  const manifestPath = path.join(PORTAL_RUNS, "index.json");
  const manifest: ManifestEntry[] = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, "utf8")) : [];
  const next = [{ ...entry, file: name, createdAt: new Date().toISOString() }, ...manifest.filter((m) => m.id !== entry.id)];
  fs.writeFileSync(manifestPath, JSON.stringify(next, null, 2));
  console.log(`  published to portal: runs/${name}`);
}

const readJson = <T>(p: string): T => JSON.parse(fs.readFileSync(path.resolve(REPO_ROOT, p), "utf8")) as T;

async function main() {
  const [cmd = "demo", ...rest] = process.argv.slice(2).filter((a) => a !== "--");
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      brief: { type: "string" },
      mode: { type: "string" },
      population: { type: "string" },
      rounds: { type: "string" },
      label: { type: "string" },
      id: { type: "string" },
      spacetime: { type: "boolean" },
      file: { type: "string" },
      publish: { type: "boolean", default: true },
    },
  });
  const mode = values.mode as Mode | undefined;
  const tweak = (b: Brief): Brief => ({
    ...b,
    population: values.population ? Number(values.population) : b.population,
    rounds: values.rounds ? Number(values.rounds) : b.rounds,
  });

  switch (cmd) {
    case "demo":
    case "simulate": {
      const cfg = loadConfig({ mode: mode ?? (cmd === "demo" ? "mock" : undefined), spacetime: values.spacetime });
      const brief = tweak(readJson<Brief>(values.brief ?? "data/briefs/example.json"));
      const id = values.id ?? (cmd === "demo" ? "demo" : undefined);
      const label = values.label ?? `${brief.product.name} · ${brief.price.currency} ${brief.price.amount}`;
      console.log(`▶ ${cmd} "${label}" mode=${cfg.mode} population=${brief.population} rounds=${brief.rounds}`);
      const { runId, file } = await runSimulation(cfg, { brief, label, runId: id });
      console.log(`✓ ${runId} → ${path.relative(REPO_ROOT, file)}`);
      if (values.publish) publish(file, { id: runId, label, kind: "simulation", mode: cfg.mode });
      break;
    }
    case "backtest": {
      const cfg = loadConfig({ mode, spacetime: values.spacetime });
      const caseId = positionals[0] ?? "illustrative-notes-app";
      const bt = readJson<BacktestCase>(`data/backtests/${caseId}.json`);
      const brief = tweak(bt.brief);
      const label = `Backtest · ${bt.alias}`;
      console.log(`▶ backtest ${caseId} as "${bt.alias}" mode=${cfg.mode}`);
      const { runId, file } = await runSimulation(cfg, { brief, label, backtest: bt, runId: values.id ?? `backtest_${caseId}` });
      console.log(`✓ ${runId} → ${path.relative(REPO_ROOT, file)}`);
      if (values.publish) publish(file, { id: runId, label, kind: "backtest", mode: cfg.mode });
      break;
    }
    case "backtest-markets": {
      const cfg = loadConfig({ mode, spacetime: values.spacetime });
      const cases = readJson<MarketCase[]>(values.file ?? "data/backtests/markets-illustrative.json");
      const runId = values.id ?? "market_backtest";
      const file = path.join(cfg.dataDir, "runs", `${runId}.jsonl`);
      const bus = new EventBus(runId, makeSinks(cfg, file), { virtualTime: cfg.mode !== "live" });
      const llm = new LlmRouter(cfg, bus);
      const stub: Brief = readJson<Brief>("data/briefs/example.json");
      bus.emit({ type: "run.started", brief: stub, mode: cfg.mode, label: "Prediction-market backtest", cutoff: cases[0]?.cutoff });
      for (const s of ["ingest", "graph", "population", "network", "simulation", "interviews", "bass", "finance", "report"] as const) bus.emit({ type: "stage", stage: s, status: "skipped" });
      const rows = await runMarketBacktest(bus, llm, cases);
      bus.emit({ type: "run.completed", status: "ok", usage: llm.usage.byKey });
      await bus.close();
      const sb = rows.reduce((a, r) => a + r.swarmBrier, 0) / rows.length;
      const mb = rows.reduce((a, r) => a + r.marketBrier, 0) / rows.length;
      console.log(`✓ ${rows.length} questions — Brier swarm ${sb.toFixed(3)} vs market ${mb.toFixed(3)}`);
      if (values.publish) publish(file, { id: runId, label: "Prediction-market backtest", kind: "market_backtest", mode: cfg.mode });
      break;
    }
    default:
      console.log("usage: engine <demo|simulate|backtest|backtest-markets> [--brief path] [--mode live|cache|mock] [--population n] [--spacetime]");
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
