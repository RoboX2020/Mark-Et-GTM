# Progress log

Kept current with each commit, so work can resume from any point.

## Milestones

- [x] M0: repo scaffold, architecture, API key guide
- [x] M1: `packages/core`: event schema, fold reducer, Bass fit, finance maths, RNG
- [ ] M2: engine: connectors (cached), LLM router (Claude, Gemini, Runpod, mock), pipeline stages
- [ ] M3: engine: sinks (JSONL, SpacetimeDB), CLI, demo run recorded
- [ ] M4: SpacetimeDB Rust module
- [ ] M5: portal: design system, live rail, tabs, replay
- [ ] M6: backtesting (product + prediction markets)
- [ ] M7: Fetch.ai uAgents bridge

## Notes

- The dev container has no network access to Apify, Kalshi, Polymarket or the
  SpacetimeDB installer. Live connectors are written against the documented
  APIs but are unverified here. Mock mode and cached runs are verified.
