import { describe, expect, it } from "vitest";
import { z } from "zod";
import { loadConfig } from "../config.js";
import { EventBus } from "../bus.js";
import { LlmRouter } from "./router.js";
import type { JsonRequest, LlmClient, TextRequest } from "./types.js";

const Schema = z.object({ ok: z.boolean() });

function liveRouter(): LlmRouter {
  const cfg = loadConfig({ mode: "live", spacetime: false });
  cfg.anthropic.apiKey = "test-key-not-sent"; // presence creates the claude slot; we replace the client below
  return new LlmRouter(cfg, new EventBus("test", []));
}

/** Swap the real Claude client for a scripted fake (TS private is compile-time only). */
function inject(router: LlmRouter, client: LlmClient): void {
  (router as unknown as { clients: Map<string, LlmClient> }).clients.set("claude", client);
}

const jsonReq: JsonRequest<{ ok: boolean }> = {
  purpose: "test",
  system: "s",
  prompt: "p",
  schema: Schema,
  maxTokens: 100,
  mock: () => ({ ok: false }), // mock returns ok:false so tests can tell mock from real output
};

function fake(behavior: (call: number) => Promise<{ ok: boolean }>): LlmClient & { calls: number } {
  const c = {
    backend: "claude" as const,
    calls: 0,
    json: async <T>(): Promise<T> => {
      c.calls++;
      return (await behavior(c.calls)) as T;
    },
    stream: async function* () {
      yield "real";
    },
  };
  return c;
}

describe("LlmRouter live-mode failure policy", () => {
  it("retries a failed call and serves the real backend when a retry succeeds", async () => {
    const router = liveRouter();
    const client = fake(async (call) => {
      if (call < 3) throw new Error("schema miss");
      return { ok: true };
    });
    inject(router, client);
    const { value, served } = await router.json("claude", jsonReq);
    expect(served).toBe("claude");
    expect(value.ok).toBe(true);
    expect(client.calls).toBe(3);
  });

  it("throws after bounded retries instead of serving mock as model output", async () => {
    const router = liveRouter();
    const client = fake(async () => {
      throw new Error("always broken");
    });
    inject(router, client);
    await expect(router.json("claude", jsonReq)).rejects.toThrow(/3 attempts/);
    expect(client.calls).toBe(3); // bounded: no endless retry
  });

  it("never falls back to mock for a configured live backend, even on failure", async () => {
    const router = liveRouter();
    inject(router, fake(async () => {
      throw new Error("down");
    }));
    await expect(router.json("claude", jsonReq)).rejects.toThrow();
    // If it had served mock, value.ok would be false and served "mock" - both impossible now.
  });

  it("mock mode still serves deterministic mock output", async () => {
    const cfg = loadConfig({ mode: "mock", spacetime: false });
    const router = new LlmRouter(cfg, new EventBus("test", []));
    const { value, served } = await router.json("claude", jsonReq);
    expect(served).toBe("mock");
    expect(value.ok).toBe(false); // the mock() value
  });

  it("stream retries before first chunk, then throws rather than serving mock text", async () => {
    const router = liveRouter();
    let calls = 0;
    inject(router, {
      backend: "claude",
      json: async <T>(): Promise<T> => ({}) as T,
      stream: async function* () {
        calls++;
        throw new Error("stream down");
      },
    });
    const req: TextRequest = { purpose: "t", system: "s", prompt: "p", maxTokens: 10, mock: () => "mock-text" };
    await expect(async () => {
      for await (const c of router.stream("claude", req)) void c;
    }).rejects.toThrow(/3 attempts/);
    expect(calls).toBe(3);
  });
});
