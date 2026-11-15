import fs from "node:fs";
import path from "node:path";

/**
 * Persists committed spend across restarts. Single-process JSON file with atomic
 * writes (write tmp, rename). Same documented limit as the V11 FileStore: this is
 * NOT a multi-host shared store - one server process owns the file. On a multi-machine
 * or serverless deployment an external shared store is required, or the cap is void.
 */
export class SpendLedger {
  constructor(private file: string) {}

  load(): number {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as { totalCommittedUsd?: unknown };
      const n = Number(raw.totalCommittedUsd);
      return Number.isFinite(n) && n >= 0 ? n : 0;
    } catch {
      return 0; // missing or unreadable ledger starts at zero committed
    }
  }

  save(committedUsd: number): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ totalCommittedUsd: committedUsd, updatedAt: new Date().toISOString() }));
    fs.renameSync(tmp, this.file);
  }
}
