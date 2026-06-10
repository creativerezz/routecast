import type { EnrichedEvent } from "../events/schema.js";
import { type AnalyzerContext, type Finding, monthlyRate, usd } from "./analyzer.js";

/**
 * Reasoning-token attribution: thinking tokens are billed as output but are
 * invisible in most dashboards — the single largest source of underforecast
 * spend on reasoning models (per the source report).
 */
export function analyzeReasoning(events: EnrichedEvent[], ctx: AnalyzerContext): Finding[] {
  interface Agg {
    displayName: string;
    reasoningUsd: number;
    outputUsd: number;
    reasoningTokens: number;
    estimated: boolean;
  }
  const byModel = new Map<string, Agg>();
  for (const e of events) {
    if (!e.cost || !e.entry) continue;
    const agg = byModel.get(e.entry.key) ?? {
      displayName: e.entry.displayName,
      reasoningUsd: 0,
      outputUsd: 0,
      reasoningTokens: 0,
      estimated: false,
    };
    agg.reasoningUsd += e.cost.reasoningUsd;
    agg.outputUsd += e.cost.outputUsd;
    agg.reasoningTokens += e.tokens.reasoning;
    agg.estimated ||= e.tokens.reasoningEstimated;
    byModel.set(e.entry.key, agg);
  }

  const totalReasoning = [...byModel.values()].reduce((s, a) => s + a.reasoningUsd, 0);
  const totalOutput = [...byModel.values()].reduce((s, a) => s + a.outputUsd, 0);
  if (totalReasoning <= 0) return [];

  const findings: Finding[] = [];
  const share = totalReasoning / (totalReasoning + totalOutput);
  const anyEstimated = [...byModel.values()].some((a) => a.estimated);

  findings.push({
    analyzer: "reasoning",
    severity: "info",
    title: `Reasoning tokens are ${Math.round(share * 100)}% of your output-class spend (${usd(totalReasoning)} of ${usd(totalReasoning + totalOutput)})`,
    detail:
      `Reasoning/thinking tokens are billed at the output rate but don't appear in responses. ` +
      `Across the window they cost ${usd(totalReasoning)} vs ${usd(totalOutput)} of visible output.` +
      (anyEstimated
        ? " Anthropic does not report a reasoning split — these figures are estimated from thinking-block text length (chars/4) and marked accordingly."
        : ""),
    confidence: anyEstimated ? "medium" : "high",
    data: {
      totalReasoningUsd: Math.round(totalReasoning * 100) / 100,
      totalOutputUsd: Math.round(totalOutput * 100) / 100,
      share: Math.round(share * 1000) / 1000,
      byModel: Object.fromEntries(
        [...byModel.entries()].map(([k, a]) => [
          k,
          {
            reasoningUsd: Math.round(a.reasoningUsd * 100) / 100,
            outputUsd: Math.round(a.outputUsd * 100) / 100,
            reasoningTokens: a.reasoningTokens,
            estimated: a.estimated,
          },
        ]),
      ),
    },
  });

  for (const [key, agg] of byModel) {
    const modelShare = agg.reasoningUsd / Math.max(1e-9, agg.reasoningUsd + agg.outputUsd);
    if (modelShare > 0.4 && agg.reasoningUsd >= 1) {
      const monthly = monthlyRate(agg.reasoningUsd, ctx.window);
      const conservative = monthly * 0.3; // report: effort tuning saves 25–50% on reasoning models
      findings.push({
        analyzer: "reasoning",
        severity: "recommendation",
        title: `Tune reasoning effort on ${agg.displayName}: thinking is ${Math.round(modelShare * 100)}% of its output spend`,
        detail:
          `${agg.displayName} spent ${usd(agg.reasoningUsd)} on reasoning tokens vs ${usd(agg.outputUsd)} visible output ` +
          `(~${usd(monthly)}/mo on reasoning alone). Most production workloads run fine at medium effort; ` +
          `providers bill thinking tokens as output, so lower effort = fewer thinking tokens = a directly lower bill. ` +
          `A conservative 30% reduction ≈ ${usd(conservative)}/mo.`,
        estimatedMonthlySavingsUsd: Math.round(conservative * 100) / 100,
        confidence: agg.estimated ? "medium" : "high",
        data: { model: key, sharePct: Math.round(modelShare * 100) },
      });
    }
  }
  return findings;
}
