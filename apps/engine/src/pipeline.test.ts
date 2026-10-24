import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { foldAll, parseJsonl, STAGES, type BacktestCase, type Brief } from "@market/core";
import { loadConfig, REPO_ROOT } from "./config.js";
import { runSimulation } from "./pipeline.js";
import { Anonymizer } from "./connectors/anonymize.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "market-"));
const brief = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "data/briefs/example.json"), "utf8")) as Brief;
const cfg = { ...loadConfig({ mode: "mock", spacetime: false }), fetchai: { enabled: false, bridgeUrl: "" } };

async function run(opts: { backtest?: BacktestCase; population?: number } = {}) {
  const b = { ...(opts.backtest?.brief ?? brief), population: opts.population ?? 120 };
  const out = path.join(tmp, `${Math.random().toString(36).slice(2)}.jsonl`);
  await runSimulation(cfg, { brief: b, label: "test", outFile: out, backtest: opts.backtest });
  const envs = parseJsonl(fs.readFileSync(out, "utf8"));
  return { envs, state: foldAll(envs) };
}

describe("pipeline (mock mode)", () => {
  it("completes every stage and produces a coherent run", async () => {
    const { envs, state } = await run();
    expect(state.status).toBe("ok");
    for (const s of STAGES) expect(["done", "skipped"]).toContain(state.stages[s].status);
    expect(envs.map((e) => e.seq)).toEqual(envs.map((_, i) => i));
    expect(state.personas.size).toBe(120);
    expect(state.adoption).toHaveLength(brief.rounds);
    expect(state.bass?.curve).toHaveLength(13);
    expect(state.finance?.months).toHaveLength(12);
    expect([...state.report.values()].every((s) => s.done && s.text.length > 40)).toBe(true);

    // Provenance: every cited id exists in the run.
    const known = new Set([...state.evidence.map((e) => e.id), ...state.signals.map((s) => s.id), ...state.anchors.map((a) => a.id)]);
    for (const n of state.nodes.values()) for (const id of n.evidenceIds) expect(known.has(id)).toBe(true);
    for (const item of state.finance!.items) for (const id of item.provenance.agentIds) expect(state.personas.has(id)).toBe(true);
    // Fixture data is labelled as such.
    expect(state.evidence.every((e) => e.synthetic)).toBe(true);
  }, 60_000);

  it("is deterministic for a fixed seed", async () => {
    const a = await run({ population: 60 });
    const b = await run({ population: 60 });
    expect(a.state.bass?.m).toBe(b.state.bass?.m);
    expect(a.envs.length).toBe(b.envs.length);
  }, 60_000);

  it("backtests without leaking the real name or outcomes", async () => {
    const bt = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "data/backtests/illustrative-notes-app.json"), "utf8")) as BacktestCase;
    const { envs, state } = await run({ backtest: bt, population: 80 });
    expect(state.backtest?.caseId).toBe(bt.id);
    expect(state.brief?.product.name).toBe(bt.alias);
    const anon = new Anonymizer([bt.realName, ...bt.aliasTerms], bt.alias);
    // Before the scoring step, nothing the simulation saw or said names the product.
    const beforeScore = envs.filter((e) => e.event.type !== "backtest.result" && !(e.event.type.startsWith("report") && JSON.stringify(e.event).includes("backtest")));
    expect(anon.leaks(JSON.stringify(beforeScore))).toEqual([]);
    expect(state.signals.every((s) => s.outcome === undefined)).toBe(true);
    expect(state.evidence.every((e) => !e.publishedAt || e.publishedAt <= state.cutoff!)).toBe(true);
    expect(state.backtest!.misses.length + state.backtest!.hits.length).toBeGreaterThan(0);
  }, 60_000);
});
