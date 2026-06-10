import type { CostBreakdown, ModelEntry, WorkloadType } from "@routecast/pricing";
import { z } from "zod";

export const tokenCountsSchema = z.object({
  /** Uncached input tokens. */
  input: z.number().nonnegative(),
  cacheRead: z.number().nonnegative().default(0),
  cacheWrite: z.number().nonnegative().default(0),
  /** Visible output tokens (excluding reasoning when the split is known). */
  output: z.number().nonnegative(),
  /** Reasoning/thinking tokens (billed as output by providers). */
  reasoning: z.number().nonnegative().default(0),
  /** True when reasoning was estimated (e.g. from thinking-block text length) rather than reported. */
  reasoningEstimated: z.boolean().default(false),
});

export const usageEventSchema = z.object({
  /** Stable content-derived id — the dedup key across ingest runs and sources. */
  id: z.string(),
  /** ISO 8601 timestamp. */
  ts: z.string(),
  provider: z.string(),
  /** Raw model id exactly as logged. */
  model: z.string(),
  tokens: tokenCountsSchema,
  /** Observed cost (billing APIs / gateways). Null when only computable from the matrix. */
  costUsd: z.number().nullable().default(null),
  latencyMs: z.number().optional(),
  status: z.enum(["ok", "error", "unknown"]).default("ok"),
  /** Attribution tag — for Claude Code logs this is the project directory name. */
  feature: z.string().optional(),
  session: z.string().optional(),
  source: z.string(),
});

export type UsageEvent = z.infer<typeof usageEventSchema>;

/** A usage event after pricing resolution, costing, and workload classification. */
export interface EnrichedEvent extends UsageEvent {
  modelKey: string | null;
  entry: ModelEntry | null;
  /** Computed from the pricing matrix; null when the model is unknown. */
  cost: CostBreakdown | null;
  /** Observed cost when available, else computed, else 0. */
  effectiveCostUsd: number;
  workload: WorkloadType;
}
