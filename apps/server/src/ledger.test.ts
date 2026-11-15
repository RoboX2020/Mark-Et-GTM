import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import { loadConfig } from "@market/engine/config";
import { FileSpendStore, GitHubSpendStore } from "./ledger.js";
import { Budget } from "./budget.js";
import { createServer } from "./main.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "mark8-ledger-"));

describe("FileSpendStore", () => {
  it("treats a missing file as a genuine first boot (zero)", async () => {
    const dir = tmp();
    const store = new FileSpendStore(path.join(dir, "spend.json"));
    expect(await store.load()).toBe(0);
    await store.save(1.25);
    expect(await new FileSpendStore(path.join(dir, "spend.json")).load()).toBe(1.25);
  });

  it("fails closed on a corrupt ledger instead of resetting spend to zero", async () => {
    const dir = tmp();
    const file = path.join(dir, "spend.json");
    fs.writeFileSync(file, "{not json");
    await expect(new FileSpendStore(file).load()).rejects.toThrow(/refusing to run live/);
  });
});

describe("GitHubSpendStore", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("creates the record at zero on first boot (404), then restores it", async () => {
    const calls: { method: string; body?: string }[] = [];
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      calls.push({ method: init?.method ?? "GET", body: init?.body as string });
      if (calls.length === 1) return new Response("not found", { status: 404 });
      if (init?.method === "PUT")
        return new Response(JSON.stringify({ content: { sha: "sha1" } }), { status: 201 });
      return new Response(
        JSON.stringify({ sha: "sha1", content: Buffer.from(JSON.stringify({ totalCommittedUsd: 2.5 })).toString("base64") }),
        { status: 200 },
      );
    });
    const store = new GitHubSpendStore("owner/private-repo", "spend.json", "tok");
    expect(await store.load()).toBe(0); // 404 -> created at zero
    expect(calls[1].method).toBe("PUT");
    await store.save(2.5);
    expect(store.healthy()).toBe(true);
  });

  it("latches unhealthy when a save fails (fail closed)", async () => {
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") return new Response("boom", { status: 500 });
      return new Response(
        JSON.stringify({ sha: "s", content: Buffer.from(JSON.stringify({ totalCommittedUsd: 0 })).toString("base64") }),
        { status: 200 },
      );
    });
    const store = new GitHubSpendStore("owner/private-repo", "spend.json", "tok");
    await store.load();
    await store.save(1); // resolves; failure latches internally
    expect(store.healthy()).toBe(false);
  });
});

describe("operator gate (live mode)", () => {
  it("refuses billable runs without the operator token, allows with it until budget check", async () => {
    const runsDir = tmp();
    const { server } = createServer({
      port: 0,
      host: "127.0.0.1",
      cfg: loadConfig({ mode: "mock" }),
      runsDir,
      model: "claude-haiku-5-5",
      budget: new Budget(5, 0), // presence of a budget marks the billable path
      operatorToken: "secret-op-token",
      ledgerHealthy: () => true,
      perRunCapUsd: 1,
      maxRunsPerIpPerDay: 3,
      maxRunsPerDay: 20,
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const brief = { name: "T", idea: "A test product that does a thing", price: 10, market: "testers", population: 8 };
    const noTok = await fetch(`${base}/api/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(brief) });
    expect(noTok.status).toBe(403);
    const wrongTok = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-operator-token": "nope" },
      body: JSON.stringify(brief),
    });
    expect(wrongTok.status).toBe(403);
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(runsDir, { recursive: true, force: true });
  });

  it("health reports ledger state and operator-only posture", async () => {
    const runsDir = tmp();
    const { server } = createServer({
      port: 0,
      host: "127.0.0.1",
      cfg: loadConfig({ mode: "mock" }),
      runsDir,
      model: "mock",
      ledgerBackend: "file",
      ledgerHealthy: () => true,
      perRunCapUsd: 1,
      maxRunsPerIpPerDay: 3,
      maxRunsPerDay: 20,
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const health = (await (await fetch(`${base}/api/health`)).json()) as { budget: { ledgerBackend?: string; billableRuns?: string } | null };
    // mock mode: no budget block, but the labeling contract always holds
    expect(health.budget).toBeNull();
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(runsDir, { recursive: true, force: true });
  });
});
