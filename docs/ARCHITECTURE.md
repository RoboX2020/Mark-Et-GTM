# Architecture

```
 founder brief ──► ┌──────────────────────────── engine (Node/TS) ─────────────────────────────┐
                   │ 1 ingest      Bright Data · Apify · Kalshi · Polymarket · Listen Labs     │
                   │               (cutoff-filtered, anonymised, cached)                       │
                   │ 2 graph       Claude → segments, pains, competitors, trends, prices,      │
                   │               conditions + weighted edges, each with evidence ids         │
                   │ 3 population  100–1,000 personas sampled from graph segment weights,      │
                   │               anchored to Listen Labs interviews (aggregate only)          │
                   │ 4 network     small-world social graph (Watts–Strogatz, segment homophily) │
                   │ 5 rounds      swarm: Runpod open model + Gemini (+ Fetch.ai messaging)    │
                   │ 6 interviews  Claude, a stratified sample of agents                        │
                   │ 7 bass fit    p, q, m fitted to simulated cumulative adoption              │
                   │ 8 finance     12-mo revenue, CAC by channel, break-even, cash; provenance  │
                   │ 9 report      Claude, every claim cites agents + evidence                  │
                   └────────────────────────────────┬──────────────────────────────────────────┘
                                                    │  every step = one typed event
                         ┌──────────────────────────┼─────────────────────────┐
                         ▼                          ▼                         ▼
                 SpacetimeDB reducers        JSONL event log            stdout (CLI)
                 (live rows)                 data/runs/<run>.jsonl
                         │                          │
                         └──────────► portal ◄──────┘  (live subscription or replay at any speed)
```

## Principles

- **One event stream is the source of truth.** The engine never writes UI state
  directly. It emits typed `MarketEvent`s (`packages/core/src/events.ts`). Sinks
  fan them out to SpacetimeDB (one reducer, `append_event`, which also
  materialises typed tables) and to an append-only JSONL log. The portal folds
  the same events into view state with a pure reducer
  (`packages/core/src/fold.ts`), so a live run and a replay render identically.
- **Offline first.** Connectors read through a content-addressed cache. In
  `MARKET_MODE=mock` every model call goes to a seeded deterministic provider, so
  the whole pipeline runs with no keys and no network.
- **No real individuals.** Ingested posts are reduced to aggregate patterns
  (pain frequency, sentiment by segment, price mentions) before personas are
  built. Author handles are dropped at ingestion. Personas are sampled from
  segment-level distributions and are never modelled on any one person.
- **Provenance everywhere.** Graph nodes carry `evidenceIds`. Agent decisions
  carry the graph nodes they were shown. Finance line items carry the agent ids
  and evidence ids behind them, a confidence score, and `needsReview` when the
  confidence is below a threshold.
- **Model diversity.** The swarm is split across backends (`SWARM_MIX`). The
  report shows adoption broken down by backend, so model bias is visible
  instead of hidden.

## Backtesting

`engine backtest <case>` loads a case from `data/backtests/<case>.json`. A case
holds the real product, its launch date, an alias, and observed outcomes.

1. Every connector is called with `cutoff = launchDate - 1 day` and drops any
   item dated after it.
2. The product name, its domain and its known aliases are replaced with the
   alias everywhere: brief, posts, and prompts. Claude is instructed to say if
   it recognises the product, and that flag is logged as a leakage warning.
3. The simulation runs normally. Its prediction is compared against the
   observed outcomes: adoption curve (MAPE), Bass parameters, top objections
   (overlap), and price verdict. Misses are listed explicitly.

Stretch goal: `engine backtest-markets` runs the swarm on resolved Kalshi and
Polymarket questions using only pre-cutoff data. It scores the swarm's
probability against the historical market price at the cutoff and against the
real outcome, using the Brier score and log loss.

## Packages

| Path | Role |
|---|---|
| `packages/core` | Shared types, event schema, the fold reducer, Bass diffusion fit, finance maths, seeded RNG |
| `apps/engine` | Orchestrator CLI: connectors, LLM router, pipeline stages, sinks, backtests |
| `apps/portal` | React + Vite research instrument: live rail, graph, agents, interviews, finance, backtest |
| `spacetime` | SpacetimeDB Rust module: the event table plus typed tables materialised by reducers |
| `agents/fetch` | Python uAgents bridge. Each persona becomes an agent and peers exchange messages |
| `data/` | Cached ingestion, backtest cases, recorded runs for offline demo |
