import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { workloadTypes } from "@routecast/pricing";
import { z } from "zod";
import {
  checkPricingCliffTool,
  estimateCostTool,
  forecastMonthEndTool,
  getSpendSummaryTool,
  listFindingsTool,
  recommendModelTool,
} from "./tools.js";

const json = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});

const windowSchema = z.enum(["7d", "30d", "mtd"]).optional();

export function createServer(): McpServer {
  const server = new McpServer({ name: "routecast", version: "0.1.0" });

  server.registerTool(
    "get_spend_summary",
    {
      title: "Get LLM spend summary",
      description:
        "Summarize local LLM spend (by model, project, workload) computed from usage logs — Claude Code transcripts and the ~/.routecast store. Includes cache savings and reasoning-token spend.",
      inputSchema: { window: windowSchema },
    },
    async (args) => json(await getSpendSummaryTool(args)),
  );

  server.registerTool(
    "forecast_month_end",
    {
      title: "Forecast month-end LLM spend",
      description:
        "Project month-end LLM spend with p50/p90/p99 variance bands from observed daily burn. Token usage is right-skewed — the bands matter more than the point estimate.",
      inputSchema: { window: windowSchema },
    },
    async (args) => json(await forecastMonthEndTool(args)),
  );

  server.registerTool(
    "recommend_model",
    {
      title: "Recommend a model for a workload",
      description:
        "Rank cost-appropriate models for a workload type (small-first routing). Returns blended $/Mtok, Intelligence Index, and workload fitness so an agent can pick the cheapest model that can do the job.",
      inputSchema: {
        workload: z.enum(workloadTypes),
        context_tokens: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("required context window size, filters out smaller models"),
        min_intelligence_index: z.number().optional(),
      },
    },
    async (args) => json(recommendModelTool(args)),
  );

  server.registerTool(
    "estimate_cost",
    {
      title: "Estimate request cost",
      description:
        "Estimate the USD cost of a hypothetical LLM request (input/output/reasoning/cached tokens, optional batch discount) against the Routecast pricing matrix. Useful before running an expensive operation.",
      inputSchema: {
        model: z.string().describe("model id or matrix key, e.g. claude-sonnet-4-6"),
        input_tokens: z.number().int().nonnegative(),
        output_tokens: z.number().int().nonnegative(),
        reasoning_tokens: z.number().int().nonnegative().optional(),
        cached_input_tokens: z.number().int().nonnegative().optional(),
        cache_write_tokens: z.number().int().nonnegative().optional(),
        batch: z.boolean().optional(),
      },
    },
    async (args) => json(estimateCostTool(args)),
  );

  server.registerTool(
    "check_pricing_cliff",
    {
      title: "Check long-context pricing cliff",
      description:
        "Check whether a context size crosses a model's long-context pricing cliff (e.g. Gemini 3.1 Pro doubles input above 200K tokens; GPT-5.5 reprices above 272K) and how far the next cliff is.",
      inputSchema: {
        model: z.string(),
        context_tokens: z.number().int().positive(),
      },
    },
    async (args) => json(checkPricingCliffTool(args)),
  );

  server.registerTool(
    "list_findings",
    {
      title: "List cost findings",
      description:
        "List Routecast findings (routing recommendations, cache opportunities, pricing-cliff and deprecation warnings, reasoning-token attribution) from the latest local analysis, filterable by severity and analyzer.",
      inputSchema: {
        severity: z.enum(["critical", "warning", "recommendation", "info"]).optional(),
        analyzer: z
          .enum(["forecast", "routing", "reasoning", "cache", "cliffs", "pipeline"])
          .optional(),
        window: windowSchema,
      },
    },
    async (args) => json(await listFindingsTool(args)),
  );

  return server;
}

export async function startStdioServer(): Promise<void> {
  const server = createServer();
  await server.connect(new StdioServerTransport());
  // Keep the process alive; the transport closes us when the client disconnects.
}
