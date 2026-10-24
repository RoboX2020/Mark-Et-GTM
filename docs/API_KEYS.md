# API keys and credentials

Every credential is optional. Whatever is missing falls back to the cached data
in `data/cache/` or to the deterministic mock provider, so the demo and replays
always work offline. Put the values in `.env` (template: `.env.example`).

## Required for a full live run

| Service | Env vars | What it powers | Where to get it |
|---|---|---|---|
| **Anthropic (Claude)** | `ANTHROPIC_API_KEY` | Knowledge-graph extraction, agent interviews, final report, finance narrative, backtest scoring commentary | console.anthropic.com → API Keys |
| **Bright Data** | `BRIGHTDATA_API_TOKEN`, `BRIGHTDATA_SERP_ZONE`, `BRIGHTDATA_DATASET_REDDIT`, `BRIGHTDATA_DATASET_X`, `BRIGHTDATA_DATASET_TIKTOK` | News via the SERP API, plus Reddit, X and TikTok posts via Web Scraper API datasets | brightdata.com → Account settings → API token. Create a SERP API zone and note its name. Copy the dataset IDs (`gd_…`) from the Web Scraper library |
| **Apify** | `APIFY_TOKEN` (+ optional `APIFY_ACTOR_*` overrides) | Product Hunt launches/comments, App Store and Play Store reviews, and Reddit/X/TikTok fallbacks | console.apify.com → Settings → Integrations → API token. Pick actors in the Store and set their IDs (`owner~name`) |
| **Google Gemini** | `GEMINI_API_KEY`, `GEMINI_MODEL` | Half of the agent swarm (reactions, social messages, per-round decisions) | aistudio.google.com → Get API key |
| **Runpod** | `RUNPOD_API_KEY`, `RUNPOD_ENDPOINT_ID`, `RUNPOD_MODEL` | The other half of the swarm, on an open-weights model served by vLLM Serverless (OpenAI-compatible route) | runpod.io → Settings → API Keys. Deploy a Serverless vLLM endpoint (e.g. Qwen3-8B or Llama-3.1-8B) and copy its endpoint ID |

## No key needed (public data)

| Service | Env vars | Notes |
|---|---|---|
| **Kalshi** | `KALSHI_API_BASE` | Market listings, prices and candlestick history are public. `KALSHI_API_KEY_ID` and `KALSHI_PRIVATE_KEY_PATH` are only needed for trading endpoints, which this app never calls |
| **Polymarket** | `POLYMARKET_GAMMA_BASE`, `POLYMARKET_CLOB_BASE` | The Gamma API (markets/events) and CLOB `prices-history` are public |

## Optional

| Service | Env vars | What it adds |
|---|---|---|
| **Listen Labs** | `LISTENLABS_API_KEY`, `LISTENLABS_STUDY_ID` | Pulls real interview transcripts to anchor the synthetic customers. Without API access, export transcripts and drop them in `data/anchors/*.json` (format in `data/anchors/README.md`) |
| **Fetch.ai Agentverse** | `FETCH_ENABLED`, `FETCH_BRIDGE_URL`, `AGENTVERSE_API_KEY` | Runs swarm agents as real uAgents that message each other. Local uAgents need no key; the Agentverse key is only for registering agents/mailboxes on the hosted network |
| **SpacetimeDB** | `SPACETIMEDB_URI`, `SPACETIMEDB_DB_NAME`, `SPACETIMEDB_TOKEN` | A local server (`spacetime start`) needs no token. `SPACETIMEDB_TOKEN` is only for publishing to Maincloud or another remote server (`spacetime login`) |

## Cost controls

- `SWARM_MIX` splits agents across backends, e.g. `runpod:0.7,gemini:0.3`.
  Backends with no key are dropped automatically.
- Each live ingestion response is cached under `data/cache/live/`, keyed by
  query and cutoff date, so a run is only fetched once and can be replayed for free.
- Claude is only called for graph extraction, interviews (batched per agent),
  the report and the finance narrative. Per-round swarm decisions never use it.
