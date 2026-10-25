# Mark-Et GTM: launch simulator

Predict how a product launch will land before it happens.

A founder enters a product, price, target market, competitors, channels and
launch date. The engine builds a live picture of the market the product is
about to enter:

- what people are saying now on Reddit, X, TikTok, Product Hunt, app stores
  and in the news (via Bright Data and Apify)
- real-money odds on the conditions around the launch (Kalshi, Polymarket)

It connects all of this into a knowledge graph, then grows a population of
100–1,000 synthetic customers grounded in aggregate patterns from that graph.
They see the launch, react, influence each other over a social network for
several rounds, and then sit for interviews.

The output is a report a founder can act on:

- a Bass-diffusion adoption curve
- which segments to target first
- objections and how to answer them
- a price verdict
- which channels and messages to lead with
- a 12-month finance forecast, where every number links back to the agents and
  evidence behind it

**Backtesting** is the most important feature. Point the engine at a product
that already launched, restrict it to pre-launch data, anonymise the product,
and compare its prediction with what actually happened, misses included.

Every step streams through SpacetimeDB into the portal and is recorded as an
event log. Any run can be replayed at adjustable speed, fully offline.

**Live demo:** https://mark8.prajvalarora.com (replays
recorded runs, including a full run on real Claude and Gemini models).

## Quick start (offline, no keys)

```bash
pnpm install
pnpm dev                     # portal at http://localhost:5173, replays the recorded runs
pnpm demo                    # re-runs the full pipeline in mock mode → data/runs/demo.jsonl
pnpm backtest                # illustrative product backtest (anonymised, pre-cutoff only)
pnpm --filter @market/engine backtest-markets   # swarm vs. resolved prediction markets
pnpm test                    # unit + integration tests
```

Recorded runs live in `apps/portal/public/runs/`, so the portal works fully
offline. In the top bar you can pick a run, play it at 1× to 200×, scrub, or
open any `.jsonl` event log.

## Live run

```bash
cp .env.example .env   # fill in keys: see docs/API_KEYS.md
pnpm --filter @market/engine run simulate -- --mode live --brief data/briefs/example.json --population 500
```

Engine flags: `--mode live|cache|mock`, `--population n`, `--rounds n`,
`--spacetime` (stream into SpacetimeDB), `--id`, `--label`, and `--no-publish`
(don't copy the run into the portal).

Fetch.ai agents: start `agents/fetch/bridge.py` (see its README) and set
`FETCH_ENABLED=true`.

With SpacetimeDB:

```bash
cd spacetime && spacetime start &   # local server
spacetime publish market-sim
spacetime generate --lang typescript --out-dir ../apps/portal/src/stdb/module_bindings
VITE_STREAM_SOURCE=spacetime pnpm dev
```

## Market World

The **Market World** button in the top bar (or `?world=1` in the URL) opens a
full-screen 3D voxel town that replays a run: one neighbourhood per segment,
one resident per agent, and a central tower for the product. Enter a product
name, price and description, then launch. You can watch icons, comments and
word-of-mouth arcs spread round by round, click a resident or a neighbourhood
for details, change the playback speed, compare two products side by side, and
jump to the full report when the run ends.

Each town plays the best run available:

1. a real engine run, when a local engine is connected (below);
2. a recorded run whose product name matches (Humane, Ray-Ban Meta, Rabbit, Tandem);
3. a scripted demo run built in the browser (seeded diffusion, no models, labelled as a demo).

If an engine run fails partway, the town switches to the next option, so the demo always plays.
The HUD badge always shows which source is playing.

To run any product for real, start the local bridge and paste its URL into the
launch panel's engine field:

```bash
pnpm --filter @market/engine serve   # http://127.0.0.1:8787, uses MARKET_MODE from .env
ENGINE_SERVE_MODE=mock pnpm --filter @market/engine serve   # same, without model calls
```

The bridge only listens on 127.0.0.1 and spends your own API credits. Don't
expose it publicly. The hosted static site has no engine, so it plays recorded
and scripted runs unless you connect a local bridge.

## Docs

- [Architecture](docs/ARCHITECTURE.md)
- [API keys](docs/API_KEYS.md)
- [Progress log](docs/PROGRESS.md): what is built, what is verified, what is next
- [SpacetimeDB module](spacetime/README.md)
- [Fetch.ai bridge](agents/fetch/README.md)
- [Anchor interviews format](data/anchors/README.md)
