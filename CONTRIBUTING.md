# Contributing to Routecast

## Updating pricing (the most valuable PR you can send)

LLM pricing moves at multi-week cadence. The entire matrix lives in one file:

```
packages/pricing/data/models.json
```

To update or add a model:

1. Edit the JSON — no code changes needed. Each entry needs:
   - `key` (`<provider>/<slug>`), `displayName`, `aliases` (glob patterns matched against raw log ids)
   - `tiers`: price tiers sorted ascending; the **last tier must have `upToContextTokens: null`**. Threshold semantics: the tier containing the total prompt size prices the whole request (this is how Gemini's 200K and GPT-5.5's 272K cliffs actually bill).
   - `cache`: `readMultiplier` (0.1 = 90% off), optional `writeMultiplier`, `minCacheableTokens`
   - `reasoningBilledAs`, optional `batchDiscount`, `intelligenceIndex`, `workloadFitness` (0–3 per workload)
   - `pricingConfidence`: `"confirmed"` only if you verified against provider docs — link the source in `notes`. Otherwise `"estimated"` (estimated prices are visibly flagged in every report).
2. Bump `asOf` and `version` if you re-verified the whole snapshot; leave them if you're patching one model.
3. Run `pnpm test` — the schema and invariants (sorted tiers, unbounded last tier, unique keys) are enforced by CI, so a JSON-only PR that's green is safe to merge.

## Development

```bash
pnpm install
pnpm build        # tsdown, all packages (topological)
pnpm test         # vitest
pnpm typecheck    # tsc --noEmit
pnpm lint:fix     # biome
```

Try your changes against real data: `node packages/cli/dist/index.js analyze --verbose`.

## Principles

- **Analyzer, not gateway.** Routecast never sits in the request path.
- **Show the math.** Every finding's `detail` must contain the formula behind any dollar claim.
- **Never fake precision.** Estimates carry `confidence` and are labeled (estimated reasoning tokens, heuristic workload classification, assumed cacheable share). Unknown models are an explicit warning, never silently $0.
- **Skip, don't crash.** Ingest adapters must tolerate malformed lines and report skip counts.
