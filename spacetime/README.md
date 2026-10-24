# SpacetimeDB module

The real-time backbone. The engine calls one reducer per pipeline step:

```
append_event(run_id: String, seq: u64, ts: i64, kind: String, payload: String)
```

`payload` is the JSON-encoded `MarketEvent` (see `packages/core/src/events.ts`).
The reducer stores it in `run_event`, the replayable log, and materialises
typed public tables:

`run`, `stage`, `evidence`, `graph_node`, `graph_edge`, `agent`,
`agent_decision`, `agent_message`, `interview`, `report_section`, `metric`

## Run locally

```bash
curl -sSf https://install.spacetimedb.com | sh   # installs the `spacetime` CLI
spacetime start                                  # local server on :3000
spacetime publish market-sim                     # from this folder
spacetime generate --lang typescript --out-dir ../apps/portal/src/stdb/module_bindings
```

Then run the engine with `--spacetime` (or `SPACETIMEDB_ENABLED=true`), and the
portal with `VITE_STREAM_SOURCE=spacetime`.
