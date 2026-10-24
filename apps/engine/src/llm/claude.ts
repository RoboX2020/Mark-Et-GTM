import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { EngineConfig } from "../config.js";
import type { JsonRequest, LlmClient, TextRequest, UsageMeter } from "./types.js";

// Server-side refusal fallback: on a policy decline the API re-runs the request
// on Anthropic's recommended fallback model within the same call.
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export class RefusalError extends Error {}

export class ClaudeClient implements LlmClient {
  readonly backend = "claude" as const;
  private client: Anthropic;

  constructor(private cfg: EngineConfig["anthropic"], private usage: UsageMeter) {
    this.client = new Anthropic({ apiKey: cfg.apiKey });
  }

  async json<T>(req: JsonRequest<T>): Promise<T> {
    const res = await this.client.beta.messages.parse({
      model: this.cfg.model,
      max_tokens: req.maxTokens ?? 16000,
      betas: [FALLBACK_BETA],
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: { effort: this.cfg.effort, format: betaZodOutputFormat(req.schema) },
      system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: req.prompt }],
    });
    this.usage.add("claude", req.purpose, res.usage.input_tokens + (res.usage.cache_read_input_tokens ?? 0), res.usage.output_tokens);
    if (res.stop_reason === "refusal") throw new RefusalError(`Claude declined ${req.purpose}: ${res.stop_details?.explanation ?? "no detail"}`);
    if (res.stop_reason === "max_tokens") throw new Error(`Claude hit max_tokens on ${req.purpose}`);
    if (!res.parsed_output) throw new Error(`Claude returned no parseable output for ${req.purpose}`);
    return res.parsed_output as T;
  }

  async *stream(req: TextRequest): AsyncIterable<string> {
    const stream = this.client.beta.messages.stream({
      model: this.cfg.model,
      max_tokens: req.maxTokens ?? 32000,
      betas: [FALLBACK_BETA],
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: { effort: this.cfg.effort },
      system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: req.prompt }],
    });
    for await (const ev of stream) {
      if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") yield ev.delta.text;
    }
    const final = await stream.finalMessage();
    this.usage.add("claude", req.purpose, final.usage.input_tokens + (final.usage.cache_read_input_tokens ?? 0), final.usage.output_tokens);
    if (final.stop_reason === "refusal") throw new RefusalError(`Claude declined ${req.purpose}`);
  }
}
