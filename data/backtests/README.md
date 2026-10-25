# Backtest cases

Each case pairs a launch brief with what actually happened. The engine sees
only data from before `launchDate`, with `realName` and every `aliasTerms`
entry replaced by `alias`. The scorer then compares the prediction with
`actual`.

| Case | Real or illustrative | Outcome data |
|---|---|---|
| `humane-ai-pin` | **Real.** Humane Ai Pin, which shipped 2024-04-11 | About 10,000 lifetime sales against a 100,000 goal. Returns outpaced sales May–Aug 2024. Shut down Feb 2025 (sources in the file) |
| `meta-rayban` | **Real.** Ray-Ban Meta glasses, shipping 2023-10-17 | More than 1 million units in 2024 and more than 2 million cumulative by February 2025 (sources in the file) |
| `rabbit-r1` | **Real.** Rabbit R1, shipping 2024-04-24 | About 130,000 sold by June 2024, then flat, with roughly 5,000 concurrent users by September (sources in the file) |
| `illustrative-notes-app` | Fictional, for exercising the pipeline | Made up; labelled ILLUSTRATIVE |

Run one:

```bash
pnpm --filter @market/engine run backtest -- humane-ai-pin --mode live
```

A real backtest needs live Bright Data access, so the pre-launch posts come
from the web as it was before the cutoff. Without it the engine falls back to
generic fixture posts and the score means nothing.

## Adding a case

Pick a launch with a public date and public outcome numbers. Good adoption
proxies: units sold, app-store download estimates, public MRR or user
counts. Express adoption as a share of an addressable market you state in
the brief, and cite every number in `actual.source`.
