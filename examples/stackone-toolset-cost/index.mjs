/**
 * What does a tool-calling agent loop actually cost — and what changes it?
 *
 * Scenario: an agent wired to enterprise SaaS tools via StackOne's ToolSet
 * (https://github.com/StackOneHQ/stackone-ai-node). Tool schemas for a few
 * connected integrations + system prompt ≈ 18K tokens that are IDENTICAL on
 * every iteration — exactly the "MCP token bloat" StackOne writes about
 * (https://www.stackone.com/blog/mcp-token-optimization/).
 *
 * Routecast's pricing engine quantifies the three levers: prompt caching,
 * model choice, and both combined.
 */
import { computeCost, defaultResolver } from "@routecast/pricing";

const STATIC_PREFIX = 18_000; // system prompt + ToolSet tool schemas (stable per session)
const ITERATIONS = 12; // tool-call round trips per task
const NEW_INPUT_PER_ITER = 1_500; // fresh tool results + user context per iteration
const OUTPUT_PER_ITER = 800; // assistant output incl. tool_use blocks
const TASKS_PER_MONTH = 2_000;

const model = (key) => {
  const entry = defaultResolver.byKey(key);
  if (!entry) throw new Error(`missing ${key}`);
  return entry;
};

function loopCost(entry, { cached }) {
  let total = 0;
  for (let i = 0; i < ITERATIONS; i++) {
    // Conversation history grows with each iteration.
    const history = i * (NEW_INPUT_PER_ITER + OUTPUT_PER_ITER);
    const breakdown = computeCost(entry, {
      inputTokens: cached
        ? NEW_INPUT_PER_ITER + history
        : STATIC_PREFIX + NEW_INPUT_PER_ITER + history,
      cacheReadTokens: cached && i > 0 ? STATIC_PREFIX : 0,
      cacheWriteTokens: cached && i === 0 ? STATIC_PREFIX : 0,
      outputTokens: OUTPUT_PER_ITER,
    });
    total += breakdown.totalUsd;
  }
  return total;
}

const rows = [];
for (const [label, key, cached] of [
  ["Claude Opus 4.7, no caching", "anthropic/claude-opus-4-7", false],
  ["Claude Opus 4.7, schemas cached", "anthropic/claude-opus-4-7", true],
  ["Claude Sonnet 4.6, schemas cached", "anthropic/claude-sonnet-4-6", true],
  ["GPT-5.4 mini, schemas cached", "openai/gpt-5-4-mini", true],
]) {
  const perTask = loopCost(model(key), { cached });
  rows.push({ label, perTask, monthly: perTask * TASKS_PER_MONTH });
}

const base = rows[0].monthly;
console.log("\nStackOne ToolSet agent loop — 12 iterations, 18K-token tool schema prefix,");
console.log(
  `${TASKS_PER_MONTH.toLocaleString("en-US")} tasks/month (pricing: @routecast/pricing)\n`,
);
for (const r of rows) {
  const delta =
    r.monthly === base ? "baseline" : `${Math.round((1 - r.monthly / base) * 100)}% cheaper`;
  console.log(
    `  ${r.label.padEnd(36)} $${r.perTask.toFixed(3)}/task   $${Math.round(r.monthly).toLocaleString("en-US")}/mo   ${delta}`,
  );
}
console.log(
  "\nThe lesson: cache the ToolSet schemas first (free 60-80% on the loop's input),\nthen route — the two stack.\n",
);
