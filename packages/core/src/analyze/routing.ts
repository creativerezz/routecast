import { blendedPerMtok, type ModelEntry, type WorkloadType } from "@routecast/pricing";
import type { EnrichedEvent } from "../events/schema.js";
import { type AnalyzerContext, type Finding, monthlyRate, usd } from "./analyzer.js";

export interface RoutingOptions {
  /** Maximum Intelligence Index drop tolerated when recommending a cheaper model. */
  maxIntelligenceDrop?: number;
  /** Minimum estimated monthly savings before a finding is emitted. */
  minMonthlySavingsUsd?: number;
}

export interface RoutingCandidate {
  key: string;
  displayName: string;
  blendedPerMtok: number;
  intelligenceIndex?: number;
  fitness: number;
  pricingConfidence: "confirmed" | "estimated";
}

/** Rank cheaper-but-fit alternatives for a workload. Exported for the MCP recommend_model tool. */
export function rankCandidates(
  models: ModelEntry[],
  workload: WorkloadType,
  opts: { minFitness?: number; minIntelligenceIndex?: number; maxContextTokens?: number } = {},
): RoutingCandidate[] {
  const minFitness = opts.minFitness ?? 2;
  return models
    .filter((m) => {
      const fitness = m.workloadFitness?.[workload];
      if (fitness === undefined || fitness < minFitness) return false;
      if (
        opts.minIntelligenceIndex !== undefined &&
        (m.intelligenceIndex ?? 0) < opts.minIntelligenceIndex
      )
        return false;
      if (opts.maxContextTokens !== undefined && m.contextWindow < opts.maxContextTokens)
        return false;
      if (m.deprecation?.retiresOn) return false;
      return true;
    })
    .map((m) => ({
      key: m.key,
      displayName: m.displayName,
      blendedPerMtok: Math.round(blendedPerMtok(m) * 1000) / 1000,
      intelligenceIndex: m.intelligenceIndex,
      fitness: m.workloadFitness?.[workload] ?? 0,
      pricingConfidence: m.pricingConfidence,
    }))
    .sort((a, b) => a.blendedPerMtok - b.blendedPerMtok);
}

/**
 * Small-first routing recommendations: for each (workload, model) traffic
 * cluster, find the cheapest model that is at least as fit for the workload and
 * within the tolerated intelligence drop, and quantify the monthly savings.
 */
export function analyzeRouting(
  events: EnrichedEvent[],
  ctx: AnalyzerContext,
  opts: RoutingOptions = {},
): Finding[] {
  const maxDrop = opts.maxIntelligenceDrop ?? 5;
  const minSavings = opts.minMonthlySavingsUsd ?? 1;

  interface Cluster {
    workload: WorkloadType;
    entry: ModelEntry;
    costUsd: number;
    calls: number;
  }
  const clusters = new Map<string, Cluster>();
  for (const e of events) {
    if (!e.entry) continue;
    const key = `${e.workload}::${e.entry.key}`;
    const cluster = clusters.get(key) ?? {
      workload: e.workload,
      entry: e.entry,
      costUsd: 0,
      calls: 0,
    };
    cluster.costUsd += e.effectiveCostUsd;
    cluster.calls++;
    clusters.set(key, cluster);
  }

  const findings: Finding[] = [];
  for (const cluster of clusters.values()) {
    const current = cluster.entry;
    const currentFitness = current.workloadFitness?.[cluster.workload] ?? 2;
    const currentII = current.intelligenceIndex ?? 50;
    const currentBlended = blendedPerMtok(current);

    const candidates = rankCandidates(ctx.snapshot.models, cluster.workload, {
      minFitness: currentFitness,
      minIntelligenceIndex: currentII - maxDrop,
    }).filter((c) => c.key !== current.key && c.blendedPerMtok < currentBlended * 0.8);

    const best = candidates[0];
    if (!best) continue;

    const ratio = best.blendedPerMtok / currentBlended;
    const monthly = monthlyRate(cluster.costUsd, ctx.window);
    const savings = monthly * (1 - ratio);
    if (savings < minSavings) continue;

    const confidence: Finding["confidence"] =
      best.pricingConfidence === "estimated" || cluster.calls < 10
        ? "low"
        : cluster.calls < 50
          ? "medium"
          : "high";

    findings.push({
      analyzer: "routing",
      severity: "recommendation",
      title: `Route ${cluster.workload} traffic from ${current.displayName} to ${best.displayName} (~${usd(savings)}/mo)`,
      detail:
        `${cluster.calls} ${cluster.workload} calls on ${current.displayName} cost ${usd(cluster.costUsd)} in the window ` +
        `(~${usd(monthly)}/mo). ${best.displayName} is ${usd(best.blendedPerMtok)}/Mtok blended vs ${usd(currentBlended)}/Mtok ` +
        `(3:1 in:out) — a ${Math.round((1 - ratio) * 100)}% reduction — with workload fitness ${best.fitness}/3 and ` +
        `Intelligence Index ${best.intelligenceIndex ?? "n/a"} vs ${currentII} (within the ${maxDrop}-point tolerance). ` +
        `Validate on a slice of traffic first: workload classification is heuristic.`,
      estimatedMonthlySavingsUsd: Math.round(savings * 100) / 100,
      confidence,
      data: {
        workload: cluster.workload,
        from: current.key,
        to: best.key,
        calls: cluster.calls,
        windowCostUsd: Math.round(cluster.costUsd * 100) / 100,
        monthlyCostUsd: Math.round(monthly * 100) / 100,
        candidates: candidates.slice(0, 3),
      },
    });
  }
  return findings.sort(
    (a, b) => (b.estimatedMonthlySavingsUsd ?? 0) - (a.estimatedMonthlySavingsUsd ?? 0),
  );
}
