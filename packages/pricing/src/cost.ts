import type { ModelEntry, PriceTier } from "./schema.js";

export interface CostInput {
  /** Uncached input tokens. */
  inputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Visible output tokens (excluding reasoning when the split is known). */
  outputTokens: number;
  /** Reasoning/thinking tokens, billed at the output rate on every 2026 provider. */
  reasoningTokens?: number;
  /** Apply the provider's batch API discount. */
  batch?: boolean;
}

export interface CostBreakdown {
  totalUsd: number;
  inputUsd: number;
  cacheReadUsd: number;
  cacheWriteUsd: number;
  outputUsd: number;
  reasoningUsd: number;
  /** Index into the model's tiers that priced this request (0 = base tier). */
  tierIndex: number;
  /** Total prompt tokens used for tier selection. */
  promptTokens: number;
  batchApplied: boolean;
}

function selectTier(tiers: PriceTier[], promptTokens: number): { tier: PriceTier; index: number } {
  for (const [index, tier] of tiers.entries()) {
    if (tier.upToContextTokens === null || promptTokens <= tier.upToContextTokens) {
      return { tier, index };
    }
  }
  // Unreachable for schema-valid data (last tier is unbounded); satisfy the type checker.
  const index = tiers.length - 1;
  const tier = tiers[index];
  if (!tier) throw new Error("model has no pricing tiers");
  return { tier, index };
}

const round = (usd: number) => Math.round(usd * 1e6) / 1e6;

/**
 * Compute the cost of a single request against a matrix entry.
 *
 * Tier semantics are threshold-based: the tier containing the TOTAL prompt size
 * (input + cache read + cache write) prices ALL tokens in the request — this is
 * how Gemini's >200K and GPT-5.5's >272K cliffs actually bill.
 */
export function computeCost(model: ModelEntry, c: CostInput): CostBreakdown {
  const cacheRead = c.cacheReadTokens ?? 0;
  const cacheWrite = c.cacheWriteTokens ?? 0;
  const reasoning = c.reasoningTokens ?? 0;
  const promptTokens = c.inputTokens + cacheRead + cacheWrite;
  const { tier, index } = selectTier(model.tiers, promptTokens);

  const perTokIn = tier.inputPerMtok / 1e6;
  const perTokOut = tier.outputPerMtok / 1e6;
  const readMult = model.cache?.readMultiplier ?? 1;
  const writeMult = model.cache?.writeMultiplier ?? 1;

  let inputUsd = c.inputTokens * perTokIn;
  let cacheReadUsd = cacheRead * perTokIn * readMult;
  let cacheWriteUsd = cacheWrite * perTokIn * writeMult;
  let outputUsd = c.outputTokens * perTokOut;
  // Every current provider bills reasoning as output; "none" models simply have no reasoning tokens,
  // but if tokens are reported anyway, bill them at the output rate rather than dropping them.
  let reasoningUsd = reasoning * perTokOut;

  const batchApplied = Boolean(c.batch && model.batchDiscount);
  if (batchApplied && model.batchDiscount) {
    inputUsd *= model.batchDiscount;
    cacheReadUsd *= model.batchDiscount;
    cacheWriteUsd *= model.batchDiscount;
    outputUsd *= model.batchDiscount;
    reasoningUsd *= model.batchDiscount;
  }

  return {
    totalUsd: round(inputUsd + cacheReadUsd + cacheWriteUsd + outputUsd + reasoningUsd),
    inputUsd: round(inputUsd),
    cacheReadUsd: round(cacheReadUsd),
    cacheWriteUsd: round(cacheWriteUsd),
    outputUsd: round(outputUsd),
    reasoningUsd: round(reasoningUsd),
    tierIndex: index,
    promptTokens,
    batchApplied,
  };
}

/**
 * Blended price per 1M tokens at an input:output token ratio (default 3:1,
 * approximating chat/RAG traffic — the source report's convention).
 */
export function blendedPerMtok(model: ModelEntry, ratio = 3, tierIndex = 0): number {
  const tier = model.tiers[Math.min(tierIndex, model.tiers.length - 1)];
  if (!tier) throw new Error(`model ${model.key} has no pricing tiers`);
  return (ratio * tier.inputPerMtok + tier.outputPerMtok) / (ratio + 1);
}
