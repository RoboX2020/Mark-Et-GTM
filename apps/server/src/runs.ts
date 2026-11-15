import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Brief } from "@market/core";
import { runSimulation } from "@market/engine/pipeline";
import type { EngineConfig } from "@market/engine/config";
import type { ClientWrap } from "@market/engine/llm/router";
import { Budget } from "./budget.js";
import { estimateRunCostUsd } from "./brief.js";

export interface RunRec {
  id: string;
  label: string;
  kind: "simulation";
  mode: string;
  createdAt: string;
  file: string; // jsonl filename, served under /api/runs/
  status: "running" | "ok" | "error" | "refused";
  error?: string;
}

/** One manifest entry in the exact shape the portal's run picker already reads. */
export function toManifestEntry(r: RunRec) {
  return { id: r.id, file: r.file, label: r.label, kind: r.kind, mode: r.mode, createdAt: r.createdAt, status: r.status };
}

export class RefusedError extends Error {}

const DAY_MS = 86400_000;

/**
 * Owns run lifecycle and the public-surface protections:
 * - one run at a time (a run is minutes of model calls; queueing is a later problem);
 * - per-IP and global daily run caps (visitor drain protection);
 * - a worst-case pre-flight cost estimate refused when it would pass the per-run cap
 *   or the remaining total budget.
 * All caps are app-side and independent of any billing-side state.
 */
export class RunManager {
  private runs = new Map<string, RunRec>();
  private active = false;
  private ipLog = new Map<string, number[]>(); // ip -> run start timestamps
  private globalLog: number[] = [];

  constructor(
    private cfg: EngineConfig,
    private runsDir: string,
    private opts: {
      budget?: Budget; // required in live mode, absent in mock
      ledgerHealthy?: () => boolean; // false = durable spend store lost: refuse billable runs
      model: string;
      wrapClient?: ClientWrap;
      perRunCapUsd: number;
      maxRunsPerIpPerDay: number;
      maxRunsPerDay: number;
    },
  ) {
    fs.mkdirSync(runsDir, { recursive: true });
  }

  private countSince(log: number[], since: number): number {
    return log.filter((t) => t > since).length;
  }

  list(): RunRec[] {
    return [...this.runs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): RunRec | undefined {
    return this.runs.get(id);
  }

  async start(brief: Brief, label: string, ip: string): Promise<RunRec> {
    const now = Date.now();
    const dayAgo = now - DAY_MS;
    if (this.active) throw new RefusedError("a simulation is already running; try again shortly");
    if (this.countSince(this.ipLog.get(ip) ?? [], dayAgo) >= this.opts.maxRunsPerIpPerDay)
      throw new RefusedError("daily run limit reached for this visitor");
    if (this.countSince(this.globalLog, dayAgo) >= this.opts.maxRunsPerDay)
      throw new RefusedError("daily run limit reached; try again tomorrow");

    if (this.opts.budget) {
      // Fail closed: without a writable durable ledger the cap cannot be trusted.
      if (this.opts.ledgerHealthy && !this.opts.ledgerHealthy())
        throw new RefusedError("run refused: the spend ledger is unavailable, so billable runs are closed");
      const estimate = estimateRunCostUsd(brief, this.opts.model, this.cfg.swarmBatch);
      if (estimate > this.opts.perRunCapUsd)
        throw new RefusedError(`run refused: worst-case estimate $${estimate.toFixed(2)} exceeds the per-run cap $${this.opts.perRunCapUsd.toFixed(2)}`);
      if (estimate > this.opts.budget.remaining)
        throw new RefusedError("run refused: the remaining test budget cannot cover the worst-case estimate");
    }

    const id = `run_${new Date().toISOString().slice(0, 10)}_${crypto.randomBytes(3).toString("hex")}`;
    const file = `${id}.jsonl`;
    const rec: RunRec = { id, label, kind: "simulation", mode: this.cfg.mode, createdAt: new Date().toISOString(), file, status: "running" };
    this.runs.set(id, rec);
    this.active = true;
    this.ipLog.set(ip, [...(this.ipLog.get(ip) ?? []), now]);
    this.globalLog.push(now);

    runSimulation(this.cfg, {
      brief,
      label,
      runId: id,
      outFile: path.join(this.runsDir, file),
      wrapClient: this.opts.wrapClient,
    })
      .then(() => {
        rec.status = "ok";
      })
      .catch((err) => {
        rec.status = "error";
        rec.error = String((err as Error)?.message ?? err).slice(0, 300);
      })
      .finally(() => {
        this.active = false;
      });
    return rec;
  }
}
