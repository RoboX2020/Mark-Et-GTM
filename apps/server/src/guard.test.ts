import { describe, expect, it } from "vitest";
import type { JsonRequest, LlmClient, TextRequest } from "@market/engine/llm/types";
import { UsageMeter } from "@market/engine/llm/types";
import { Budget, BudgetError, MAX_REQUEST_BYTES } from "./budget.js";
import { budgetedClient } from "./guard.js";
import { z } from "zod";

const Schema = z.object({ ok: z.boolean() });

/** Fake backend that records the usage it is told to into the shared meter. */
function fakeClient(opts: { inTok?: number; outTok?: number; fail?: boolean } = {}): LlmClient {
  return {
    backend: "claude",
    json: async <T>(req: JsonRequest<T>): Promise<T> => {
      if (opts.fail) throw new Error("upstream exploded");
      sharedMeter.add("claude", req.purpose, opts.inTok ?? 1000, opts.outTok ?? 500);
      return { ok: true } as T;
    },
    stream: async function* (req: TextRequest) {
      if (opts.fail) throw new Error("upstream exploded");
      yield "hello ";
      sharedMeter.add("claude", req.purpose, opts.inTok ?? 1000, opts.outTok ?? 500);
      yield "world";
    },
  };
}

let sharedMeter: UsageMeter;

function setup(innerOpts: Parameters<typeof fakeClient>[0] = {}, capUsd = 1) {
  sharedMeter = new UsageMeter();
  const budget = new Budget(capUsd);
  const client = budgetedClient(fakeClient(innerOpts), sharedMeter, budget, "claude-haiku-5-5");
  return { budget, client };
}

describe("budgetedClient", () => {
  const jsonReq: JsonRequest<{ ok: boolean }> = {
    purpose: "test",
    system: "sys",
    prompt: "hello",
    schema: Schema,
    maxTokens: 1000,
    mock: () => ({ ok: true }),
  };

  it("settles the reservation at documented usage after a json call", async () => {
    const { budget, client } = setup({ inTok: 1000, outTok: 500 });
    const out = await client.json(jsonReq);
    expect(out.ok).toBe(true);
    const actual = 1000 * 0.1e-6 + 500 * 0.5e-6;
    const worstCase = (8 + 300) * 0.1e-6 + 1000 * 0.5e-6; // "sys" + "hello" = 8 bytes
    expect(budget.committed).toBeCloseTo(actual);
    expect(budget.committed).toBeLessThan(worstCase);
    expect(budget.unresolved).toBe(0);
  });

  it("keeps the full reservation when the call fails", async () => {
    const { budget, client } = setup({ fail: true });
    await expect(client.json(jsonReq)).rejects.toThrow("upstream exploded");
    expect(budget.unresolved).toBe(1);
    expect(budget.committed).toBeGreaterThan(0.0005); // reservation stayed
  });

  it("refuses oversize requests without calling the backend", async () => {
    const { budget, client } = setup();
    const big: JsonRequest<{ ok: boolean }> = { ...jsonReq, prompt: "x".repeat(MAX_REQUEST_BYTES + 1) };
    await expect(client.json(big)).rejects.toThrow(BudgetError);
    expect(budget.calls).toBe(0);
    expect(budget.committed).toBe(0);
  });

  it("blocks calls once the cap is exhausted", async () => {
    const { budget, client } = setup({}, 0.0001);
    await expect(client.json(jsonReq)).rejects.toThrow(BudgetError);
    expect(budget.committed).toBe(0);
  });

  it("settles stream calls after the last chunk", async () => {
    const { budget, client } = setup({ inTok: 2000, outTok: 300 });
    const req: TextRequest = { purpose: "test.stream", system: "s", prompt: "p", maxTokens: 1000, mock: () => "m" };
    let text = "";
    for await (const chunk of client.stream(req)) text += chunk;
    expect(text).toBe("hello world");
    expect(budget.committed).toBeCloseTo(2000 * 0.1e-6 + 300 * 0.5e-6);
  });

  it("keeps the reservation when a stream fails mid-way", async () => {
    sharedMeter = new UsageMeter();
    const budget = new Budget(1);
    const failing: LlmClient = {
      backend: "claude",
      json: async <T>(): Promise<T> => ({}) as T,
      stream: async function* () {
        yield "partial";
        throw new Error("stream died");
      },
    };
    const client = budgetedClient(failing, sharedMeter, budget, "claude-haiku-5-5");
    const req: TextRequest = { purpose: "test.stream", system: "s", prompt: "p", maxTokens: 1000, mock: () => "m" };
    await expect(async () => {
      for await (const c of client.stream(req)) void c;
    }).rejects.toThrow("stream died");
    expect(budget.unresolved).toBe(1);
    expect(budget.committed).toBeGreaterThan(0);
  });

  it("refuses a model with no verified price", () => {
    sharedMeter = new UsageMeter();
    expect(() => budgetedClient(fakeClient(), sharedMeter, new Budget(1), "claude-opus-5-5")).toThrow(/no verified price/);
  });
});
