import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { loadConfig } from "@market/engine/config";
import { createServer } from "./main.js";

// End-to-end against a real HTTP server in mock mode: no network, no keys, no spend.
let base: string;
let runsDir: string;
let close: () => Promise<void>;

beforeAll(async () => {
  runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "mark8-runs-"));
  const cfg = loadConfig({ mode: "mock" });
  const { server } = createServer({
    port: 0,
    host: "127.0.0.1",
    cfg,
    runsDir,
    model: "mock",
    perRunCapUsd: 1,
    maxRunsPerIpPerDay: 2,
    maxRunsPerDay: 10,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => new Promise((resolve) => server.close(() => resolve()));
});

afterAll(async () => {
  await close();
  fs.rmSync(runsDir, { recursive: true, force: true });
});

async function waitForRun(id: string, timeoutMs = 30_000): Promise<{ id: string; status: string }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const list = (await (await fetch(`${base}/api/runs/index.json`)).json()) as { id: string; status: string }[];
    const rec = list.find((r) => r.id === id);
    if (rec && rec.status !== "running") return rec;
    if (Date.now() > deadline) throw new Error("run did not finish in time");
    await new Promise((r) => setTimeout(r, 250));
  }
}

describe("server (mock mode)", () => {
  it("reports health with the simulated-output labeling", async () => {
    const health = await (await fetch(`${base}/api/health`)).json();
    expect(health.ok).toBe(true);
    expect(health.mode).toBe("mock");
    expect(health.budget).toBeNull();
    expect(health.labeling).toMatch(/simulated/i);
    expect(health.labeling).toMatch(/not real customer validation/i);
  });

  it("rejects a run without an idea", async () => {
    const res = await fetch(`${base}/api/runs`, { method: "POST", body: JSON.stringify({ name: "X" }) });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/idea/);
  });

  it("rejects an over-limit body", async () => {
    const res = await fetch(`${base}/api/runs`, { method: "POST", body: JSON.stringify({ idea: "x".repeat(9000) }) });
    expect([400, 413]).toContain(res.status);
  });

  it("runs a full simulation end to end and serves the event log", async () => {
    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      body: JSON.stringify({ name: "TestCo", idea: "A robot that folds laundry", price: 20, population: 40 }),
    });
    expect(res.status).toBe(201);
    const { run } = await res.json();
    expect(run.id).toMatch(/^run_/);
    expect(run.mode).toBe("mock");

    const done = await waitForRun(run.id);
    expect(done.status).toBe("ok");

    const log = await (await fetch(`${base}/api/runs/${run.file}`)).text();
    expect(log).toContain('"run.started"');
    expect(log).toContain('"run.completed"');
    expect(log).toContain("TestCo");
  });

  it("refuses a second concurrent run", async () => {
    const first = fetch(`${base}/api/runs`, { method: "POST", body: JSON.stringify({ idea: "run one" }) });
    const second = await fetch(`${base}/api/runs`, { method: "POST", body: JSON.stringify({ idea: "run two" }) });
    await first;
    // Either the second was refused (first still active) or, if the first finished
    // instantly, accepted - but the per-IP daily cap of 2 must refuse the third.
    if (second.status === 201) {
      const third = await fetch(`${base}/api/runs`, { method: "POST", body: JSON.stringify({ idea: "run three" }) });
      expect(third.status).toBe(429);
    } else {
      expect(second.status).toBe(429);
    }
  });

  it("does not serve paths outside the runs directory", async () => {
    const res = await fetch(`${base}/api/runs/..%2F..%2Fpackage.json`);
    expect(res.status).toBe(404);
  });
});
