import fs from "node:fs";
import path from "node:path";

/**
 * Committed-spend persistence. The budget cap is void if the ledger can silently
 * lose writes, so every backend follows two rules:
 * - survive restarts (durable store, atomic replace of the single record);
 * - fail closed: a store that cannot be read or written refuses live runs
 *   instead of resetting spend to zero.
 */
export interface SpendStore {
  /** Total committed USD as of the last durable write. Throws when unreadable. */
  load(): Promise<number>;
  /** Durably record the new committed total. */
  save(committedUsd: number): Promise<void>;
  /** False after any save failure: the run manager must refuse new billable runs. */
  healthy(): boolean;
}

/** Single-process JSON file with atomic writes (write tmp, rename). Durable on a
 *  persistent disk only - on hosts with ephemeral filesystems (free tiers that
 *  wipe on spin-down) use a durable remote backend instead. */
export class FileSpendStore implements SpendStore {
  private failed = false;

  constructor(private file: string) {}

  async load(): Promise<number> {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0; // genuine first boot on this disk
      throw new Error(`ledger unreadable at ${this.file}: refusing to run live`); // fail closed
    }
    try {
      const n = Number((JSON.parse(raw) as { totalCommittedUsd?: unknown }).totalCommittedUsd);
      if (!Number.isFinite(n) || n < 0) throw new Error("not a number");
      return n;
    } catch {
      // A corrupt ledger is NOT a fresh ledger: never reset spend to zero silently.
      throw new Error(`ledger corrupt at ${this.file}: refusing to run live`);
    }
  }

  async save(committedUsd: number): Promise<void> {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ totalCommittedUsd: committedUsd, updatedAt: new Date().toISOString() }));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      this.failed = true;
      throw err;
    }
  }

  healthy(): boolean {
    return this.failed === false;
  }
}

/**
 * Durable store on a private GitHub repo file (contents API). One JSON record;
 * each PUT atomically replaces it. Exists so free-tier hosts with ephemeral
 * disks still get a ledger that survives restarts, using an account the
 * operator already has - no extra paid service. The PAT needs repo scope and
 * stays server-side only.
 */
export class GitHubSpendStore implements SpendStore {
  private failed = false;
  private sha: string | undefined;
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private repo: string, // "owner/repo" - must be PRIVATE
    private filePath: string, // e.g. "spend.json"
    private token: string,
  ) {}

  private api(path: string, init?: RequestInit): Promise<Response> {
    return fetch(`https://api.github.com/repos/${this.repo}/contents/${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        ...(init?.headers ?? {}),
      },
    });
  }

  async load(): Promise<number> {
    const res = await this.api(this.filePath);
    if (res.status === 404) {
      // Genuine first boot: create the record at zero. A later 404 can only come
      // from someone deleting the ledger in the private repo - an operator act.
      await this.put(0, undefined);
      return 0;
    }
    if (!res.ok) throw new Error(`ledger read failed: GitHub ${res.status} - refusing to run live`);
    const body = (await res.json()) as { sha: string; content: string };
    this.sha = body.sha;
    let n: number;
    try {
      n = Number((JSON.parse(Buffer.from(body.content, "base64").toString("utf8")) as { totalCommittedUsd?: unknown }).totalCommittedUsd);
      if (!Number.isFinite(n) || n < 0) throw new Error("not a number");
    } catch {
      throw new Error("ledger record corrupt in GitHub store - refusing to run live");
    }
    return n;
  }

  private async put(committedUsd: number, sha: string | undefined): Promise<void> {
    const res = await this.api(this.filePath, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: "mark8 spend ledger",
        content: Buffer.from(JSON.stringify({ totalCommittedUsd: committedUsd, updatedAt: new Date().toISOString() })).toString("base64"),
        ...(sha ? { sha } : {}),
      }),
    });
    if (!res.ok) throw new Error(`ledger write failed: GitHub ${res.status}`);
    const body = (await res.json()) as { content?: { sha?: string } };
    this.sha = body.content?.sha ?? this.sha;
  }

  /** Saves are serialized; a failure latches unhealthy so new billable runs refuse. */
  async save(committedUsd: number): Promise<void> {
    this.tail = this.tail.then(() => this.put(committedUsd, this.sha)).catch((err) => {
      this.failed = true;
      console.error(`ledger save failed (failing closed): ${(err as Error).message}`);
    });
    return this.tail;
  }

  healthy(): boolean {
    return this.failed === false;
  }
}

/** Pick the durable backend from env. Live mode must never boot without one that loads. */
export async function spendStoreFromEnv(env: (k: string, d?: string) => string, defaultFile: string): Promise<{ store: SpendStore; restored: number; backend: string }> {
  const backend = env("MARK8_LEDGER_BACKEND", "file");
  if (backend === "github") {
    const repo = env("MARK8_LEDGER_REPO"); // e.g. "RoboX2020/mark8-ledger" - must be private
    const token = env("MARK8_LEDGER_TOKEN");
    if (!repo || !token) throw new Error("MARK8_LEDGER_BACKEND=github needs MARK8_LEDGER_REPO and MARK8_LEDGER_TOKEN");
    const store = new GitHubSpendStore(repo, env("MARK8_LEDGER_PATH", "spend.json"), token);
    const restored = await store.load(); // throws = fail closed
    return { store, restored, backend };
  }
  const store = new FileSpendStore(env("MARK8_SPEND_LEDGER", defaultFile));
  const restored = await store.load();
  return { store, restored, backend };
}
