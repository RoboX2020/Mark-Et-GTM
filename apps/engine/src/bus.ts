import type { EventEnvelope, MarketEvent } from "@market/core";

export interface Sink {
  write(env: EventEnvelope): void | Promise<void>;
  close?(): Promise<void>;
}

/**
 * Typical wall-clock cost of each step in a live run. Mock runs finish in
 * milliseconds; stamping events with these durations instead makes their
 * recorded logs replay with realistic pacing.
 */
const VIRTUAL_MS: Partial<Record<MarketEvent["type"], number>> = {
  "run.started": 0,
  stage: 400,
  "evidence.added": 90,
  "signal.added": 160,
  "anchor.added": 300,
  "graph.node": 220,
  "graph.edge": 45,
  "agent.created": 18,
  "network.edges": 120,
  "round.started": 700,
  "agent.thinking": 4,
  "agent.decision": 22,
  "agent.message": 70,
  "round.completed": 500,
  "adoption.point": 150,
  "bass.fit": 900,
  "interview.started": 350,
  "interview.answer": 650,
  "interview.completed": 200,
  "finance.computed": 900,
  "report.section": 500,
  "report.delta": 55,
  "report.section.done": 200,
  "backtest.result": 800,
  "market_backtest.row": 400,
  log: 10,
  "run.completed": 300,
};

export class EventBus {
  private seq = 0;
  private vclock: number;
  private pending: Promise<unknown>[] = [];

  constructor(
    readonly runId: string,
    private sinks: Sink[],
    private opts: { virtualTime: boolean; startTs?: number } = { virtualTime: false },
  ) {
    this.vclock = opts.startTs ?? Date.now();
  }

  emit(event: MarketEvent): EventEnvelope {
    const ts = this.opts.virtualTime ? (this.vclock += VIRTUAL_MS[event.type] ?? 50) : Date.now();
    const env: EventEnvelope = { runId: this.runId, seq: this.seq++, ts, event };
    for (const s of this.sinks) {
      const r = s.write(env);
      if (r instanceof Promise) this.pending.push(r.catch((err) => console.error("[sink]", err?.message ?? err)));
    }
    if (this.pending.length > 256) this.pending = this.pending.slice(-64);
    return env;
  }

  log(message: string, level: "info" | "warn" | "error" = "info") {
    this.emit({ type: "log", level, message });
  }

  async close() {
    await Promise.all(this.pending);
    for (const s of this.sinks) await s.close?.();
  }
}
