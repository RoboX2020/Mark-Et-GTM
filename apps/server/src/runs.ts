import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Brief } from "@market/core";
import { runSimulation } from "@market/engine/pipeline";
import type { EngineConfig } from "@market/engine/config";
import type { ClientWrap } from "@market/engine/llm/router";
import { Budget } from "./budget.js";
import { estimateRunCostUsd } from "./brief.js";
import type { SpendStore } from "./ledger.js";

/** Sidecar metadata for one run: who may see it and what it is. Privacy fails
 *  closed - a run without a readable sidecar is treated as PRIVATE. */
export interface RunMeta {
  label?: string;
  showcase?: boolean; // true only for clearly fictional public examples
  createdAt?: string;
  status?: RunRec["status"];
}

export interface RunRec {
  id: string;
  label: string;
  kind: "simulation";
  mode: string;
  createdAt: string;
  file: string; // jsonl filename, served under /api/runs/
  status: "running" | "ok" | "error" | "refused";
  error?: string;
  /** Public replay is opt-in: only clearly fictional showcase runs are listed
   *  and served to visitors. Real briefs and test runs stay operator-only. */
  showcase: boolean;
  /** True once the run's artifacts are confirmed in durable remote storage. */
  archived: boolean;
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
      runStore?: SpendStore; // durable remote retention for run artifacts (survives disk wipes)
      perRunCapUsd: number;
      maxRunsPerIpPerDay: number;
      maxRunsPerDay: number;
    },
  ) {
    fs.mkdirSync(runsDir, { recursive: true });
    // Rebuild the manifest from disk: covers restarts while the disk survives.
    // Disk-wipe recovery (free-tier spin-downs) comes from recoverFromStore().
    for (const file of fs.readdirSync(runsDir).filter((f) => f.endsWith(".jsonl"))) {
      this.addFromDisk(file);
    }
  }

  private metaPath(id: string): string {
    return path.join(this.runsDir, `${id}.meta.json`);
  }

  private readMeta(id: string): RunMeta {
    try {
      return JSON.parse(fs.readFileSync(this.metaPath(id), "utf8")) as RunMeta;
    } catch {
      return {}; // privacy fails closed: unknown = not showcase
    }
  }

  private writeMeta(id: string, meta: RunMeta): void {
    try {
      fs.writeFileSync(this.metaPath(id), JSON.stringify(meta));
    } catch (err) {
      console.error(`[runs] meta write failed for ${id}: ${(err as Error).message}`);
    }
  }

  private addFromDisk(file: string): void {
    const id = file.replace(/\.jsonl$/, "");
    if (this.runs.has(id)) return;
    try {
      const first = JSON.parse(fs.readFileSync(path.join(this.runsDir, file), "utf8").split("\n", 1)[0]) as {
        event?: { type?: string; label?: string; brief?: { product?: { name?: string } }; mode?: string };
      };
      const ev = first.event ?? {};
      if (ev.type !== "run.started") return;
      const stat = fs.statSync(path.join(this.runsDir, file));
      const meta = this.readMeta(id);
      // The terminal event is the truth; the sidecar is only a fallback. (A
      // pipeline that resolved after a failed run once wrote status ok into the
      // sidecar, and the manifest repeated it.)
      let status: RunRec["status"] = meta.status ?? "ok";
      try {
        const fd = fs.openSync(path.join(this.runsDir, file), "r");
        const tailBuf = Buffer.alloc(Math.min(4096, stat.size));
        fs.readSync(fd, tailBuf, 0, tailBuf.length, Math.max(0, stat.size - tailBuf.length));
        fs.closeSync(fd);
        const lastLine = tailBuf.toString("utf8").trim().split("\n").filter(Boolean).pop() ?? "";
        const last = JSON.parse(lastLine) as { event?: { type?: string; status?: string } };
        if (last.event?.type === "run.completed") status = last.event.status === "error" ? "error" : "ok";
      } catch {
        // no readable terminal event: keep the sidecar's value
      }
      this.runs.set(id, {
        id,
        label: meta.label ?? ev.label ?? ev.brief?.product?.name ?? id,
        kind: "simulation",
        mode: ev.mode ?? this.cfg.mode,
        createdAt: meta.createdAt ?? stat.birthtime.toISOString?.() ?? stat.mtime.toISOString(),
        file,
        status,
        showcase: meta.showcase === true, // private unless explicitly marked
        archived: false,
      });
    } catch {
      // Unparseable file: skip it rather than fail the boot.
    }
  }

  /** Disk-wipe recovery: pull any runs the durable store has that this disk
   *  lost (Render free spin-downs wipe the filesystem). Also the retention
   *  backstop's restore path. Safe to call repeatedly. */
  async recoverFromStore(): Promise<number> {
    const store = this.opts.runStore;
    if (!store?.listRunIds || !store.loadRun) return 0;
    let restored = 0;
    let ids: string[];
    try {
      ids = await store.listRunIds();
    } catch (err) {
      console.error(`[runs] remote run list failed (disk manifest stands): ${(err as Error).message}`);
      return 0;
    }
    for (const id of ids) {
      const file = `${id}.jsonl`;
      if (this.runs.has(id) && fs.existsSync(path.join(this.runsDir, file))) continue;
      try {
        const art = await store.loadRun(id);
        if (!art) continue;
        fs.writeFileSync(path.join(this.runsDir, file), art.log);
        if (art.meta) fs.writeFileSync(this.metaPath(id), art.meta);
        this.runs.delete(id);
        this.addFromDisk(file);
        const rec = this.runs.get(id);
        if (rec) rec.archived = true;
        restored++;
      } catch (err) {
        console.error(`[runs] restore failed for ${id}: ${(err as Error).message}`);
      }
    }
    return restored;
  }

  /** Push a finished run's artifacts to durable remote storage. Best-effort:
   *  a failed archive keeps the run on disk and is retried on the next boot's
   *  archive sweep; it never changes the run's visible status. */
  private async archive(id: string): Promise<void> {
    const store = this.opts.runStore;
    if (!store?.saveRun) return;
    const file = path.join(this.runsDir, `${id}.jsonl`);
    try {
      const log = fs.readFileSync(file, "utf8");
      let meta: string | undefined;
      try {
        meta = fs.readFileSync(this.metaPath(id), "utf8");
      } catch {
        meta = undefined;
      }
      await store.saveRun(id, { log, meta });
      const rec = this.runs.get(id);
      if (rec) rec.archived = true;
    } catch (err) {
      console.error(`[runs] archive failed for ${id} (retried next boot): ${(err as Error).message}`);
    }
  }

  /** Boot-time sweep: archive any finished local runs the store is missing
   *  (e.g. completed while the store was down). */
  async archiveSweep(): Promise<number> {
    const store = this.opts.runStore;
    if (!store?.saveRun || !store.listRunIds) return 0;
    let remote: Set<string>;
    try {
      remote = new Set(await store.listRunIds());
    } catch {
      return 0;
    }
    let n = 0;
    for (const rec of this.runs.values()) {
      if (rec.status === "running" || remote.has(rec.id)) continue;
      await this.archive(rec.id);
      n++;
    }
    return n;
  }

  private countSince(log: number[], since: number): number {
    return log.filter((t) => t > since).length;
  }

  list(opts?: { includePrivate?: boolean }): RunRec[] {
    return [...this.runs.values()]
      .filter((r) => opts?.includePrivate || r.showcase)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): RunRec | undefined {
    return this.runs.get(id);
  }

  getByFile(file: string): RunRec | undefined {
    return [...this.runs.values()].find((r) => r.file === file);
  }

  /**
   * Terminal truth for a finished run, read from the run log itself: the
   * run.completed event must say ok AND the run must contain the artifacts a
   * completed run produces (interviews and a finished report). Anything else
   * is an error, however the pipeline's promise settled.
   */
  private terminalVerdict(file: string): { ok: boolean; error?: string } {
    let completed: { status?: string } | undefined;
    let interviews = 0;
    let reportDone = false;
    try {
      for (const line of fs.readFileSync(path.join(this.runsDir, file), "utf8").split("\n")) {
        if (!line.trim()) continue;
        let ev: { type?: string; status?: string; stage?: string } | undefined;
        try {
          ev = (JSON.parse(line) as { event?: typeof ev }).event;
        } catch {
          continue; // a torn final line must not hide the events before it
        }
        if (ev?.type === "run.completed") completed = ev;
        else if (ev?.type === "interview.completed") interviews++;
        else if (ev?.type === "stage" && ev.stage === "report" && ev.status === "done") reportDone = true;
      }
    } catch (err) {
      return { ok: false, error: `run log unreadable: ${(err as Error).message}` };
    }
    if (!completed) return { ok: false, error: "run log has no terminal run.completed event" };
    if (completed.status !== "ok") return { ok: false, error: "terminal event reports a failed run" };
    if (interviews === 0 || !reportDone)
      return { ok: false, error: `completed run is missing required artifacts (interviews=${interviews}, reportDone=${reportDone})` };
    return { ok: true };
  }

  async start(brief: Brief, label: string, ip: string, showcase = false): Promise<RunRec> {
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
    const rec: RunRec = {
      id,
      label,
      kind: "simulation",
      mode: this.cfg.mode,
      createdAt: new Date().toISOString(),
      file,
      status: "running",
      showcase,
      archived: false,
    };
    this.runs.set(id, rec);
    this.writeMeta(id, { label, showcase, createdAt: rec.createdAt, status: "running" });
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
        // A resolved promise is not proof of success: require the terminal
        // event AND the artifacts a completed run must contain (regression: a
        // run whose interviews all failed was once published as status ok).
        const verdict = this.terminalVerdict(file);
        rec.status = verdict.ok ? "ok" : "error";
        if (!verdict.ok) rec.error = verdict.error;
      })
      .catch((err) => {
        rec.status = "error";
        rec.error = String((err as Error)?.message ?? err).slice(0, 300);
      })
      .finally(() => {
        this.active = false;
        this.writeMeta(id, { label, showcase, createdAt: rec.createdAt, status: rec.status });
        void this.archive(id); // durable retention; failures logged + retried at boot
      });
    return rec;
  }
}
