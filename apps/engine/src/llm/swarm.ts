import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import type { EngineConfig } from "../config.js";
import { extractJson, type JsonRequest, type LlmClient, type TextRequest, type UsageMeter } from "./types.js";

/** Gemini: half of the swarm. Uses native JSON-schema constrained output. */
export class GeminiClient implements LlmClient {
  readonly backend = "gemini" as const;
  private ai: GoogleGenAI;
  constructor(private cfg: EngineConfig["gemini"], private usage: UsageMeter) {
    this.ai = new GoogleGenAI({ apiKey: cfg.apiKey });
  }

  async json<T>(req: JsonRequest<T>): Promise<T> {
    const res = await this.ai.models.generateContent({
      model: this.cfg.model,
      contents: req.prompt,
      config: {
        systemInstruction: req.system,
        responseMimeType: "application/json",
        responseJsonSchema: z.toJSONSchema(req.schema),
        maxOutputTokens: req.maxTokens ?? 8192,
      },
    });
    this.usage.add("gemini", req.purpose, res.usageMetadata?.promptTokenCount ?? 0, res.usageMetadata?.candidatesTokenCount ?? 0);
    return req.schema.parse(extractJson(res.text ?? ""));
  }

  async *stream(req: TextRequest): AsyncIterable<string> {
    const res = await this.ai.models.generateContentStream({
      model: this.cfg.model,
      contents: req.prompt,
      config: { systemInstruction: req.system, maxOutputTokens: req.maxTokens ?? 8192 },
    });
    for await (const chunk of res) if (chunk.text) yield chunk.text;
  }
}

/**
 * Runpod Serverless running vLLM with an open-weights model. vLLM exposes an
 * OpenAI-style chat route; guided decoding via `response_format` keeps the
 * output on-schema, and the reply is still validated with zod.
 */
export class RunpodClient implements LlmClient {
  readonly backend = "runpod" as const;
  private url: string;
  constructor(private cfg: EngineConfig["runpod"], private usage: UsageMeter) {
    this.url = `https://api.runpod.ai/v2/${cfg.endpointId}/openai/v1/chat/completions`;
  }

  private async call(req: { system: string; prompt: string; maxTokens?: number; schema?: unknown }) {
    const res = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.cfg.apiKey}` },
      body: JSON.stringify({
        model: this.cfg.model,
        max_tokens: req.maxTokens ?? 4096,
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.prompt },
        ],
        ...(req.schema ? { response_format: { type: "json_schema", json_schema: { name: "reply", schema: req.schema } } } : {}),
      }),
    });
    if (!res.ok) throw new Error(`runpod ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as { choices: { message: { content: string } }[]; usage?: { prompt_tokens: number; completion_tokens: number } };
  }

  async json<T>(req: JsonRequest<T>): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const out = await this.call({ ...req, schema: z.toJSONSchema(req.schema) });
        this.usage.add("runpod", req.purpose, out.usage?.prompt_tokens ?? 0, out.usage?.completion_tokens ?? 0);
        return req.schema.parse(extractJson(out.choices[0]?.message.content ?? ""));
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
  }

  async *stream(req: TextRequest): AsyncIterable<string> {
    const out = await this.call(req);
    yield out.choices[0]?.message.content ?? "";
  }
}

/** Deterministic offline backend: returns each request's own mock answer. */
export class MockClient implements LlmClient {
  constructor(readonly backend: "mock" | "claude" | "gemini" | "runpod" = "mock", private usage?: UsageMeter) {}
  async json<T>(req: JsonRequest<T>): Promise<T> {
    this.usage?.add("mock", req.purpose, 0, 0);
    return req.mock();
  }
  async *stream(req: TextRequest): AsyncIterable<string> {
    this.usage?.add("mock", req.purpose, 0, 0);
    // Emit in word-sized chunks so the portal's streaming text looks the same as live.
    const text = req.mock();
    const parts = text.match(/\S+\s*/g) ?? [text];
    for (let i = 0; i < parts.length; i += 3) yield parts.slice(i, i + 3).join("");
  }
}
