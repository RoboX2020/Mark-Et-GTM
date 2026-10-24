# Progress log

Kept current with each commit, so work can resume from any point.

## Milestones

- [x] M0: repo scaffold, architecture, API key guide
- [x] M1: `packages/core`: event schema, fold reducer, Bass fit, finance maths, RNG, metrics
- [x] M2: engine: connectors (cached), LLM router (Claude, Gemini, Runpod, mock), pipeline stages
- [x] M3: engine: sinks (JSONL, SpacetimeDB), CLI, recorded demo runs
- [x] M4: SpacetimeDB Rust module (`cargo check` clean against spacetimedb 2.13)
- [x] M5: portal: design system, live rail, eight tabs, replay player, light/dark
- [x] M6: backtesting (anonymised product backtest + prediction-market Brier backtest)
- [x] M7: Fetch.ai uAgents bridge (verified: 80 agents, real agent-to-agent delivery)
- [x] CI: typecheck, unit + integration tests, portal build, cargo check, bridge compile

## What is verified vs. not

| Area | Status |
|---|---|
| Full pipeline in mock mode | Verified. Integration tests cover stage completion, determinism, provenance ids and backtest leakage |
| Portal replay of recorded runs | Verified in Chromium, all tabs, light and dark |
| Fetch.ai bridge | Verified locally with uAgents 0.26.1 |
| SpacetimeDB module | Compiles. Not yet published (CLI install blocked in the dev sandbox) |
| Portal live mode (SpacetimeDB) | Written against SDK 2.13 types. Needs `spacetime generate` bindings and a running server to verify |
| Claude, Gemini and Runpod calls | Written against the current SDKs and typechecked. Not called yet (no keys) |
| Bright Data, Apify, Kalshi, Polymarket | Written against the documented APIs. Hosts blocked in the sandbox. Each fetch is cached, so a first live run seeds `data/cache/live` |
| Backtest case | `data/backtests/illustrative-notes-app.json` is fictional and labelled so. A real case needs real observed adoption data |

## Next steps

1. Add keys (see `docs/API_KEYS.md`) and run `pnpm --filter @market/engine run simulate -- --mode live`.
   Check connector field mappings against real responses in `data/cache/live/`.
2. Publish the SpacetimeDB module, generate bindings, and run the portal with `VITE_STREAM_SOURCE=spacetime`.
3. Build 3–5 real backtest cases (products with public launch dates and adoption proxies such as
   app-store rank or download estimates and public MRR), then calibrate `resolve()` in `apps/engine/src/stages/simulate.ts`.
4. Swap the illustrative prediction-market cases for resolved Kalshi/Polymarket markets
   (`kalshiSignals`/`polymarketSignals` with a cutoff already return historical prices and outcomes).
5. Optional: a brief-entry form in the portal that starts an engine run through a small HTTP endpoint.

## Calibration notes

- Adoption decisions blend the model's stated intent (`intent^1.3`) with a Bass-style hazard
  (innovation `0.02 + 0.1·innovativeness`, imitation `0.09·susceptibility` per adopted tie),
  gated by price fit `σ((wtp − price) / 0.25·price)`. Tune these against real backtests.
- The Bass fit puts a weak prior on `m` (adopted + 0.45·considering + 0.08·unreached).
  Six simulated months identify `m` poorly, so the finance layer flags the tail as extrapolated.
