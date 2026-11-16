import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, REPO_ROOT } from "@market/engine/config";
import { runSimulation } from "@market/engine/pipeline";
import type { Brief } from "@market/core";
import { RunManager } from "./runs.js";

// The pipeline is mocked so these tests pin the RunManager's status
// bookkeeping itself: what the manifest says for each way a run can end.
vi.mock("@market/engine/pipeline", () => ({ runSimulation: vi.fn() }));
const mocked = vi.mocked(runSimulation);

const brief = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "data", "briefs", "example.json"), "utf8")) as Brief;

let runsDir: string;
let manager: RunManager;

beforeEach(() => {
  runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "mark8-runs-test-"));
  manager = new RunManager(loadConfig({ mode: "mock" }), runsDir, {
    model: "mock",
    perRunCapUsd: 1,
    maxRunsPerIpPerDay: 5,
    maxRunsPerDay: 10,
  });
  mocked.mockReset();
});

/** Write a run log the way the real pipeline would, then resolve. */
function resolveWith(lines: object[]) {
  mocked.mockImplementation(async (_cfg, opts) => {
    fs.writeFileSync(opts.outFile!, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    return { runId: opts.runId!, file: opts.outFile! };
  });
}

async function waitForTerminal(id: string): Promise<{ status: string; error?: string }> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const rec = manager.list({ includePrivate: true }).find((r) => r.id === id);
    if (rec && rec.status !== "running") return rec;
    if (Date.now() > deadline) throw new Error("run did not finish");
    await new Promise((r) => setTimeout(r, 50));
  }
}

const started = { event: { type: "run.started", mode: "mock", label: "t" } };
const interview = { event: { type: "interview.completed", interview: { agentId: "ag_0" } } };
const reportDone = { event: { type: "stage", stage: "report", status: "done" } };

describe("RunManager terminal status truth", () => {
  it("marks a run error when the pipeline rejects", async () => {
    mocked.mockRejectedValue(new Error("boom"));
    const rec = await manager.start(brief, "t", "127.0.0.1");
    const done = await waitForTerminal(rec.id);
    expect(done.status).toBe("error");
    expect(done.error).toMatch(/boom/);
    // The sidecar on disk agrees (this is what a restart will read).
    const meta = JSON.parse(fs.readFileSync(path.join(runsDir, `${rec.id}.meta.json`), "utf8")) as { status?: string };
    expect(meta.status).toBe("error");
  });

  it("marks a run error when the promise resolves but the terminal event says error", async () => {
    // Regression for run_2026-11-16_d16ade: the pipeline resolved after a
    // failed run and the manifest published status ok.
    resolveWith([started, { event: { type: "run.completed", status: "error", usage: {} } }]);
    const rec = await manager.start(brief, "t", "127.0.0.1");
    expect((await waitForTerminal(rec.id)).status).toBe("error");
  });

  it("marks a run error when terminal ok but required artifacts are missing", async () => {
    resolveWith([started, { event: { type: "run.completed", status: "ok", usage: {} } }]);
    const rec = await manager.start(brief, "t", "127.0.0.1");
    const done = await waitForTerminal(rec.id);
    expect(done.status).toBe("error");
    expect(done.error).toMatch(/missing required artifacts/);
  });

  it("marks a run ok only with terminal ok plus interview and report artifacts", async () => {
    resolveWith([started, interview, reportDone, { event: { type: "run.completed", status: "ok", usage: {} } }]);
    const rec = await manager.start(brief, "t", "127.0.0.1");
    expect((await waitForTerminal(rec.id)).status).toBe("ok");
  });

  it("manifest rebuilt from disk trusts the terminal event over the sidecar", async () => {
    // A sidecar that says ok over a failed run's log must not survive a restart.
    const id = "run_2026-11-16_d16ade";
    // A concurrent sibling's log line AFTER the terminal event (the real
    // d16ade file ends exactly like this) must not hide it.
    fs.writeFileSync(
      path.join(runsDir, `${id}.jsonl`),
      [started, { event: { type: "run.completed", status: "error", usage: {} } }, { event: { type: "log", level: "warn", message: "late sibling" } }]
        .map((l) => JSON.stringify(l))
        .join("\n") + "\n",
    );
    fs.writeFileSync(path.join(runsDir, `${id}.meta.json`), JSON.stringify({ label: "t", createdAt: "2026-11-16T01:18:00Z", status: "ok" }));
    const rebuilt = new RunManager(loadConfig({ mode: "mock" }), runsDir, {
      model: "mock",
      perRunCapUsd: 1,
      maxRunsPerIpPerDay: 5,
      maxRunsPerDay: 10,
    });
    expect(rebuilt.list({ includePrivate: true }).find((r) => r.id === id)?.status).toBe("error");
  });
});
