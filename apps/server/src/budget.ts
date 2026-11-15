// Budget safeguard ported from the validated offline pipeline (apps/live/src/claude.mjs
// in the private V11 archive). Semantics preserved exactly:
// - a conservative cost bound is reserved BEFORE every request (input tokens bounded by
//   the UTF-8 byte length of the serialized request plus a framing margin, plus the full
//   max_tokens), and the request is refused if the reservation would pass the cap;
// - after a successful response the reservation is replaced by the documented usage cost;
// - unknown outcomes (network errors, 429/5xx, missing usage) KEEP the reservation, so
//   repeated unresolved calls can never walk spend past the cap;
// - only a request the API rejected before processing releases its reservation.
// The byte-based input bound assumes a token covers at least one byte: conservative,
// not a provider-verified guarantee. In-memory counters are per-process; persistence
// (who saves committed spend) is the caller's job via onChange.

/**
 * List price per token, https://platform.claude.com/docs/en/about-claude/pricing
 * (rechecked Nov 15, 2026: Claude Haiku 5.5, prompts up to 100k tokens; the >100k
 * tier is $0.50/$2.50 and is NOT covered - requests that large must not be sent
 * under this price, so the guard's per-call byte caps stay well below 100k tokens).
 */
export const PRICES: Record<string, { in: number; out: number }> = {
  "claude-haiku-5-5": { in: 0.1 / 1e6, out: 0.5 / 1e6 },
};

/** Hard per-call serialized-size cap (bytes). 60 KB stays far below the 100k-token
 * boundary where the higher Haiku price tier starts (a token covers >= 1 byte). */
export const MAX_REQUEST_BYTES = 60_000;

export const FRAMING_MARGIN_TOKENS = 300;

export class BudgetError extends Error {}

export class Budget {
  readonly cap: number;
  committed: number;
  calls = 0;
  inTok = 0;
  outTok = 0;
  /** Count of completed-but-unpriced calls whose full reservation stayed committed. */
  unresolved = 0;
  /** Called after every mutation so the owner can persist `committed`. */
  onChange?: (committed: number) => void;

  constructor(capUsd: number, committedUsd = 0) {
    if (!(capUsd > 0)) throw new Error("budget cap must be positive");
    this.cap = capUsd;
    this.committed = committedUsd;
  }

  get remaining(): number {
    return this.cap - this.committed;
  }

  reserve(usd: number): number {
    if (this.committed + usd > this.cap) throw new BudgetError(`budget cap $${this.cap.toFixed(2)} would be exceeded`);
    this.committed += usd;
    this.onChange?.(this.committed);
    return usd;
  }

  settle(reserved: number, actual: number, u: { input_tokens?: number; output_tokens?: number } = {}): void {
    this.committed += actual - reserved;
    this.calls++;
    this.inTok += u.input_tokens ?? 0;
    this.outTok += u.output_tokens ?? 0;
    this.onChange?.(this.committed);
  }

  /** Only for requests the API rejected before processing (4xx validation). */
  release(reserved: number): void {
    this.committed -= reserved;
    this.onChange?.(this.committed);
  }

  /**
   * A completed response whose cost cannot be proven (missing usage, or an error after
   * the request may have been processed) keeps its full reservation: it might have
   * cost the worst case, so the books assume it did.
   */
  keepUnresolved(reserved: number, u: { input_tokens?: number; output_tokens?: number } = {}): void {
    this.calls++;
    this.unresolved++;
    this.inTok += u.input_tokens ?? 0;
    this.outTok += u.output_tokens ?? 0;
    this.onChange?.(this.committed);
  }
}
