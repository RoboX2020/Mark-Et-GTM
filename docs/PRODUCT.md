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
- committed spend persists in `MARK8_SPEND_LEDGER` (single-process JSON, atomic writes; NOT
  a multi-host store - one server process must own it);
- pre-flight: every run's worst-case cost is estimated from the brief and refused when it
  would pass the per-run cap (`MARK8_PER_RUN_CAP_USD`, default $1) or the remaining budget.

## Visitor protections
One run at a time; per-IP daily cap (`MARK8_MAX_RUNS_PER_IP_PER_DAY`, default 3); global
daily cap (`MARK8_MAX_RUNS_PER_DAY`, default 20); input field limits (idea 800 chars, name
120, population 40-300). API keys live only server-side; the browser talks to this server,
never to a model provider.

## API
- `POST /api/runs` `{name?, idea, category?, price?, market?, competitors?, population?}`
  -> `201 {run}` / `400` invalid / `429` refused (limits or budget)
- `GET /api/runs/index.json` - run manifest in the portal's replay format, with `status`
- `GET /api/runs/<file>.jsonl` - the event log (the portal tails it while `status=running`)
- `GET /api/health` - mode, model, budget state, labeling
- `PORTAL_DIST` set -> the built portal is served with SPA fallback

## Run
    pnpm --filter @market/portal build
    MARKET_MODE=mock PORTAL_DIST=apps/portal/dist pnpm --filter @market/server start

## Live test (only with the owner's approved budget)
    MARKET_MODE=live CLAUDE_KEY_FILE=~/.mark8-key MARK8_BUDGET_USD=5 MARK8_PER_RUN_CAP_USD=1 \
      PORTAL_DIST=apps/portal/dist pnpm --filter @market/server start
