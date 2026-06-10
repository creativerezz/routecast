# ⚡ Routecast

**The cost intelligence layer for AI agents.** An analyzer, not a gateway.

Routecast reads the usage data you already have — Claude Code session logs, OpenTelemetry GenAI traces, or any JSONL — and tells you four things no dashboard does:

1. **What you'll spend** — month-end forecasts with p50/p90/p99 variance bands (token usage is right-skewed; a point estimate is useless)
2. **What should run cheaper** — small-first routing recommendations from a versioned pricing × capability matrix, with the quality justification attached
3. **Where your thinking tokens went** — reasoning-token attribution, the single largest source of underforecast spend on reasoning models
4. **What's silently overcharging you** — cache opportunities, long-context pricing cliffs (Gemini 3.1 Pro doubles input above 200K; GPT-5.5 reprices above 272K), and model deprecations

Zero proxying. Zero config to try. Your keys and logs never leave your machine.

```
$ npx routecast analyze

⚡ routecast · cost intelligence for AI agents
window 30d · 5,071 events · pricing as of 2026-04-28

SPEND     $469 computed   cache saved $1,858   reasoning $0.64
FORECAST  2026-06  $500 p50 · $1,531 p90 · $1,891 p99  (empirical, 23d observed)

BY MODEL
  Claude Opus 4.8                  $312  67%  ████████████████████████
  Claude Opus 4.7                  $133  28%  ██████████
  Claude Haiku 4.5                $9.59   2%  █

FINDINGS (11)
 ✦  save   Route agentic-loop traffic from Claude Opus 4.8 to GPT-5.4   ~$133/mo
 ✦  save   Cache opportunity: workspace on Claude Opus 4.8              ~$1.34/mo
 ℹ  info   Prompt caching is already saving you ~$1,858/mo
```

## Why an analyzer and not another gateway?

LiteLLM, Portkey, Bifrost, and Helicone already proxy requests well. But sitting in the request path means you only see traffic that opts in — and none of them answer the questions above:

| | LiteLLM | Helicone | Langfuse | Portkey | **Routecast** |
|---|:-:|:-:|:-:|:-:|:-:|
| Forecast with p50/p90/p99 bands | ✗ | ✗ | ✗ | ✗ | ✅ |
| Reasoning-token attribution | ✗ | ✗ | ✗ | ✗ | ✅ |
| Pricing-cliff alerts (200K/272K) | ✗ | ✗ | ✗ | ✗ | ✅ |
| Cache opportunity detection | ✗ | ✗ | ✗ | partial | ✅ |
| Routing recommendations w/ quality justification | ✗ | ✗ | ✗ | ✗ | ✅ |
| Works without touching your request path | ✗ | ✗ | partial | ✗ | ✅ |
| Agents can query it (MCP) | ✗ | ✗ | ✗ | ✗ | ✅ |

Routecast composes *with* gateways: point it at their logs.

## Quickstart

```bash
# zero-config: auto-detects Claude Code logs in ~/.claude/projects
npx routecast analyze

# the math behind every finding
npx routecast analyze --verbose

# month-end projection only
npx routecast forecast

# what would this request cost? (and does it cross a pricing cliff?)
npx routecast estimate -m gemini-3.1-pro -i 250000 -o 2000

# the full pricing/capability matrix, ranked for a workload
npx routecast models --workload extraction
```

Other data sources:

```bash
routecast ingest jsonl my-usage.jsonl     # documented generic format (docs/architecture.md)
routecast ingest otlp traces.json         # OTLP/JSON with gen_ai.* attributes (OpenLLMetry)
routecast ingest claude-code ~/some/dir   # explicit Claude Code transcripts
```

## Your agents can ask what they cost (MCP)

Routecast ships an MCP server, so agents can check costs *before* spending money — estimate a request, pick the cheapest fit model, or notice they're about to cross a pricing cliff mid-workflow.

```json
// .mcp.json
{
  "mcpServers": {
    "routecast": {
      "command": "npx",
      "args": ["-y", "routecast", "mcp"]
    }
  }
}
```

| Tool | What it answers |
|---|---|
| `get_spend_summary` | "What have I spent, on what, by model/project/workload?" |
| `forecast_month_end` | "Where does this month land? (p50/p90/p99)" |
| `recommend_model` | "Cheapest model that can handle this workload?" |
| `estimate_cost` | "What will this request cost before I send it?" |
| `check_pricing_cliff` | "Does 300K context cross a repricing threshold?" |
| `list_findings` | "Any cost problems I should fix?" |

## The pricing matrix is a community artifact

All recommendations key off [`packages/pricing/data/models.json`](packages/pricing/data/models.json): per-model price tiers (including long-context cliffs), cache read/write multipliers, batch discounts, Intelligence Index, workload fitness (0–3), and deprecation dates.

LLM pricing moves at multi-week cadence, so the matrix is built to be updated by pull request — it's pure JSON, validated by a Zod schema plus structural invariants in CI. **Honesty rules are enforced in the product:** every dollar figure shows its math, estimated prices are flagged (`pricingConfidence: "estimated"`), unknown models are surfaced as an explicit undercount warning (never silently $0), and stale pricing (>45 days) warns loudly. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Architecture

```
                      ┌────────────────────────────── @routecast/core ───┐
 Claude Code logs ─┐  │                                                  │
 OTLP gen_ai.* ────┼──►  ingest adapters → normalized UsageEvents        │
 generic JSONL ────┘  │       │                                          │
                      │       ▼                                          │
 @routecast/pricing ──►  enrich (resolve model, compute cost, classify)  │
 (models.json + Zod)  │       │                                          │
                      │       ▼                                          │
                      │  analyzers: forecast · routing · reasoning       │
                      │             cache · cliffs                       │
                      │       │                                          │
                      │       ▼                                          │
                      │  Report (findings w/ severity + confidence)      │
                      └───────┬──────────────────────────────────────────┘
                              ▼
            routecast CLI (terminal/md/json) · @routecast/mcp (6 tools)
```

Monorepo: pnpm workspace · TypeScript · tsdown · Vitest · Biome · release-please · Apache-2.0.

## Roadmap

- Provider billing-API adapters (OpenAI `/v1/organization/usage`, Anthropic Admin usage report)
- LiteLLM / Helicone / Vercel AI Gateway log importers
- SDK shim: wrap an AI SDK client to append the generic JSONL format locally
- Tokenizer-change detection (same text, more tokens — e.g. Opus 4.7's tokenizer runs up to 35% hotter than 4.6)
- Budget circuit-breaker config generator (50/75/90/100/110% thresholds)

## Acknowledgments

- Methodology grounded in an April 2026 LLM cost-optimization research report (pricing matrix, variance multipliers, workload routing tables).
- The agent-cost problem framing owes a lot to StackOne's engineering posts on [MCP token optimization](https://www.stackone.com/blog/mcp-token-optimization/) and [agentic context engineering](https://www.stackone.com/blog/agent-suicide-by-context/) — if you're building agents that call real tools, read them.
- Example: [`examples/stackone-toolset-cost`](examples/stackone-toolset-cost) estimates the cost shape of a [stackone-ai-node](https://github.com/StackOneHQ/stackone-ai-node) ToolSet agent loop and shows why caching the tool schemas changes the unit economics.

## License

Apache-2.0
