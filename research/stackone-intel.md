# StackOne Intel

Research notes for Routecast positioning and StackOne integration ideas.

## LLM-Facing Content Pipeline

StackOne exposes:

- `https://www.stackone.com/llms.txt` - concise product/catalog map
- `https://www.stackone.com/llms-full.txt` - full body content for pages, case studies, changelog, and blog posts

Useful claims from `llms.txt`:

- "Integration infrastructure for AI agents"
- 200+ apps, 10,000+ actions messaging
- 1,123 integrations, 308 live, 20,418+ actions across categories
- Platform surfaces: MCP Gateway, Agent Execution Engine, AI Connector Builder, Prompt Injection Guard
- Changelog themes: semantic tool discovery, `search_tools`, Defender, StackOne CLI, connector versioning, API key scopes

Routecast angle:

- Treat StackOne as the action layer; Routecast becomes the cost/context profiler for that action layer.
- The strongest wedge is quantifying schema bloat, response bloat, search-first discovery savings, and cost per successful SaaS action.
- `llms-full.txt` is a compact source of their full technical narrative and should be part of product research retrieval.

## Small Developer-Ecosystem Catch

`llms.txt` currently includes a use-case template entry:

```text
Complete Guide to [Use Case]
https://stackone.com/use-cases/_template
This is a template page showing all available sections with placeholder content.
```

That likely should be filtered from their LLM-facing output, similar to how non-canonical/noindex content is usually excluded from public discovery surfaces.

Conversation-friendly version:

> I was reading your `llms.txt` and noticed the use-case template leaks into the Use Cases section. Tiny filter fix, but it stood out because the rest of the LLM-facing catalog is unusually useful.
