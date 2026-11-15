import { describe, expect, it } from "vitest";
import type { JsonRequest, LlmClient, TextRequest } from "@market/engine/llm/types";
import { UsageMeter } from "@market/engine/llm/types";
import { Budget, BudgetError, MAX_REQUEST_BYTES } from "./budget.js";
import { BudgetGuard, budgetedClient, meterCostUsd } from "./guard.js";
import { z } from "zod";

const Schema = z.object({ ok: z.boolean() });

/** Fake backend that records the usage it is told to into the shared meter. */
function fakeClient(meter: UsageMeter, opts: { inTok?: number; outTok?: number; fail?: boolean; delayMs?: number } = {}): LlmClient {
  return {
    backend: "claude",
    json: async <T>(req: JsonRequest<T>): Promise<T> => {
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      if (opts.fail) throw new Error("upstream exploded");
      meter.add("claude", req.purpose, opts.inTok ?? 1000, opts.outTok ?? 500);
      return { ok: true } as T;
    },
    stream: async function* (req: TextRequest) {
      if (opts.fail) throw new Error("upstream exploded");
      yield "hello ";
      meter.add("claude", req.purpose, opts.inTok ?? 1000, opts.outTok ?? 500);
      yield "world";
    },
  };
}

const jsonReq: JsonRequest<{ ok: boolean }> = {
  purpose: "test",
  system: "sys",
  prompt: "hello",
  schema: Schema,
  maxTokens: 1000,
  mock: () => ({ ok: true }),
};

describe("BudgetGuard", () => {
  it("settles to documented meter cost after a json call", async () => {
    const meter = new UsageMeter();
    const budget = new Budget(1);
    const client = budgetedClient(fakeClient(meter, { inTok: 1000, outTok: 500 }), meter, budget, "claude-haiku-5-5");
    const out = await client.json(jsonReq);
    expect(out.ok).toBe(true);
    expect(budget.committed).toBeCloseTo(1000 * 0.1e-6 + 500 * 0.5e-6);
    expect(budget.calls).toBe(0); // guard tracks via meter, not Budget.calls
  });

  it("keeps the full reservation outstanding when the call fails", async () => {
    const meter = new UsageMeter();
    const budget = new Budget(1);
    const guard = new BudgetGuard(meter, budget, "claude-haiku-5-5");
    const client = guard.wrap(fakeClient(meter, { fail: true }));
    await expect(client.json(jsonReq)).rejects.toThrow("upstream exploded");
    expect(guard.unresolved).toBe(1);
    // Reservation stays: committed = 8 bytes + margin input, plus 1000 output tokens.
    expect(budget.committed).toBeCloseTo((8 + 300) * 0.1e-6 + 1000 * 0.5e-6);
  });

  it("attributes concurrent same-purpose calls exactly once", async () => {
    const meter = new UsageMeter();
    const budget = new Budget(1);
    const client = budgetedClient(fakeClient(meter, { inTok: 1000, outTok: 500, delayMs: 20 }), meter, budget, "claude-haiku-5-5");
    await Promise.all([client.json(jsonReq), client.json(jsonReq), client.json(jsonReq)]);
    // Three calls' usage, counted once each: no double-settle, no unresolved.
    expect(budget.committed).toBeCloseTo(3 * (1000 * 0.1e-6 + 500 * 0.5e-6));
  });

  it("refuses oversize requests without calling the backend", async () => {
    const meter = new UsageMeter();
    const budget = new Budget(1);
    const client = budgetedClient(fakeClient(meter), meter, budget, "claude-haiku-5-5");
    await expect(client.json({ ...jsonReq, prompt: "x".repeat(MAX_REQUEST_BYTES + 1) })).rejects.toThrow(BudgetError);
    expect(budget.committed).toBe(0);
  });

  it("blocks calls once the cap is exhausted", async () => {
    const meter = new UsageMeter();
    const budget = new Budget(0.0001);
    const client = budgetedClient(fakeClient(meter), meter, budget, "claude-haiku-5-5");
    await expect(client.json(jsonReq)).rejects.toThrow(BudgetError);
    expect(budget.committed).toBe(0);
  });

  it("settles stream calls after the last chunk", async () => {
    const meter = new UsageMeter();
    const budget = new Budget(1);
    const client = budgetedClient(fakeClient(meter, { inTok: 2000, outTok: 300 }), meter, budget, "claude-haiku-5-5");
    const req: TextRequest = { purpose: "test.stream", system: "s", prompt: "p", maxTokens: 1000, mock: () => "m" };
    let text = "";
    for await (const chunk of client.stream(req)) text += chunk;
    expect(text).toBe("hello world");
    expect(budget.committed).toBeCloseTo(2000 * 0.1e-6 + 300 * 0.5e-6);
  });

  it("keeps the reservation when a stream fails mid-way", async () => {
    const meter = new UsageMeter();
    const budget = new Budget(1);
    const guard = new BudgetGuard(meter, budget, "claude-haiku-5-5");
    const failing: LlmClient = {
      backend: "claude",
      json: async <T>(): Promise<T> => ({}) as T,
      stream: async function* () {
        yield "partial";
        throw new Error("stream died");
      },
    };
    const client = guard.wrap(failing);
    const req: TextRequest = { purpose: "test.stream", system: "s", prompt: "p", maxTokens: 1000, mock: () => "m" };
    await expect(async () => {
      for await (const c of client.stream(req)) void c;
    }).rejects.toThrow("stream died");
    expect(guard.unresolved).toBe(1);
    expect(budget.committed).toBeGreaterThan(0);
  });

  it("refuses a model with no verified price", () => {
    expect(() => new BudgetGuard(new UsageMeter(), new Budget(1), "claude-opus-5-5")).toThrow(/no verified price/);
  });

  it("keeps ledger-restored spend on the books across reconciliation", async () => {
    const meter = new UsageMeter();
    const budget = new Budget(5, 3.25); // restored from a prior process
    const client = budgetedClient(fakeClient(meter, { inTok: 1000, outTok: 0 }), meter, budget, "claude-haiku-5-5");
    await client.json(jsonReq);
    expect(budget.committed).toBeCloseTo(3.25 + 1000 * 0.1e-6);
    expect(budget.remaining).toBeLessThan(5 - 3.25);
  });

  it("meterCostUsd sums every recorded key", () => {
    const meter = new UsageMeter();
    meter.add("claude", "a", 1000, 1000);
    meter.add("mock", "b", 5, 5);
    expect(meterCostUsd(meter, { in: 0.1e-6, out: 0.5e-6 })).toBeCloseTo(1005 * 0.1e-6 + 1005 * 0.5e-6);
  });
});
