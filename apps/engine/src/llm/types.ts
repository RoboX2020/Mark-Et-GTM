import type { Backend } from "@market/core";
import type { z } from "zod";

export interface JsonRequest<T> {
  /** Short label for usage accounting, e.g. "graph", "swarm.decide". */
  purpose: string;
  /** Stable instructions and shared context; cached where the backend supports it. */
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  maxTokens?: number;
  /**
   * Skip constrained decoding and validate the reply instead. Needed for schemas
   * too large for a structured-output grammar (the knowledge graph).
   */
  freeform?: boolean;
  /** Deterministic offline answer. Required: every call must work with no network. */
  mock: () => T;
}

export interface TextRequest {
  purpose: string;
  system: string;
  prompt: string;
  maxTokens?: number;
  mock: () => string;
}

export interface Usage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

export interface LlmClient {
  readonly backend: Backend;
  json<T>(req: JsonRequest<T>): Promise<T>;
  stream(req: TextRequest): AsyncIterable<string>;
}

export class UsageMeter {
  readonly byKey: Record<string, Usage> = {};
  add(backend: Backend, purpose: string, input: number, output: number) {
    const k = `${backend}:${purpose}`;
    const u = (this.byKey[k] ??= { calls: 0, inputTokens: 0, outputTokens: 0 });
    u.calls++;
    u.inputTokens += input;
    u.outputTokens += output;
  }
}

/** Pulls the first JSON object/array out of a model reply (fences, <think> blocks, prose). */
export function extractJson(text: string): unknown {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/```(?:json)?/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.search(/[[{]/);
    const end = Math.max(cleaned.lastIndexOf("}"), cleaned.lastIndexOf("]"));
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new Error("no JSON in model reply");
  }
}

/** Limits concurrent async work. */
export function limiter(n: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  const next = () => {
    if (active >= n || !queue.length) return;
    active++;
    queue.shift()!();
  };
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    await new Promise<void>((resolve) => {
      queue.push(resolve);
      next();
    });
    try {
      return await fn();
    } finally {
      active--;
      next();
    }
  };
}
