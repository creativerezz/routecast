# Routecast architecture

## Pipeline

```
ingest adapters → UsageEvent[] → dedup + window → enrich → analyzers → Report → renderers
```

- **Ingest adapters** (`@routecast/core/src/ingest/`) normalize each source into `UsageEvent`. They are lenient by design: malformed lines are counted and skipped, never fatal.
- **Enrichment** resolves the raw model id against the pricing matrix (`@routecast/pricing`), computes a cost breakdown (cache-aware, tier-aware), and classifies the workload from token shape + session density.
- **Analyzers** each return `Finding[]` with `severity` (critical/warning/recommendation/info), `confidence` (high/medium/low), optional `estimatedMonthlySavingsUsd`, and a `detail` paragraph that always shows the math.
- **Report** is plain JSON — the terminal renderer (CLI), markdown renderer (core), and MCP tools all consume the same model.

## Normalized event schema

```jsonc
{
  "id": "sha256-derived dedup key",
  "ts": "2026-06-09T10:00:00.000Z",
  "provider": "anthropic",
  "model": "claude-sonnet-4-6-20250929",   // raw, exactly as logged
  "tokens": {
    "input": 1200,            // uncached input
    "cacheRead": 45000,
    "cacheWrite": 2000,
    "output": 800,            // visible output
    "reasoning": 350,         // thinking tokens (billed as output)
    "reasoningEstimated": true
  },
  "costUsd": null,            // observed cost if the source reports one
  "status": "ok",
  "feature": "my-project",    // attribution tag
  "session": "uuid",
  "source": "claude-code"
}
```

## Generic JSONL ingest format (bring your own data)

One JSON object per line. Minimum: `ts` (or `timestamp`), `model`, token counts.

```jsonc
{"ts":"2026-06-09T10:00:00Z","provider":"openai","model":"gpt-5.4-mini","input_tokens":1200,"output_tokens":300,"cache_read_tokens":0,"reasoning_tokens":120,"cost_usd":0.0011,"feature":"search","session":"abc"}
```

`routecast ingest jsonl <file>` validates each line with Zod, skips bad lines, and dedups into `~/.routecast/events/events-YYYY-MM.jsonl`.

## Claude Code adapter specifics

- Reads `~/.claude/projects/**/*.jsonl`; only `type: "assistant"` lines with `message.usage` count.
- Multiple lines share one `requestId` (text and tool_use emitted separately) — usage is merged per requestId (max output, summed thinking chars).
- Anthropic reports no reasoning split; reasoning is estimated from thinking-block text at chars/4 and flagged `reasoningEstimated`.
- The log format is undocumented and may drift between versions: the adapter skips what it can't parse and reports skip counts.

## Tier semantics (pricing cliffs)

The tier whose range contains the **total prompt size** (input + cacheRead + cacheWrite) prices **all** tokens in the request. That matches provider behavior for Gemini 3.1 Pro (>200K) and GPT-5.5 (>272K): the whole request is repriced, not the marginal tokens.

## Scale path

v1 stores normalized events as monthly JSONL and aggregates in memory — ~100K events analyze in well under a second. If you outgrow that (multi-tenant, years of history), the intended path is swapping `EventStore` for SQLite/DuckDB behind the same interface; the analyzers are storage-agnostic.

## Forecast methodology

- ≥10 observed days: empirical p50/p90/p99 quantiles of daily burn, projected over remaining days of the month, added to month-to-date actuals.
- <10 days: heuristic variance multipliers from the source research report, applied per token class to the median day — p90 = 2× input + 3× output + 5× reasoning; p99 = 5×/8×/10×.
- The method and days-observed are always reported. Never trust (or emit) a point estimate.
