import crypto from "node:crypto";
import path from "node:path";
import type { BacktestCase, Brief } from "@market/core";
import { EventBus, type Sink } from "./bus.js";
import { Cache } from "./cache.js";
import type { EngineConfig } from "./config.js";
import { Anonymizer } from "./connectors/anonymize.js";
import { createContext } from "./context.js";
import { LlmRouter } from "./llm/router.js";
import { ConsoleSink, JsonlSink, SpacetimeSink } from "./sinks/index.js";
import { ingest } from "./stages/ingest.js";
import { buildGraph } from "./stages/graph.js";
import { buildNetwork, buildPopulation } from "./stages/population.js";
import { simulate } from "./stages/simulate.js";
import { runInterviews } from "./stages/interviews.js";
import { fitAdoption, forecastFinance } from "./stages/forecast.js";
import { writeReport } from "./stages/report.js";
import { scoreBacktest } from "./stages/backtest.js";

export interface RunOptions {
  brief: Brief;
  label: string;
  runId?: string;
  backtest?: BacktestCase;
  outFile?: string;
}

export function makeSinks(cfg: EngineConfig, outFile: string): Sink[] {
  const sinks: Sink[] = [new JsonlSink(outFile), new ConsoleSink()];
  if (cfg.spacetime.enabled) sinks.push(new SpacetimeSink(cfg.spacetime.uri, cfg.spacetime.db, cfg.spacetime.token));
  return sinks;
}

export async function runSimulation(cfg: EngineConfig, opts: RunOptions): Promise<{ runId: string; file: string }> {
  const runId = opts.runId ?? `run_${new Date().toISOString().slice(0, 10)}_${crypto.randomBytes(3).toString("hex")}`;
  const file = opts.outFile ?? path.join(cfg.dataDir, "runs", `${runId}.jsonl`);
  // Mock runs complete in milliseconds; stamp them with realistic durations so replays breathe.
  const bus = new EventBus(runId, makeSinks(cfg, file), { virtualTime: cfg.mode !== "live", startTs: Date.parse(`${opts.brief.launchDate}T09:00:00Z`) - 86400_000 });
  const llm = new LlmRouter(cfg, bus);
  const cache = new Cache(path.join(cfg.dataDir, "cache", "live"), cfg.mode);

  const bt = opts.backtest;
  const anon = bt ? new Anonymizer([bt.realName, ...bt.aliasTerms], bt.alias) : undefined;
  const brief = anon ? anon.brief(opts.brief) : opts.brief;
  // Only data from before launch day is admissible.
  const cutoff = new Date(Date.parse(opts.brief.launchDate) - 86400_000).toISOString();

  const ctx = createContext({ cfg, bus, llm, cache, brief, cutoff, anon, backtest: bt });
  bus.emit({ type: "run.started", brief, mode: cfg.mode, label: opts.label, backtestCaseId: bt?.id, cutoff });
  bus.log(`LLM routing: ${llm.describe()}`);

  let status: "ok" | "error" = "ok";
  try {
    await ingest(ctx);
    await buildGraph(ctx);
    await buildPopulation(ctx);
    await buildNetwork(ctx);
    await simulate(ctx);
    await runInterviews(ctx);
    await fitAdoption(ctx);
    const analytics = await forecastFinance(ctx);
    await writeReport(ctx, analytics);
    if (bt) await scoreBacktest(ctx, analytics);
    else bus.emit({ type: "stage", stage: "backtest", status: "skipped" });
  } catch (err) {
    status = "error";
    bus.log(`Run failed: ${(err as Error).stack ?? err}`, "error");
  }
  bus.emit({ type: "run.completed", status, usage: llm.usage.byKey });
  await bus.close();
  return { runId, file };
}
