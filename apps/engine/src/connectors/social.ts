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

const REDDIT_DATES = ["Past hour", "Past day", "Past week", "Past month", "Past year", "All time"] as const;

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
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${url.split("?")[0]}: ${text.slice(0, 200)}`);
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`non-JSON response from ${url.split("?")[0]}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Map a simulation cutoff to a Bright Data Reddit `date` filter. */
export function redditDateFromCutoff(cutoff?: string): (typeof REDDIT_DATES)[number] {
  if (!cutoff) return "Past year";
  const ageMs = Date.now() - new Date(cutoff).getTime();
  if (ageMs <= 0) return "Past week";
  const days = ageMs / 86_400_000;
  if (days <= 1) return "Past day";
  if (days <= 7) return "Past week";
  if (days <= 31) return "Past month";
  if (days <= 366) return "Past year";
  return "All time";
}

export interface BrightDiscoverSpec {
  discoverBy: string;
  input: Raw[];
}

/** Per-dataset discovery inputs (Bright Data rejects bare `{ keyword }` bodies). */
export function brightdataDiscoverInput(source: EvidenceSource, keyword: string, limit: number, cutoff?: string): BrightDiscoverSpec | null {
  switch (source) {
    case "reddit":
      return {
        discoverBy: "keyword",
        input: [{ keyword, date: redditDateFromCutoff(cutoff), num_of_posts: Math.min(limit, 100) }],
      };
    case "tiktok":
      return {
        discoverBy: "keyword",
        input: [{ search_keyword: keyword, num_of_posts: Math.min(limit, 60) }],
      };
    default:
      return null;
  }
}

const X_STATUS = /(?:https?:\/\/)?(?:www\.)?(?:x|twitter)\.com\/[^/?#]+\/status\/(\d+)/i;

/** Pull post URLs out of SERP organic rows for X post collection. */
export function xPostUrlsFromSerp(rows: Raw[], cap = 20): string[] {
  const out: string[] = [];
  for (const r of rows) {
    let link = String(r.link ?? r.url ?? "").split("?")[0];
    if (!link || !X_STATUS.test(link)) continue;
    out.push(link.replace(/twitter\.com/i, "x.com"));
  }
  return [...new Set(out)].slice(0, cap);
}

function authHeaders(token: string) {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

async function waitSnapshot(token: string, snapshotId: string): Promise<void> {
  const headers = authHeaders(token);
  for (let i = 0; i < 60; i++) {
    const p = (await json(`https://api.brightdata.com/datasets/v3/progress/${snapshotId}`, { headers })) as { status: string };
    if (p.status === "ready") return;
    if (p.status === "failed") throw new Error("brightdata snapshot failed");
    await sleep(5000);
  }
  throw new Error("brightdata snapshot timed out");
}

async function downloadSnapshot(token: string, snapshotId: string): Promise<Raw[]> {
  const headers = authHeaders(token);
  const body = await json(`https://api.brightdata.com/datasets/v3/snapshot/${snapshotId}?format=json`, { headers });
  if (!body) return [];
  return Array.isArray(body) ? (body as Raw[]) : [];
}

/** Bright Data SERP API → Google News results, optionally capped at a cutoff date. */
export async function brightdataNews(cfg: EngineConfig["brightdata"], query: string, cutoff?: string): Promise<Raw[]> {
  const params = new URLSearchParams({ q: query, tbm: "nws", hl: "en", gl: "us", num: "30", brd_json: "1" });
  if (cutoff) {
    const d = new Date(cutoff);
    params.set("tbs", `cdr:1,cd_max:${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`);
  }
  const body = await json("https://api.brightdata.com/request", {
    method: "POST",
    headers: authHeaders(cfg.token),
    body: JSON.stringify({ zone: cfg.serpZone, url: `https://www.google.com/search?${params}`, format: "raw" }),
  });
  if (body === null) return [];
  const parsed = typeof body === "string" ? JSON.parse(body) : body;
  const b = parsed as { news?: Raw[]; organic?: Raw[] };
  return (b.news ?? b.organic ?? []).map((n) => ({ ...n, text: n.snippet ?? n.description ?? n.title }));
}

/** Collect known X post URLs (Bright Data posts dataset, no keyword discovery). */
export async function brightdataCollectUrls(cfg: EngineConfig["brightdata"], datasetId: string, urls: string[]): Promise<Raw[]> {
  if (!urls.length) return [];
  const headers = authHeaders(cfg.token);
  const chunks: Raw[] = [];
  for (let i = 0; i < urls.length; i += 20) {
    const slice = urls.slice(i, i + 20);
    const body = await json(`https://api.brightdata.com/datasets/v3/scrape?dataset_id=${datasetId}&format=json&include_errors=true`, {
      method: "POST",
      headers,
      body: JSON.stringify({ input: slice.map((url) => ({ url })) }),
    });
    if (Array.isArray(body)) chunks.push(...body);
  }
  return chunks;
}

/** Discover posts from fixed X profile URLs (`discover_by=profiles_array`). */
export async function brightdataXProfiles(cfg: EngineConfig["brightdata"], datasetId: string, profileUrls: string[], limit = 40): Promise<Raw[]> {
  if (!profileUrls.length) return [];
  const headers = authHeaders(cfg.token);
  const trig = (await json(
    `https://api.brightdata.com/datasets/v3/trigger?dataset_id=${datasetId}&format=json&include_errors=true&type=discover_new&discover_by=profiles_array&limit_per_input=${limit}`,
    { method: "POST", headers, body: JSON.stringify({ input: profileUrls.map((url) => ({ url })) }) },
  )) as { snapshot_id: string };
  await waitSnapshot(cfg.token, trig.snapshot_id);
  return downloadSnapshot(cfg.token, trig.snapshot_id);
}

/** Bright Data Web Scraper API: keyword discovery with the correct input schema per network. */
export async function brightdataDataset(
  cfg: EngineConfig["brightdata"],
  source: EvidenceSource,
  datasetId: string,
  keyword: string,
  cutoff?: string,
  limit = 60,
): Promise<Raw[]> {
  const spec = brightdataDiscoverInput(source, keyword, limit, cutoff);
  if (!spec) return [];
  const headers = authHeaders(cfg.token);
  const trig = (await json(
    `https://api.brightdata.com/datasets/v3/trigger?dataset_id=${datasetId}&format=json&include_errors=true&type=discover_new&discover_by=${spec.discoverBy}`,
    { method: "POST", headers, body: JSON.stringify({ input: spec.input, limit_per_input: limit }) },
  )) as { snapshot_id: string };
  await waitSnapshot(cfg.token, trig.snapshot_id);
  return downloadSnapshot(cfg.token, trig.snapshot_id);
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
