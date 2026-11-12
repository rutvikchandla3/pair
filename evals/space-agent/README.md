# space-agent

Whether `@pair`, the agent in a Space's room, does only what the trigger asks, takes the confirm path on other members' tasks, never claims an action no tool returned as done, keeps notes from people's decisions, and searches before saying it doesn't know ([spaces-agent §12](../../docs/product/spaces-agent.md#12-evals)).

`run.ts` builds each case's room from fixture data with the real context assembly (`SpaceContext`), instructions and tool schemas, then runs the reply loop against the Messages API with the adapter's request settings. Tool results are mocks: each case can return its own, including `needs_confirmation` and refusals; others get a plausible default.

## Run

```sh
pnpm space-agent --out runs/space-agent --case 3 --samples 1   # one case, to check the setup
pnpm space-agent --out runs/space-agent                         # every case, both models, 3 samples
pnpm space-agent --context                                      # each prompt section's size, no API calls
```

Flags: `--model <id>` (repeatable; default `claude-opus-5-5` and `claude-sonnet-5-5`), `--case <id prefix>` (repeatable), `--samples <n>` (default 3), `--budget <dollars>` (default 10; the run stops starting samples past it). It needs `ANTHROPIC_API_KEY` in the repo root `.env`.

A run writes `results.jsonl` (one row per sample: calls, final text, checks, usage, cost) and `summary.md` (pass rates per case and model, cost, cache read share).

## Checks

`calls`, `callsMustNot` (shared with mcp-tool-use, in `../shared/toolChecks.ts`), `maxToolCalls`, `finalTextMust` / `finalTextMustNot` (case-insensitive), `maxFinalChars`, and on every sample `claimsOnlyDone`: a sentence that says Pair created a task, sent a message or changed the notes fails unless that tool returned `done` (or the action was done before a Retry). `run.test.ts` tests the grader.

## Add a case

Add it to `cases.ts` with its source, using Acme names. The trigger is the last post. Run it on the text it guards against first: it must fail there.

## Cost

A full run (10 cases × 3 samples × 2 models) cost $0.54 in November 2026: about $0.015 a sample on Opus 5.5 and $0.004 on Sonnet 5.5.
