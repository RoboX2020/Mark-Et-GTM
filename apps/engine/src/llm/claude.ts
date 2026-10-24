import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import type { EngineConfig } from "../config.js";
import { extractJson, type JsonRequest, type LlmClient, type TextRequest, type UsageMeter } from "./types.js";

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

  // Streamed even for structured output: the SDK rejects non-streaming requests
  // whose max_tokens could run past its timeout (graph extraction needs ~24k).
  async json<T>(req: JsonRequest<T>): Promise<T> {
    if (req.freeform) return this.freeformJson(req);
    const res = await this.complete(req.purpose, req.system, [{ role: "user", content: req.prompt }], req.maxTokens ?? 16000, betaZodOutputFormat(req.schema));
    return req.schema.parse(JSON.parse(textOf(res)));
  }

  /** Schema in the prompt, zod validation after, one corrective retry. */
  private async freeformJson<T>(req: JsonRequest<T>): Promise<T> {
    const system = `${req.system}\n\nReply with a single JSON object and nothing else. It must validate against this JSON Schema:\n${JSON.stringify(z.toJSONSchema(req.schema))}`;
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: req.prompt }];
    const first = await this.complete(req.purpose, system, messages, req.maxTokens ?? 16000);
    const firstText = textOf(first);
    let problem: string;
    try {
      return req.schema.parse(extractJson(firstText));
    } catch (err) {
      problem = err instanceof Error ? err.message.slice(0, 2000) : String(err);
    }
    messages.push({ role: "assistant", content: first.content }, { role: "user", content: `That JSON did not validate:\n${problem}\nReply with the corrected JSON object only.` });
    return req.schema.parse(extractJson(textOf(await this.complete(req.purpose, system, messages, req.maxTokens ?? 16000))));
  }

  // Always streamed: the SDK rejects non-streaming requests whose max_tokens
  // could run past its timeout (graph extraction needs ~24k).
  private async complete(
    purpose: string,
    system: string,
    messages: Anthropic.Beta.BetaMessageParam[],
    maxTokens: number,
    format?: ReturnType<typeof betaZodOutputFormat>,
  ): Promise<Anthropic.Beta.BetaMessage> {
    const stream = this.client.beta.messages.stream({
      model: this.cfg.model,
      max_tokens: maxTokens,
      betas: [FALLBACK_BETA],
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: format ? { effort: this.cfg.effort, format } : { effort: this.cfg.effort },
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages,
    });
    const res = await stream.finalMessage();
    this.record(purpose, res.usage);
    if (res.stop_reason === "refusal") throw new RefusalError(`Claude declined ${purpose}: ${res.stop_details?.explanation ?? "no detail"}`);
    if (res.stop_reason === "max_tokens") throw new Error(`Claude hit max_tokens on ${purpose}`);
    return res;
  }

  private record(purpose: string, u: Anthropic.Beta.BetaUsage) {
    const input = u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    this.usage.add("claude", purpose, input, u.output_tokens);
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
    this.record(req.purpose, final.usage);
    if (final.stop_reason === "refusal") throw new RefusalError(`Claude declined ${req.purpose}`);
  }
}

const textOf = (m: Anthropic.Beta.BetaMessage) => m.content.map((b) => (b.type === "text" ? b.text : "")).join("");
