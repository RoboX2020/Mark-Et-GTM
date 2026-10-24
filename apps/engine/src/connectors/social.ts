import type { EvidenceItem, EvidenceSource } from "@market/core";
import type { EngineConfig } from "../config.js";

// Bright Data and Apify return differently shaped records per dataset/actor.
// `normalise` maps the common field names onto EvidenceItem and deliberately
// drops author/handle fields: we keep what was said, never who said it.

type Raw = Record<string, unknown>;

const TEXT_KEYS = ["text", "full_text", "description", "body", "content", "post", "selftext", "review", "reviewText", "comment", "caption", "title"];
const TITLE_KEYS = ["title", "name", "headline", "tagline"];
const DATE_KEYS = ["date_posted", "created_at", "createdAt", "date", "published_at", "publishedAt", "create_time", "createTimeISO", "timestamp", "time", "postedAt", "updated"];
const URL_KEYS = ["url", "link", "post_url", "postUrl", "webVideoUrl", "permalink"];
const ENGAGE_KEYS = ["num_upvotes", "upvotes", "score", "likes", "likeCount", "favorite_count", "diggCount", "playCount", "votesCount", "num_comments", "commentCount", "rating", "views"];

function first(r: Raw, keys: string[]): unknown {
  for (const k of keys) if (r[k] !== undefined && r[k] !== null && r[k] !== "") return r[k];
  return undefined;
}

function toIso(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  const d = typeof v === "number" ? new Date(v < 1e12 ? v * 1000 : v) : new Date(String(v));
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export function normalise(r: Raw, source: EvidenceSource, query: string, idx: number): EvidenceItem | null {
  const text = String(first(r, TEXT_KEYS) ?? "").trim();
  if (text.length < 12) return null;
  const titleRaw = first(r, TITLE_KEYS);
  const engagement = ENGAGE_KEYS.map((k) => Number(r[k])).filter((n) => Number.isFinite(n)).reduce((a, b) => a + b, 0);
  const url = first(r, URL_KEYS);
  return {
    id: `${source}_${Buffer.from(`${url ?? text}`).toString("base64url").slice(0, 10)}_${idx}`,
    source,
    title: titleRaw && titleRaw !== text ? String(titleRaw).slice(0, 200) : undefined,
    text: text.slice(0, 1200),
    url: typeof url === "string" ? url : undefined,
    publishedAt: toIso(first(r, DATE_KEYS)) ?? "",
    engagement,
    query,
  };
}

async function json(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${res.status} ${url.split("?")[0]}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Bright Data SERP API → Google News results, optionally capped at a cutoff date. */
export async function brightdataNews(cfg: EngineConfig["brightdata"], query: string, cutoff?: string): Promise<Raw[]> {
  const params = new URLSearchParams({ q: query, tbm: "nws", hl: "en", gl: "us", num: "30", brd_json: "1" });
  if (cutoff) {
    const d = new Date(cutoff);
    params.set("tbs", `cdr:1,cd_max:${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`);
  }
  const body = await json("https://api.brightdata.com/request", {
    method: "POST",
    headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" },
    body: JSON.stringify({ zone: cfg.serpZone, url: `https://www.google.com/search?${params}`, format: "raw" }),
  });
  const b = (typeof body === "string" ? JSON.parse(body) : body) as { news?: Raw[]; organic?: Raw[] };
  return (b.news ?? b.organic ?? []).map((n) => ({ ...n, text: n.snippet ?? n.description ?? n.title }));
}

/** Bright Data Web Scraper API: trigger a keyword discovery snapshot, poll, download. */
export async function brightdataDataset(cfg: EngineConfig["brightdata"], datasetId: string, keyword: string, limit = 60): Promise<Raw[]> {
  const headers = { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" };
  const trig = (await json(
    `https://api.brightdata.com/datasets/v3/trigger?dataset_id=${datasetId}&include_errors=true&type=discover_new&discover_by=keyword&limit_per_input=${limit}`,
    { method: "POST", headers, body: JSON.stringify([{ keyword }]) },
  )) as { snapshot_id: string };
  for (let i = 0; i < 60; i++) {
    const p = (await json(`https://api.brightdata.com/datasets/v3/progress/${trig.snapshot_id}`, { headers })) as { status: string };
    if (p.status === "ready") break;
    if (p.status === "failed") throw new Error("brightdata snapshot failed");
    await sleep(5000);
  }
  return (await json(`https://api.brightdata.com/datasets/v3/snapshot/${trig.snapshot_id}?format=json`, { headers })) as Raw[];
}

/** Apify: run an actor synchronously and return its dataset items. */
export async function apifyActor(token: string, actor: string, input: Raw): Promise<Raw[]> {
  return (await json(`https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items?timeout=180`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(input),
  })) as Raw[];
}

/** Generic actor input covering the common parameter names used by Store actors. */
export function apifyInput(source: EvidenceSource, query: string, limit = 50): Raw {
  return {
    searches: [query],
    searchTerms: [query],
    searchQueries: [query],
    queries: [query],
    keyword: query,
    term: query,
    maxItems: limit,
    maxResults: limit,
    resultsPerPage: limit,
    sort: source === "reddit" ? "relevance" : undefined,
  };
}
