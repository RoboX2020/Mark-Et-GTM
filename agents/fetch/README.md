# Fetch.ai agent bridge

Runs every synthetic customer as a [uAgent](https://fetch.ai/docs) so
word-of-mouth between agents goes over the uAgents protocol instead of being
handed over in memory.

```bash
cd agents/fetch
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python bridge.py            # http://127.0.0.1:8100
FETCH_ENABLED=true pnpm --filter @market/engine run simulate -- --mode mock
```

How a round works:

1. The engine `POST /register`s the population and its social ties once per
   run. Each persona becomes an `Agent`, run together in a local `Bureau`.
2. After each round the engine `POST /relay`s that round's word-of-mouth
   messages. A coordinator agent sends `Speak` to each speaker. The speaker
   sends `WordOfMouth` to its friend's agent address, but only along an
   existing social tie.
3. The receiving agent's handler records the message. Only messages actually
   handled count as delivered, and the engine feeds those into the next round.
   In the portal they show a `fetch.ai` badge.

If the bridge is unreachable, the engine logs a warning and falls back to local
delivery, so runs never fail because of it.

Notes:

- Agents run without endpoints, so nothing is registered on the Almanac and no
  testnet funds are needed. Agentverse mailboxes (`AGENTVERSE_API_KEY`) are
  only needed to expose the agents publicly.
- On startup uAgents probes the Fetch.ai ledger. Without network access to it
  (as in the dev sandbox), agent startup takes about 30 s, so `/register`
  waits on a readiness probe.
- Agents persist across runs (re-registering reuses them). Restart the bridge
  to free memory after very large populations.
