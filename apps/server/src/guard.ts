import type { JsonRequest, LlmClient, TextRequest, Usage, UsageMeter } from "@market/engine/llm/types";
import { Budget, BudgetError, FRAMING_MARGIN_TOKENS, MAX_REQUEST_BYTES, PRICES } from "./budget.js";

// Defaults mirror the engine's ClaudeClient: json() uses 16000 when a request omits
// maxTokens, stream() uses 32000. The guard must assume the same worst cases.
const DEFAULT_JSON_MAX_TOKENS = 16000;
const DEFAULT_STREAM_MAX_TOKENS = 32000;

const ZERO: Usage = { calls: 0, inputTokens: 0, outputTokens: 0 };

/**
 * Wraps a real LLM client with the V11 budget safeguard. The engine's clients record
 * documented token usage into the router's shared UsageMeter after every call; this
 * wrapper diffs that meter around each call to settle the reservation at actual cost.
 * One deliberate difference from V11: engine errors do not carry HTTP status, so a
 * pre-processing 4xx cannot be told apart from a network failure here, and EVERY
 * failure keeps its reservation. That is strictly more conservative than V11.
 */
export function budgetedClient(inner: LlmClient, usage: UsageMeter, budget: Budget, model: string): LlmClient {
  const price = PRICES[model];
  if (!price) throw new Error(`no verified price for ${model}; refusing to run`);
  const meterKey = (purpose: string) => `${inner.backend}:${purpose}`;
  const snapshot = (purpose: string): Usage => usage.byKey[meterKey(purpose)] ?? ZERO;

  async function guarded<T>(purpose: string, system: string, prompt: string, maxTokens: number, fn: () => Promise<T>): Promise<T> {
    // Conservative input bound: a token covers at least one UTF-8 byte (V11 assumption),
    // plus a fixed margin for message framing, plus the full max_tokens of output.
    const bytes = Buffer.byteLength(system, "utf8") + Buffer.byteLength(prompt, "utf8");
    if (bytes > MAX_REQUEST_BYTES) throw new BudgetError(`request too large (${bytes} bytes)`);
    const reserved = budget.reserve((bytes + FRAMING_MARGIN_TOKENS) * price.in + maxTokens * price.out);
    const before = snapshot(purpose);
    let out: T;
    try {
      out = await fn();
    } catch (err) {
      // Unknown outcome: the request may have been processed and billed. Fail closed.
      budget.keepUnresolved(reserved);
      throw err;
    }
    const after = snapshot(purpose);
    const inTok = after.inputTokens - before.inputTokens;
    const outTok = after.outputTokens - before.outputTokens;
    if (after.calls > before.calls && inTok >= 0 && outTok >= 0) {
      budget.settle(reserved, inTok * price.in + outTok * price.out, { input_tokens: inTok, output_tokens: outTok });
    } else {
      // The inner client did not record usage for this call: cost unprovable, keep it.
      budget.keepUnresolved(reserved);
    }
    return out;
  }

  return {
    backend: inner.backend,
    json<T>(req: JsonRequest<T>): Promise<T> {
      return guarded(req.purpose, req.system, req.prompt, req.maxTokens ?? DEFAULT_JSON_MAX_TOKENS, () => inner.json(req));
    },
    async *stream(req: TextRequest): AsyncIterable<string> {
      // Reserve for the whole stream up front; the inner client records usage when the
      // stream completes, so settle after the last chunk.
      const bytes = Buffer.byteLength(req.system, "utf8") + Buffer.byteLength(req.prompt, "utf8");
      if (bytes > MAX_REQUEST_BYTES) throw new BudgetError(`request too large (${bytes} bytes)`);
      const maxTokens = req.maxTokens ?? DEFAULT_STREAM_MAX_TOKENS;
      const reserved = budget.reserve((bytes + FRAMING_MARGIN_TOKENS) * price.in + maxTokens * price.out);
      const before = snapshot(req.purpose);
      try {
        for await (const chunk of inner.stream(req)) yield chunk;
      } catch (err) {
        budget.keepUnresolved(reserved);
        throw err;
      }
      const after = snapshot(req.purpose);
      const inTok = after.inputTokens - before.inputTokens;
      const outTok = after.outputTokens - before.outputTokens;
      if (after.calls > before.calls && inTok >= 0 && outTok >= 0) {
        budget.settle(reserved, inTok * price.in + outTok * price.out, { input_tokens: inTok, output_tokens: outTok });
      } else {
        budget.keepUnresolved(reserved);
      }
    },
  };
}
