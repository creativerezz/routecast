import type { EnrichedEvent } from "../events/schema.js";
import { type AnalyzerContext, type Finding, monthlyRate, usd } from "./analyzer.js";

/**
 * Cache analysis: (a) quantify what prompt caching is already saving,
 * (b) detect groups of calls with large repeated prompts and no cache reads —
 * the missed-opportunity case.
 *
 * Honesty rule: without prompt text we cannot prove a stable prefix, so missed
 * -opportunity savings assume only 50% of the repeated prompt volume is
 * cacheable and findings are capped at medium confidence.
 */
export function analyzeCache(events: EnrichedEvent[], ctx: AnalyzerContext): Finding[] {
  let realizedUsd = 0;
  let cacheReadTokens = 0;

  interface MissGroup {
    displayName: string;
    feature: string;
    calls: number;
    promptTokens: number;
    perTokIn: number;
    readMultiplier: number;
  }
  const missGroups = new Map<string, MissGroup>();

  for (const e of events) {
    if (!e.entry?.cache || !e.cost) continue;
    const tier = e.entry.tiers[Math.min(e.cost.tierIndex, e.entry.tiers.length - 1)];
    if (!tier) continue;
    const perTokIn = tier.inputPerMtok / 1e6;
    const { readMultiplier, minCacheableTokens } = e.entry.cache;

    // Realized: cache reads billed at readMultiplier instead of full input price.
    realizedUsd += e.tokens.cacheRead * perTokIn * (1 - readMultiplier);
    cacheReadTokens += e.tokens.cacheRead;

    // Missed: a big prompt, zero cache hits.
    const prompt = e.tokens.input + e.tokens.cacheWrite;
    if (e.tokens.cacheRead === 0 && prompt >= minCacheableTokens) {
      const key = `${e.feature ?? "unknown"}::${e.entry.key}`;
      const g = missGroups.get(key) ?? {
        displayName: e.entry.displayName,
        feature: e.feature ?? "unknown",
        calls: 0,
        promptTokens: 0,
        perTokIn,
        readMultiplier,
      };
      g.calls++;
      g.promptTokens += prompt;
      missGroups.set(key, g);
    }
  }

  const findings: Finding[] = [];

  if (realizedUsd > 0.01) {
    const monthly = monthlyRate(realizedUsd, ctx.window);
    findings.push({
      analyzer: "cache",
      severity: "info",
      title: `Prompt caching is already saving you ~${usd(monthly)}/mo`,
      detail:
        `${(cacheReadTokens / 1e6).toFixed(1)}M tokens were served from cache in the window, billed at the ` +
        `cache-read rate instead of full input price — ${usd(realizedUsd)} saved vs uncached ` +
        `(~${usd(monthly)}/mo). Keep prompts prefix-stable: reordering kills the hit rate.`,
      confidence: "high",
      data: {
        realizedUsd: Math.round(realizedUsd * 100) / 100,
        cacheReadTokens,
        monthlyUsd: Math.round(monthly * 100) / 100,
      },
    });
  }

  for (const g of missGroups.values()) {
    if (g.calls < 3) continue;
    // Assume conservatively that half the repeated prompt volume is a stable, cacheable prefix.
    const potential = 0.5 * g.promptTokens * g.perTokIn * (1 - g.readMultiplier);
    const monthly = monthlyRate(potential, ctx.window);
    if (monthly < 1) continue;
    findings.push({
      analyzer: "cache",
      severity: "recommendation",
      title: `Cache opportunity: ${g.feature} on ${g.displayName} (~${usd(monthly)}/mo)`,
      detail:
        `${g.calls} calls in "${g.feature}" sent ${(g.promptTokens / 1e6).toFixed(2)}M prompt tokens above the ` +
        `cacheable minimum with zero cache reads. If ~50% of that volume is a stable prefix (system prompt, tool ` +
        `schemas, retrieved context), caching it saves ~${usd(potential)} per window (~${usd(monthly)}/mo) at the ` +
        `${Math.round((1 - g.readMultiplier) * 100)}% cache-read discount. We can't see prompt text, so verify the ` +
        `prefix is actually stable before relying on this number.`,
      estimatedMonthlySavingsUsd: Math.round(monthly * 100) / 100,
      confidence: g.calls >= 10 ? "medium" : "low",
      data: {
        feature: g.feature,
        calls: g.calls,
        promptTokens: g.promptTokens,
        assumedCacheableShare: 0.5,
      },
    });
  }

  return findings;
}
