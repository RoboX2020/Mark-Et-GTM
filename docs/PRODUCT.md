# Mark8 product server (apps/server)

The hackathon engine as a real product: a founder enters a company name and an idea,
the server runs the engine, a population of AI-generated synthetic customers reacts over
six rounds and sits for interviews, and the portal shows the run live and the final report.
**Every result is simulated - not real customer validation, not a sales forecast.**

## Modes
- `MARKET_MODE=mock` (default): deterministic offline agents, no keys, no spend. Safe for
  public replay and development.
- `MARKET_MODE=live`: real model calls through Anthropic only (standing decision: no Google
  API; the swarm mix is forced to Claude). Refuses to boot without `ANTHROPIC_API_KEY` (or
  `CLAUDE_KEY_FILE`) AND `MARK8_BUDGET_USD`. Model: `claude-haiku-5-5` - the only model with
  a verified price in `apps/server/src/budget.ts` ($0.10/MTok in, $0.50/MTok out, <=100k-token
  prompts, rechecked Nov 15 2026). Any other model is refused.

## Spend safeguards (app-side, independent of billing state)
Ported from the validated V11 offline pipeline:
- before every request a conservative cost bound (serialized bytes + framing margin + full
  max_tokens, at list price) is reserved against `MARK8_BUDGET_USD`; the call is refused if
  the reservation would pass the cap;
- after the response the reservation settles to documented usage; unknown outcomes (network
  errors, 429/5xx, missing usage) keep the full reservation, so unresolved calls can never
  walk spend past the cap;
- per-call requests over 60 KB are refused (stays below the 100k-token higher price tier);
- committed spend persists in a durable store chosen by `MARK8_LEDGER_BACKEND`:
  - `file` (default): `MARK8_SPEND_LEDGER`, single-process JSON with atomic writes. NOT
    durable on hosts with ephemeral disks (free-tier spin-downs wipe it).
  - `github`: a JSON record in a PRIVATE GitHub repo (`MARK8_LEDGER_REPO`,
    `MARK8_LEDGER_PATH`, token in `MARK8_LEDGER_TOKEN`, repo scope). The repo is verified
    private at boot or live mode refuses to run. Reservations and settles are atomic
    check-and-add conditional writes (SHA conflict => re-read, re-decide, retry), so
    overlapping deployments can never both spend the same dollars. A store that stops
    being writable latches unhealthy and new billable runs are refused (fail closed);
- pre-flight: every run's worst-case cost is estimated from the brief and refused when it
  would pass the per-run cap (`MARK8_PER_RUN_CAP_USD`, default $1) or the remaining budget.

## Visitor protections
Billable runs are OPERATOR-ONLY: in live mode `POST /api/runs` needs the
`x-operator-token` header (`MARK8_OPERATOR_TOKEN`, timing-safe compare; live mode refuses
to boot without it). Visitors replay finished runs only. One run at a time; per-IP daily
cap (`MARK8_MAX_RUNS_PER_IP_PER_DAY`, default 3); global daily cap
(`MARK8_MAX_RUNS_PER_DAY`, default 20); input field limits (idea 800 chars, name 120,
population 40-300). API keys live only server-side; the browser talks to this server,
never to a model provider.

## Run privacy and retention
Runs are PRIVATE BY DEFAULT. Only runs the operator explicitly marks `showcase: true`
(reserved for clearly fictional examples) appear in the public `/api/runs/index.json` and
serve their event log; everything else needs the operator token (a run without readable
metadata is treated as private - privacy fails closed). The four built-in fixtures under
`data/runs/` carry committed `*.meta.json` sidecars with `showcase: true`.
Finished runs are archived to the durable store (`runs/<id>.jsonl` + `.meta.json` next to
the ledger on the GitHub backend). At boot the server rebuilds its manifest from disk,
restores any runs the disk lost (spin-down/redeploy) from the store, and re-archives
anything the store is missing.

## API
- `POST /api/runs` `{name?, idea, category?, price?, market?, competitors?, population?, showcase?}`
  -> `201 {run}` / `400` invalid / `403` not the operator (live) / `429` refused (limits or budget).
  `showcase: true` (operator only) makes the finished run publicly replayable.
- `GET /api/runs/index.json` - public: showcase runs only. With `x-operator-token`: all runs.
- `GET /api/runs/<file>.jsonl` - showcase runs are public; any other run 404s without the
  operator token (indistinguishable from not existing).
- `GET /api/health` - mode, model, budget state, ledger backend/health, labeling
- `PORTAL_DIST` set -> the built portal is served with SPA fallback

## Run
    pnpm --filter @market/portal build
    MARKET_MODE=mock PORTAL_DIST=apps/portal/dist pnpm --filter @market/server start

## Live test (only with the owner's approved budget)
    MARKET_MODE=live CLAUDE_KEY_FILE=~/.mark8-key MARK8_BUDGET_USD=5 MARK8_PER_RUN_CAP_USD=1 \
      MARK8_OPERATOR_TOKEN=... PORTAL_DIST=apps/portal/dist pnpm --filter @market/server start

## Deploy (Render, free)
`render.yaml` is the blueprint: one free Node web service, `MARK8_LEDGER_BACKEND=github`
against the private `RoboX2020/mark8-ledger` repo, `MARK8_BUDGET_USD=5` as a LIFETIME cap
(the durable ledger counts cumulative committed spend, never per-month). Secrets are
entered at blueprint apply time and never touch the repo: `ANTHROPIC_API_KEY`,
`MARK8_OPERATOR_TOKEN`, `MARK8_LEDGER_TOKEN`. Free-tier spin-downs wipe the local disk;
the GitHub store is what makes the ledger and run history survive them.
