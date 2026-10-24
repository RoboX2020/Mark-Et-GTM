import type { Backend } from "@market/core";
import type { EngineConfig } from "../config.js";
import type { EventBus } from "../bus.js";
import { ClaudeClient } from "./claude.js";
import { GeminiClient, MockClient, RunpodClient } from "./swarm.js";
import { UsageMeter, type JsonRequest, type LlmClient, type TextRequest } from "./types.js";

/**
 * Picks a backend per task. Claude does reasoning (graph, interviews, report).
 * The swarm is spread across the cheaper backends that have credentials. Any
 * live failure degrades to the request's deterministic mock and is logged, so
 * a run always completes and the log shows exactly what was simulated.
 */
export class LlmRouter {
  readonly usage = new UsageMeter();
  private clients = new Map<Backend, LlmClient>();
  private mock: MockClient;
  private failures = new Map<Backend, number>();
  readonly swarmBackends: { backend: Backend; share: number }[];

  constructor(private cfg: EngineConfig, private bus: EventBus) {
    this.mock = new MockClient("mock", this.usage);
    if (cfg.mode === "live") {
      if (cfg.anthropic.apiKey) this.clients.set("claude", new ClaudeClient(cfg.anthropic, this.usage));
      if (cfg.gemini.apiKey) this.clients.set("gemini", new GeminiClient(cfg.gemini, this.usage));
      if (cfg.runpod.apiKey && cfg.runpod.endpointId) this.clients.set("runpod", new RunpodClient(cfg.runpod, this.usage));
    }
    const avail = Object.entries(cfg.swarmMix).filter(([b, s]) => s > 0 && this.clients.has(b as Backend));
    const total = avail.reduce((a, [, s]) => a + s, 0);
    this.swarmBackends = avail.length
      ? avail.map(([backend, s]) => ({ backend: backend as Backend, share: s / total }))
      : [{ backend: "mock", share: 1 }];
  }

  get reasoningBackend(): Backend {
    return this.clients.has("claude") ? "claude" : "mock";
  }

  describe(): string {
    return `reasoning=${this.reasoningBackend} swarm=${this.swarmBackends.map((s) => `${s.backend}:${s.share.toFixed(2)}`).join(",")}`;
  }

  async json<T>(backend: Backend, req: JsonRequest<T>): Promise<{ value: T; served: Backend }> {
    const client = this.clients.get(backend);
    if (!client || (this.failures.get(backend) ?? 0) > 25) return { value: await this.mock.json(req), served: "mock" };
    try {
      return { value: await client.json(req), served: backend };
    } catch (err) {
      const n = (this.failures.get(backend) ?? 0) + 1;
      this.failures.set(backend, n);
      if (n <= 3 || n === 26)
        this.bus.log(`${backend} failed on ${req.purpose} (${(err as Error).message.slice(0, 160)}) — using deterministic fallback${n === 26 ? "; backend disabled for this run" : ""}`, "warn");
      return { value: await this.mock.json(req), served: "mock" };
    }
  }

  async *stream(backend: Backend, req: TextRequest): AsyncIterable<string> {
    const client = this.clients.get(backend);
    if (!client) {
      yield* this.mock.stream(req);
      return;
    }
    let emitted = false;
    try {
      for await (const chunk of client.stream(req)) {
        emitted = true;
        yield chunk;
      }
    } catch (err) {
      this.bus.log(`${backend} stream failed on ${req.purpose} (${(err as Error).message.slice(0, 160)})`, "warn");
      if (!emitted) yield* this.mock.stream(req);
    }
  }
}
