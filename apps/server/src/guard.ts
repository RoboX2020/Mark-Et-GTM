import type { JsonRequest, LlmClient, TextRequest, UsageMeter } from "@market/engine/llm/types";
import { Budget, BudgetError, FRAMING_MARGIN_TOKENS, MAX_REQUEST_BYTES, PRICES } from "./budget.js";
import type { SpendStore } from "./ledger.js";

// Defaults mirror the engine's ClaudeClient: json() uses 16000 when a request omits
// maxTokens, stream() uses 32000. The guard must assume the same worst cases.
const DEFAULT_JSON_MAX_TOKENS = 16000;
const DEFAULT_STREAM_MAX_TOKENS = 32000;

/** Total documented cost of everything a meter has recorded, at one model's list price. */
export function meterCostUsd(usage: UsageMeter, price: { in: number; out: number }): number {
  let usd = 0;
  for (const u of Object.values(usage.byKey)) usd += u.inputTokens * price.in + u.outputTokens * price.out;
  return usd;
}

/**
 * Wraps a real LLM client with the V11 budget safeguard, made concurrency-correct.
 *
 * The engine runs swarm batches concurrently, so settling reservations by diffing the
 * shared usage meter around one call misattributes other calls' tokens. Instead this
 * guard keeps the books as:
 *
 *   committed = (cost of ALL usage recorded on the shared meter) + (outstanding reservations)
 *
 * Every call reserves its worst-case bound up front (fails closed past the cap). When a
 * call finishes, its reservation comes out of outstanding and the meter's total recorded
 * cost is re-read - completed calls' documented usage is already in there, exactly once,
 * however many calls overlapped. A call whose usage never lands in the meter (failure,
 * or an unrecorded response) keeps its reservation outstanding forever: unprovable cost
 * is assumed worst-case, so unresolved calls can never walk spend past the cap.
 */
export class BudgetGuard {
  private outstanding = 0;
  /** Calls whose reservation stayed outstanding because their cost is unprovable. */
  unresolved = 0;
  /** Meter cost at guard creation: only usage recorded AFTER this point counts as new spend. */
  private meterBaseCost: number;
  /** Spend restored from the ledger (earlier processes/runs); never wiped by reconciliation. */
  private restoredCommitted: number;
  /** This process's (realized + outstanding) total already reflected in the shared store. */
  private pushedTarget = 0;

  constructor(
    private usage: UsageMeter,
    private budget: Budget,
    private model: string,
    /**
     * Shared durable store for cross-instance reservations. When present,
     * every reservation is an atomic check-and-add against shared committed
     * BEFORE the provider call: overlapping deployments cannot both spend the
     * same dollars, and a restart finds unresolved reservations still booked.
     */
    private store?: SpendStore,
  ) {
    if (!PRICES[model]) throw new Error(`no verified price for ${model}; refusing to run`);
    this.meterBaseCost = meterCostUsd(usage, PRICES[model]);
    this.restoredCommitted = budget.committed;
  }

  private get price() {
    return PRICES[this.model];
  }

  get committed(): number {
    return this.budget.committed;
  }

  private syncCommitted(): void {
    const realized = Math.max(0, meterCostUsd(this.usage, this.price) - this.meterBaseCost);
    this.budget.setCommitted(this.restoredCommitted + realized + this.outstanding);
  }

  private reserveBound(system: string, prompt: string, maxTokens: number): number {
    const bytes = Buffer.byteLength(system, "utf8") + Buffer.byteLength(prompt, "utf8");
    if (bytes > MAX_REQUEST_BYTES) throw new BudgetError(`request too large (${bytes} bytes)`);
    return (bytes + FRAMING_MARGIN_TOKENS) * this.price.in + maxTokens * this.price.out;
  }

  /** A latched-unhealthy store is a fail-closed refusal, NOT a cap breach:
   *  mislabeling it once sent a failed run's diagnosis chasing phantom overspend. */
  private storeUnavailable(): BudgetError {
    return new BudgetError("spend store unhealthy - refusing billable call (fail-closed, not a budget cap breach)");
  }

  private async reserve(bound: number): Promise<void> {
    if (this.store) {
      if (!this.store.healthy()) throw this.storeUnavailable();
      // Atomic check-and-add against the SHARED committed total, before any
      // provider call. The cap covers realized + outstanding across instances.
      const ok = await this.store.tryAdd(bound, this.budget.cap);
      if (!ok)
        throw this.store.healthy()
          ? new BudgetError(`budget cap $${this.budget.cap.toFixed(2)} would be exceeded`)
          : this.storeUnavailable();
      this.outstanding += bound;
      this.pushedTarget += bound; // the store already holds this reservation
      this.syncCommitted();
      return;
    }
    // Single-process path: the in-memory cap check is sufficient (one writer).
    if (this.budget.committed + bound > this.budget.cap)
      throw new BudgetError(`budget cap $${this.budget.cap.toFixed(2)} would be exceeded`);
    this.outstanding += bound;
    this.syncCommitted();
  }

  private target(): number {
    const realized = Math.max(0, meterCostUsd(this.usage, this.price) - this.meterBaseCost);
    return realized + this.outstanding;
  }

  private async settle(reserved: number, ok: boolean): Promise<void> {
    // Synchronous bookkeeping first so interleaved settles stay consistent.
    this.outstanding -= reserved;
    if (!ok) {
      this.unresolved++;
      this.outstanding += reserved; // unprovable cost: the reservation stays
    }
    this.syncCommitted();
    if (!this.store) return;
    const target = this.target();
    const delta = target - this.pushedTarget;
    this.pushedTarget = target;
    if (delta === 0) return;
    try {
      // Settle deltas are <= 0 (reservations are worst-case): a lost settle
      // leaves the store at the HIGHER reserved number - fail closed by shape.
      await this.store.add(delta);
    } catch (err) {
      console.error(`settle could not release ${delta.toFixed(4)} to the shared ledger: ${(err as Error).message}`);
    }
  }

  wrap(inner: LlmClient): LlmClient {
    const guard = this;
    return {
      backend: inner.backend,
      async json<T>(req: JsonRequest<T>): Promise<T> {
        const reserved = guard.reserveBound(req.system, req.prompt, req.maxTokens ?? DEFAULT_JSON_MAX_TOKENS);
        await guard.reserve(reserved);
        try {
          const out = await inner.json(req);
          await guard.settle(reserved, true);
          return out;
        } catch (err) {
          await guard.settle(reserved, false);
          throw err;
        }
      },
      async *stream(req: TextRequest): AsyncIterable<string> {
        const reserved = guard.reserveBound(req.system, req.prompt, req.maxTokens ?? DEFAULT_STREAM_MAX_TOKENS);
        await guard.reserve(reserved);
        try {
          for await (const chunk of inner.stream(req)) yield chunk;
          await guard.settle(reserved, true);
        } catch (err) {
          await guard.settle(reserved, false);
          throw err;
        }
      },
    };
  }
}

/** Back-compat helper for single-client wrapping. */
export function budgetedClient(inner: LlmClient, usage: UsageMeter, budget: Budget, model: string): LlmClient {
  return new BudgetGuard(usage, budget, model).wrap(inner);
}
