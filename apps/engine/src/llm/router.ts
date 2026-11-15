import type { Backend } from "@market/core";
import type { EngineConfig } from "../config.js";
import type { EventBus } from "../bus.js";
import { ClaudeClient } from "./claude.js";
import { GeminiClient, MockClient, RunpodClient } from "./swarm.js";
import { UsageMeter, type JsonRequest, type LlmClient, type TextRequest } from "./types.js";
export type ClientWrap = (client: LlmClient, usage: UsageMeter) => LlmClient;

/**
 * Picks a backend per task. Claude does reasoning (graph, interviews, report).
 * The swarm is spread across the cheaper backends that have credentials.
 *
 * Failure policy depends on mode:
 * - mock mode (no credentials): the deterministic mock IS the intended backend
 *   and serves everything; runs are labeled simulated either way.
 * - live mode: mock output must never contaminate a run presented as model
 *   output. A failed call gets a bounded corrective retry (the common failure
 *   is a stochastic schema miss; every attempt is still validated by the
 *   client's schema parse). If the retries are exhausted the error throws and
 *   the run fails explicitly instead of completing with simulated decisions.
 */
const LIVE_RETRY_ATTEMPTS = 3;
export type { UsageMeter } from "./types.js";

export class LlmRouter {
  readonly usage = new UsageMeter();
  private clients = new Map<Backend, LlmClient>();
  private mock: MockClient;
  readonly swarmBackends: { backend: Backend; share: number }[];

  constructor(
    private cfg: EngineConfig,
    private bus: EventBus,
    // Optional wrapper applied to every real backend client (e.g. the server's
    // budget guard). Receives the shared usage meter so the wrapper can settle
    // reserved cost against the client's recorded usage. Mock clients are never
    // wrapped: they must stay free.
    wrap: (client: LlmClient, usage: UsageMeter) => LlmClient = (c) => c,
  ) {
    this.mock = new MockClient("mock", this.usage);
    if (cfg.mode === "live") {
      if (cfg.anthropic.apiKey) this.clients.set("claude", wrap(new ClaudeClient(cfg.anthropic, this.usage), this.usage));
      if (cfg.gemini.apiKey) this.clients.set("gemini", wrap(new GeminiClient(cfg.gemini, this.usage), this.usage));
      if (cfg.runpod.apiKey && cfg.runpod.endpointId) this.clients.set("runpod", wrap(new RunpodClient(cfg.runpod, this.usage), this.usage));
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
    // Mock mode or an unconfigured backend: the mock is the intended backend.
    if (!client) return { value: await this.mock.json(req), served: "mock" };
    let lastErr: Error | undefined;
    for (let attempt = 1; attempt <= LIVE_RETRY_ATTEMPTS; attempt++) {
      // Corrective retry: after a failure, tell the model what validation
      // rejected so the next attempt fixes it instead of re-sampling blindly.
      const attemptReq =
        attempt === 1
          ? req
          : { ...req, prompt: `${req.prompt}\n\nYour previous reply failed validation: ${lastErr?.message.slice(0, 400)}. Reply again, valid only.` };
      try {
        return { value: await client.json(attemptReq), served: backend };
      } catch (err) {
        lastErr = err as Error;
        this.bus.log(
          `${backend} attempt ${attempt}/${LIVE_RETRY_ATTEMPTS} failed on ${req.purpose} (${lastErr.message.slice(0, 160)})${attempt < LIVE_RETRY_ATTEMPTS ? " - retrying with the error fed back" : ""}`,
          "warn",
        );
      }
    }
    // Bounded correction exhausted: fail the run rather than report mock
    // decisions as model output.
    throw new Error(`${backend} could not produce a valid ${req.purpose} after ${LIVE_RETRY_ATTEMPTS} attempts: ${lastErr?.message}`);
  }

  async *stream(backend: Backend, req: TextRequest): AsyncIterable<string> {
    const client = this.clients.get(backend);
    if (!client) {
      yield* this.mock.stream(req);
      return;
    }
    let lastErr: Error | undefined;
    for (let attempt = 1; attempt <= LIVE_RETRY_ATTEMPTS; attempt++) {
      let emitted = false;
      try {
        for await (const chunk of client.stream(req)) {
          emitted = true;
          yield chunk;
        }
        return;
      } catch (err) {
        lastErr = err as Error;
        this.bus.log(`${backend} stream attempt ${attempt}/${LIVE_RETRY_ATTEMPTS} failed on ${req.purpose} (${lastErr.message.slice(0, 160)})`, "warn");
        // Mid-stream failure after chunks were yielded cannot be retried safely
        // (the consumer already saw partial output): fail the run.
        if (emitted) break;
      }
    }
    throw new Error(`${backend} could not stream ${req.purpose} after ${LIVE_RETRY_ATTEMPTS} attempts: ${lastErr?.message}`);
  }
}
