import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Mode } from "./config.js";

/**
 * Content-addressed read-through cache for every external call. In "live"
 * mode misses are fetched and stored; in "cache" and "mock" mode a miss
 * returns null and the caller falls back to fixtures.
 */
export class Cache {
  constructor(private dir: string, private mode: Mode) {}

  key(namespace: string, params: unknown): string {
    const h = crypto.createHash("sha256").update(namespace + "\n" + stableStringify(params)).digest("hex").slice(0, 24);
    return path.join(this.dir, namespace, `${h}.json`);
  }

  read<T>(namespace: string, params: unknown): T | null {
    const file = this.key(namespace, params);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8")).data as T;
  }

  write(namespace: string, params: unknown, data: unknown) {
    const file = this.key(namespace, params);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ namespace, params, fetchedAt: new Date().toISOString(), data }, null, 1));
  }

  async through<T>(namespace: string, params: unknown, fetcher: () => Promise<T>): Promise<T | null> {
    const hit = this.read<T>(namespace, params);
    if (hit !== null) return hit;
    if (this.mode !== "live") return null;
    const data = await fetcher();
    this.write(namespace, params, data);
    return data;
  }
}

export function stableStringify(x: unknown): string {
  if (x === null || typeof x !== "object") return JSON.stringify(x);
  if (Array.isArray(x)) return `[${x.map(stableStringify).join(",")}]`;
  return `{${Object.keys(x as object)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify((x as Record<string, unknown>)[k])}`)
    .join(",")}}`;
}
