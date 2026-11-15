import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, REPO_ROOT, type EngineConfig } from "@market/engine/config";
import type { ClientWrap } from "@market/engine/llm/router";
import { Budget } from "./budget.js";
import { buildBrief, InputError } from "./brief.js";
import { BudgetGuard } from "./guard.js";
import { spendStoreFromEnv, type SpendStore } from "./ledger.js";
import { RefusedError, RunManager, toManifestEntry } from "./runs.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const env = (k: string, d = "") => (process.env[k] ?? d).trim();

export interface ServerOptions {
  port: number;
  host: string;
  cfg: EngineConfig;
  runsDir: string;
  portalDist?: string;
  budget?: Budget;
  model: string;
  wrapClient?: ClientWrap;
  /** Live count of calls whose reservations are still outstanding (current run's guard). */
  unresolvedCount?: () => number;
  /** False when the durable spend ledger cannot be written: billable runs refuse (fail closed). */
  ledgerHealthy?: () => boolean;
  /** Required x-operator-token header value for starting runs in live mode. */
  operatorToken?: string;
  /** Which durable ledger backend is active (file|github), for /api/health. */
  ledgerBackend?: string;
  spendStore?: SpendStore;
  perRunCapUsd: number;
  maxRunsPerIpPerDay: number;
  maxRunsPerDay: number;
}

const MAX_BODY_BYTES = 8 * 1024;
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jsonl": "application/x-ndjson; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};

function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8", ...headers });
  res.end(text);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        // Drain the rest so the socket stays healthy enough to answer 400.
        tooBig = true;
        chunks.length = 0;
        return;
      }
      if (!tooBig) chunks.push(c);
    });
    req.on("end", () => {
      if (tooBig) reject(new InputError("request body too large"));
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

function clientIp(req: http.IncomingMessage): string {
  // No proxy is trusted by default: only the direct peer counts. If the server is
  // later put behind a known reverse proxy, wire TRUST_PROXY=1 and the first
  // x-forwarded-for entry becomes the visitor ip.
  if (env("TRUST_PROXY") === "1") {
    const fwd = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim();
    if (fwd) return fwd;
  }
  return req.socket.remoteAddress ?? "unknown";
}

function serveStatic(res: http.ServerResponse, dist: string, urlPath: string): boolean {
  const clean = decodeURIComponent(urlPath.split("?")[0]).replace(/^\/+/, "");
  if (clean.includes("\0") || clean.split("/").some((p) => p.startsWith("."))) return false;
  let file = path.resolve(dist, clean);
  if (!file.startsWith(path.resolve(dist) + path.sep) && clean !== "") return false;
  if (clean === "" || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    // SPA fallback: unknown paths render the app shell.
    file = path.join(dist, "index.html");
    if (!fs.existsSync(file)) return false;
  }
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, { "content-type": MIME[ext] ?? "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
  return true;
}

export function createServer(opts: ServerOptions): { server: http.Server; manager: RunManager } {
  const manager = new RunManager(opts.cfg, opts.runsDir, opts);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (url.pathname === "/api/health" && req.method === "GET") {
        return send(res, 200, {
          ok: true,
          mode: opts.cfg.mode,
          model: opts.cfg.mode === "live" ? opts.model : "mock",
          activeRun: manager.list().find((r) => r.status === "running")?.id ?? null,
          budget: opts.budget
            ? {
                capUsd: opts.budget.cap,
                committedUsd: Number(opts.budget.committed.toFixed(4)),
                remainingUsd: Number(opts.budget.remaining.toFixed(4)),
                calls: opts.budget.calls,
                unresolved: opts.unresolvedCount ? opts.unresolvedCount() : 0,
                ledgerBackend: opts.ledgerBackend,
                ledgerHealthy: opts.ledgerHealthy ? opts.ledgerHealthy() : undefined,
                billableRuns: "operator-only",
              }
            : null,
          labeling: "All results are simulated by AI-generated synthetic users - not real customer validation.",
        });
      }

      if (url.pathname === "/api/runs" && req.method === "POST") {
        // Billable runs are operator-only: the public site replays finished runs.
        if (opts.budget) {
          const tok = String(req.headers["x-operator-token"] ?? "");
          const expectTok = opts.operatorToken ?? "";
          const ok =
            expectTok.length > 0 &&
            tok.length === expectTok.length &&
            crypto.timingSafeEqual(Buffer.from(tok), Buffer.from(expectTok));
          if (!ok) return send(res, 403, { error: "live runs are operator-only; finished runs are open to everyone" });
        }
        const raw = await readBody(req);
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          throw new InputError("body must be valid JSON");
        }
        const brief = buildBrief(parsed);
        const label = `${brief.product.name} · ${brief.price.amount > 0 ? `$${brief.price.amount}/mo` : "free"}`;
        const rec = await manager.start(brief, label, clientIp(req));
        return send(res, 201, { run: toManifestEntry(rec) });
      }

      if (url.pathname === "/api/runs/index.json" && req.method === "GET") {
        return send(res, 200, manager.list().map(toManifestEntry));
      }

      const runFile = url.pathname.match(/^\/api\/runs\/(run_[\w-]+\.jsonl)$/);
      if (runFile && req.method === "GET") {
        const file = path.join(opts.runsDir, runFile[1]);
        if (!fs.existsSync(file)) return send(res, 404, { error: "run not found" });
        res.writeHead(200, { "content-type": MIME[".jsonl"] });
        return fs.createReadStream(file).pipe(res);
      }

      if (url.pathname.startsWith("/api/")) return send(res, 404, { error: "not found" });

      if (opts.portalDist && req.method === "GET") {
        if (serveStatic(res, opts.portalDist, url.pathname)) return;
      }
      return send(res, 404, { error: "not found" });
    } catch (err) {
      if (err instanceof InputError) return send(res, 400, { error: err.message });
      if (err instanceof RefusedError) return send(res, 429, { error: err.message });
      console.error("[server]", err);
      return send(res, 500, { error: "internal error" });
    }
  });

  return { server, manager };
}

/** Builds server options from the environment. Live mode refuses to boot without a key,
 *  a budget cap, a durable spend ledger that loads, and an operator token. */
export async function optionsFromEnv(): Promise<ServerOptions> {
  const mode = (env("MARKET_MODE", "mock") || "mock") as "live" | "mock";
  const cfg = loadConfig({ mode });
  const model = env("MARK8_MODEL", "claude-haiku-5-5");
  let budget: Budget | undefined;
  let wrapClient: ClientWrap | undefined;
  let unresolvedCount: (() => number) | undefined;
  let ledgerHealthy: (() => boolean) | undefined;
  let operatorToken: string | undefined;
  let ledgerBackend: string | undefined;
  let spendStore: SpendStore | undefined;

  if (mode === "live") {
    const key = env("ANTHROPIC_API_KEY") || (env("CLAUDE_KEY_FILE") ? fs.readFileSync(env("CLAUDE_KEY_FILE"), "utf8").trim() : "");
    if (!key) throw new Error("live mode needs ANTHROPIC_API_KEY or CLAUDE_KEY_FILE");
    const capUsd = Number(env("MARK8_BUDGET_USD"));
    if (!(capUsd > 0)) throw new Error("live mode needs MARK8_BUDGET_USD > 0 (total app-side cap)");
    // Standing product decisions: Claude only (no Google API), cheapest verified model
    // for agent Q&A, low effort; the swarm mix is forced onto Claude.
    cfg.anthropic.apiKey = key;
    cfg.anthropic.model = model;
    cfg.anthropic.effort = "low";
    cfg.swarmMix = { claude: 1 };
    // Durable committed-spend store. A store that cannot be read fails closed
    // (throws here: live mode refuses to boot); a store that stops writing
    // latches unhealthy and new billable runs are refused.
    const ledger = await spendStoreFromEnv(env, path.join(REPO_ROOT, "data", "server", "spend.json"));
    spendStore = ledger.store;
    ledgerBackend = ledger.backend;
    budget = new Budget(capUsd, ledger.restored);
    budget.onChange = (committed) => {
      void ledger.store.save(committed).catch(() => {}); // backends latch their own failure
    };
    ledgerHealthy = () => ledger.store.healthy();
    // Billable runs are operator-only until public runtime authority is settled:
    // without a token there is no way to prove the caller is the operator, so
    // live mode refuses to boot rather than expose billable runs to visitors.
    operatorToken = env("MARK8_OPERATOR_TOKEN");
    if (!operatorToken) throw new Error("live mode needs MARK8_OPERATOR_TOKEN (billable runs are operator-only)");
    let guard: BudgetGuard | undefined;
    wrapClient = (client, usage) => {
      // One guard per run (each run has its own usage meter); the budget is shared.
      guard = new BudgetGuard(usage, budget!, model);
      return guard.wrap(client);
    };
    unresolvedCount = () => guard?.unresolved ?? 0;
  }

  return {
    port: Number(env("PORT", "8787")),
    host: env("HOST", "127.0.0.1"),
    cfg,
    runsDir: env("MARK8_RUNS_DIR", path.join(REPO_ROOT, "data", "runs")),
    // The portal ships beside the server in this repo; override with PORTAL_DIST.
    portalDist: env("PORTAL_DIST", path.join(REPO_ROOT, "apps", "portal", "dist")),
    budget,
    model,
    wrapClient,
    unresolvedCount,
    ledgerHealthy,
    operatorToken,
    ledgerBackend,
    spendStore,
    perRunCapUsd: Number(env("MARK8_PER_RUN_CAP_USD", "1")),
    maxRunsPerIpPerDay: Number(env("MARK8_MAX_RUNS_PER_IP_PER_DAY", "3")),
    maxRunsPerDay: Number(env("MARK8_MAX_RUNS_PER_DAY", "20")),
  };
}

// Booted directly (not imported by tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const opts = await optionsFromEnv();
  const { server } = createServer(opts);
  server.listen(opts.port, opts.host, () => {
    console.log(`mark8 server on http://${opts.host}:${opts.port} mode=${opts.cfg.mode}${opts.budget ? ` budget=$${opts.budget.cap}` : ""}`);
  });
}
