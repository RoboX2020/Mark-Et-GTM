import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import type { Brief, EventEnvelope, PriceModel } from "@market/core";
import { loadConfig, REPO_ROOT, type Mode } from "./config.js";
import { runSimulation } from "./pipeline.js";

/**
 * A small local HTTP bridge so the portal's Market World can start real runs.
 * It binds to 127.0.0.1 only: it spends model credits, so it must never be
 * exposed publicly. Runs use the engine's configured MARKET_MODE unless
 * ENGINE_SERVE_MODE overrides it.
 *
 *   POST /runs                       { product: {name, description}, price: {amount, model}, population }
 *   GET  /runs/:id/events?from=N     → { events, done, error? }
 */

const PORT = Number(process.env.ENGINE_PORT ?? 8787);
const HOST = "127.0.0.1";
const MAX_BODY = 32_000;
const PRICE_MODELS: PriceModel[] = ["one_time", "subscription_monthly", "subscription_annual", "freemium"];

const cfg = loadConfig({ mode: (process.env.ENGINE_SERVE_MODE as Mode | undefined) || undefined });
const base = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "data/briefs/example.json"), "utf8")) as Brief;

interface Job {
  file: string;
  done: boolean;
  error?: string;
}
const jobs = new Map<string, Job>();
let active = 0;

function send(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function str(v: unknown, max: number): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined;
}

function briefFrom(body: Record<string, unknown>): Brief {
  const product = (body.product ?? {}) as Record<string, unknown>;
  const price = (body.price ?? {}) as Record<string, unknown>;
  const amount = Number(price.amount);
  const model = PRICE_MODELS.includes(price.model as PriceModel) ? (price.model as PriceModel) : base.price.model;
  const population = Math.round(Number(body.population));
  return {
    ...base,
    product: {
      ...base.product,
      name: str(product.name, 80) ?? base.product.name,
      description: str(product.description, 600) ?? base.product.description,
    },
    price: { ...base.price, amount: Number.isFinite(amount) && amount >= 0 ? amount : base.price.amount, model },
    population: Number.isFinite(population) ? Math.min(300, Math.max(40, population)) : Math.min(base.population, 200),
    seed: crypto.randomInt(1, 2 ** 31),
  };
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((ok, fail) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        fail(new Error("body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => ok(Buffer.concat(chunks).toString("utf8")));
    req.on("error", fail);
  });
}

/** Reads complete lines only, so a half-written event is picked up on the next poll. */
function readEvents(file: string, from: number): EventEnvelope[] {
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, "utf8");
  const end = text.lastIndexOf("\n");
  if (end < 0) return [];
  return text
    .slice(0, end)
    .split("\n")
    .slice(from)
    .filter(Boolean)
    .map((l) => JSON.parse(l) as EventEnvelope);
}

const server = http.createServer(async (req, res) => {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
  // Lets an https page (the hosted portal) reach this loopback server in Chromium.
  res.setHeader("access-control-allow-private-network", "true");
  if (req.method === "OPTIONS") return void res.writeHead(204).end();

  const url = new URL(req.url ?? "/", `http://${HOST}`);
  try {
    if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true, mode: cfg.mode, active });

    if (req.method === "POST" && url.pathname === "/runs") {
      if (active >= 2) return send(res, 429, { error: "two runs already in progress" });
      const brief = briefFrom(JSON.parse((await readBody(req)) || "{}") as Record<string, unknown>);
      const runId = `world_${Date.now().toString(36)}_${crypto.randomBytes(2).toString("hex")}`;
      const file = path.join(cfg.dataDir, "runs", `${runId}.jsonl`);
      const job: Job = { file, done: false };
      jobs.set(runId, job);
      active++;
      const label = `${brief.product.name} · ${brief.price.currency} ${brief.price.amount}`;
      console.log(`▶ world run ${runId} "${label}" mode=${cfg.mode} population=${brief.population}`);
      runSimulation(cfg, { brief, label, runId, outFile: file })
        .catch((err: Error) => {
          job.error = err.message;
          console.error(`✗ ${runId}`, err);
        })
        .finally(() => {
          job.done = true;
          active--;
        });
      return send(res, 201, { runId, mode: cfg.mode });
    }

    const m = url.pathname.match(/^\/runs\/([\w-]+)\/events$/);
    if (req.method === "GET" && m) {
      const job = jobs.get(m[1]);
      if (!job) return send(res, 404, { error: "unknown run" });
      const from = Math.max(0, Number(url.searchParams.get("from")) || 0);
      const events = readEvents(job.file, from);
      const last = events[events.length - 1]?.event.type;
      const done = last === "run.completed" || (job.done && events.length === 0);
      return send(res, 200, { events, done, error: job.error });
    }

    send(res, 404, { error: "not found" });
  } catch (err) {
    send(res, 400, { error: (err as Error).message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Market World engine bridge on http://${HOST}:${PORT} (mode=${cfg.mode})`);
  console.log("In the portal, open Market World and set the engine URL to this address.");
});
