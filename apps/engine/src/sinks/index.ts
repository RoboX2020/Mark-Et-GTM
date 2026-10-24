import fs from "node:fs";
import path from "node:path";
import type { EventEnvelope } from "@market/core";
import type { Sink } from "../bus.js";

/** Append-only JSONL event log: the replay and offline-demo source. */
export class JsonlSink implements Sink {
  private fd: number;
  constructor(readonly file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.fd = fs.openSync(file, "w");
  }
  write(env: EventEnvelope) {
    fs.writeSync(this.fd, JSON.stringify(env) + "\n");
  }
  async close() {
    fs.closeSync(this.fd);
  }
}

export class ConsoleSink implements Sink {
  constructor(private verbose = false) {}
  write(env: EventEnvelope) {
    const e = env.event;
    if (e.type === "stage" && e.status !== "pending") console.log(`  ▸ ${e.stage.padEnd(11)} ${e.status}${e.detail ? `  ${e.detail}` : ""}`);
    else if (e.type === "log" && (e.level !== "info" || this.verbose)) console.log(`  ${e.level === "info" ? "·" : "!"} ${e.message}`);
    else if (e.type === "round.completed")
      console.log(`    round ${e.summary.round}: adopted ${e.summary.counts.adopted}, considering ${e.summary.counts.considering}, rejected ${e.summary.counts.rejected}`);
    else if (e.type === "bass.fit") console.log(`    bass p=${e.fit.p.toFixed(4)} q=${e.fit.q.toFixed(3)} m=${e.fit.m.toFixed(3)} rmse=${e.fit.rmse.toFixed(4)}`);
    else if (e.type === "backtest.result") console.log(`    backtest MAPE=${(e.result.mape * 100).toFixed(1)}% objections=${(e.result.objectionOverlap * 100).toFixed(0)}%`);
  }
}

/**
 * Writes every envelope to SpacetimeDB via the HTTP reducer endpoint
 * (`POST /v1/database/:name/call/append_event`). The module's reducer stores
 * the raw event and materialises typed tables the portal subscribes to.
 * Calls are serialised per run so `seq` order is preserved.
 */
export class SpacetimeSink implements Sink {
  private chain: Promise<void> = Promise.resolve();
  private base: string;
  private failed = 0;
  constructor(uri: string, private db: string, private token: string) {
    this.base = uri.replace(/^ws/, "http").replace(/\/$/, "");
  }
  write(env: EventEnvelope) {
    this.chain = this.chain.then(() => this.send(env));
  }
  private async send(env: EventEnvelope) {
    if (this.failed > 20) return; // server is down; the JSONL log still has everything
    try {
      const res = await fetch(`${this.base}/v1/database/${encodeURIComponent(this.db)}/call/append_event`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
        body: JSON.stringify([env.runId, env.seq, env.ts, env.event.type, JSON.stringify(env.event)]),
      });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    } catch (err) {
      this.failed++;
      if (this.failed === 1 || this.failed === 21) console.error(`[spacetime] ${(err as Error).message}${this.failed > 20 ? " — disabling sink" : ""}`);
    }
  }
  async close() {
    await this.chain;
  }
}
