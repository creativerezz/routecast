import { computeCost } from "@routecast/pricing";
import type { EnrichedEvent } from "../events/schema.js";
import { type AnalyzerContext, type Finding, monthlyRate, usd } from "./analyzer.js";

/**
 * Pricing-cliff alerts (e.g. Gemini 3.1 Pro doubles input above 200K prompt
 * tokens; GPT-5.5 reprices above 272K) and model deprecation warnings.
 */
export function analyzeCliffs(events: EnrichedEvent[], ctx: AnalyzerContext): Finding[] {
  interface CliffAgg {
    displayName: string;
    calls: number;
    surchargeUsd: number;
    threshold: number;
  }
  const cliffs = new Map<string, CliffAgg>();
  const usedModels = new Map<string, { displayName: string; costUsd: number; events: number }>();

  for (const e of events) {
    if (!e.entry) continue;
    const used = usedModels.get(e.entry.key) ?? {
      displayName: e.entry.displayName,
      costUsd: 0,
      events: 0,
    };
    used.costUsd += e.effectiveCostUsd;
    used.events++;
    usedModels.set(e.entry.key, used);

    if (!e.cost || e.cost.tierIndex === 0 || e.entry.tiers.length < 2) continue;
    const baseTier = e.entry.tiers[0];
    if (!baseTier) continue;
    // What the same request would have cost at base-tier rates.
    const atBase = computeCost(
      { ...e.entry, tiers: [{ ...baseTier, upToContextTokens: null }] },
      {
        inputTokens: e.tokens.input,
        cacheReadTokens: e.tokens.cacheRead,
        cacheWriteTokens: e.tokens.cacheWrite,
        outputTokens: e.tokens.output,
        reasoningTokens: e.tokens.reasoning,
      },
    );
    const surcharge = e.cost.totalUsd - atBase.totalUsd;
    if (surcharge <= 0) continue;
    const agg = cliffs.get(e.entry.key) ?? {
      displayName: e.entry.displayName,
      calls: 0,
      surchargeUsd: 0,
      threshold: baseTier.upToContextTokens ?? 0,
    };
    agg.calls++;
    agg.surchargeUsd += surcharge;
    cliffs.set(e.entry.key, agg);
  }

  const findings: Finding[] = [];

  for (const [key, agg] of cliffs) {
    const monthly = monthlyRate(agg.surchargeUsd, ctx.window);
    findings.push({
      analyzer: "cliffs",
      severity: "warning",
      title: `${agg.calls} calls crossed the ${Math.round(agg.threshold / 1000)}K pricing cliff on ${agg.displayName} (+${usd(monthly)}/mo)`,
      detail:
        `${agg.displayName} reprices the entire request once the prompt exceeds ${agg.threshold.toLocaleString("en-US")} ` +
        `tokens. Those ${agg.calls} calls paid ${usd(agg.surchargeUsd)} more than base-tier pricing in the window ` +
        `(~${usd(monthly)}/mo). Options: prune retrieved context below the threshold, summarize history, or move ` +
        `ultra-long-context traffic to a flat-priced model (e.g. Claude Sonnet 4.6 is flat to 1M).`,
      estimatedMonthlySavingsUsd: Math.round(monthly * 100) / 100,
      confidence: "high",
      data: {
        model: key,
        calls: agg.calls,
        surchargeUsd: Math.round(agg.surchargeUsd * 100) / 100,
      },
    });
  }

  // Deprecation warnings for models actually in use.
  for (const [key, used] of usedModels) {
    const entry = ctx.resolver.byKey(key);
    const retiresOn = entry?.deprecation?.retiresOn;
    if (!entry || !retiresOn) continue;
    const daysLeft = Math.floor(
      (new Date(`${retiresOn}T00:00:00Z`).getTime() - ctx.now.getTime()) / 86_400_000,
    );
    if (daysLeft > 90) continue;
    const replacement = entry.deprecation?.replacement
      ? ctx.resolver.byKey(entry.deprecation.replacement)?.displayName
      : undefined;
    findings.push({
      analyzer: "cliffs",
      severity: daysLeft <= 30 ? "critical" : "warning",
      title:
        daysLeft < 0
          ? `${entry.displayName} is retired (${retiresOn}) and still receiving traffic`
          : `${entry.displayName} retires in ${daysLeft} days (${retiresOn})`,
      detail:
        `${used.events} calls (${usd(used.costUsd)}) hit ${entry.displayName} in the window. ` +
        (replacement ? `Provider-recommended replacement: ${replacement}. ` : "") +
        `Migrate before the retirement date to avoid hard failures.`,
      confidence: "high",
      data: { model: key, retiresOn, daysLeft, events: used.events },
    });
  }

  // Flag estimated pricing so computed costs are never mistaken for billing truth.
  const estimated = [...usedModels.entries()]
    .map(([key, used]) => ({ key, used, entry: ctx.resolver.byKey(key) }))
    .filter((x) => x.entry?.pricingConfidence === "estimated" && x.used.costUsd > 0);
  if (estimated.length > 0) {
    findings.push({
      analyzer: "cliffs",
      severity: "info",
      title: `Pricing is estimated (not provider-confirmed) for ${estimated.length} model(s) in use`,
      detail:
        estimated
          .map((x) => `${x.entry?.displayName}: ${usd(x.used.costUsd)} computed`)
          .join("; ") +
        '. These entries are marked pricingConfidence: "estimated" in the matrix — treat their dollar figures as approximate and PR corrections to packages/pricing/data/models.json.',
      confidence: "high",
      data: { models: estimated.map((x) => x.key) },
    });
  }

  return findings;
}
