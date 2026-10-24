import fs from "node:fs";
import path from "node:path";
import type { AnchorInterview } from "@market/core";

/**
 * Loads real interview anchors. Listen Labs doesn't publish a public API we
 * can verify against, so the supported path is an export: drop JSON files in
 * data/anchors/ (format documented in data/anchors/README.md). Raw
 * transcripts are reduced to a summary and short quotes before use.
 */
export function loadAnchors(dataDir: string): AnchorInterview[] {
  const dir = path.join(dataDir, "anchors");
  if (!fs.existsSync(dir)) return [];
  const out: AnchorInterview[] = [];
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    for (const [i, a] of (Array.isArray(raw) ? raw : [raw]).entries()) {
      if (!a?.summary) continue;
      out.push({
        id: a.id ?? `anchor_${path.basename(f, ".json")}_${i}`,
        segmentHint: String(a.segmentHint ?? a.segment ?? "unspecified"),
        summary: String(a.summary).slice(0, 1500),
        quotes: (a.quotes ?? []).map(String).slice(0, 6),
        statedWtp: typeof a.statedWtp === "number" ? a.statedWtp : undefined,
      });
    }
  }
  return out;
}
