import {
  computeCost,
  createResolver,
  defaultSnapshot,
  type PricingSnapshot,
  STALENESS_THRESHOLD_DAYS,
  snapshotAgeDays,
} from "@routecast/pricing";
import type { EnrichedEvent, UsageEvent } from "../events/schema.js";
import { type AnalyzerContext, type Finding, severityRank } from "./analyzer.js";
import { analyzeCache } from "./cache.js";
import { analyzeCliffs } from "./cliffs.js";
import { computeForecast, type Forecast } from "./forecast.js";
import { analyzeReasoning } from "./reasoning.js";
import { analyzeRouting, type RoutingOptions } from "./routing.js";
import { classifyWorkload, sessionCallCounts } from "./workload.js";

export interface AnalyzeOptions extends RoutingOptions {
  snapshot?: PricingSnapshot;
  /** Injected clock for deterministic tests. */
  now?: Date;
  windowDays?: number;
}

export interface ModelTotal {
  key: string | null;
  model: string;
  costUsd: number;
  events: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
}

export interface Report {
  generatedAt: string;
  window: { from: string; to: string; days: number };
  pricing: { asOf: string; version: string; ageDays: number };
  totals: {
    events: number;
    costUsd: number;
    byModel: ModelTotal[];
    byFeature: Array<{ feature: string; costUsd: number; events: number }>;
    byWorkload: Array<{ workload: string; costUsd: number; events: number }>;
    reasoningUsd: number;
    cacheSavedUsd: number;
    unknownModels: Array<{ model: string; events: number }>;
  };
  forecast: Forecast;
  findings: Finding[];
}

export function enrichEvents(
  events: UsageEvent[],
  ctx: Pick<AnalyzerContext, "resolver">,
): EnrichedEvent[] {
  const sessions = sessionCallCounts(events);
  return events.map((e) => {
    const entry = ctx.resolver.resolve(e.model);
    const cost = entry
      ? computeCost(entry, {
          inputTokens: e.tokens.input,
          cacheReadTokens: e.tokens.cacheRead,
          cacheWriteTokens: e.tokens.cacheWrite,
          outputTokens: e.tokens.output,
          reasoningTokens: e.tokens.reasoning,
        })
      : null;
    return {
      ...e,
      modelKey: entry?.key ?? null,
      entry,
      cost,
      effectiveCostUsd: e.costUsd ?? cost?.totalUsd ?? 0,
      workload: classifyWorkload(e, e.session ? (sessions.get(e.session) ?? 1) : 1),
    };
  });
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function runAnalysis(rawEvents: UsageEvent[], opts: AnalyzeOptions = {}): Report {
  const snapshot = opts.snapshot ?? defaultSnapshot;
  const resolver = createResolver(snapshot);
  const now = opts.now ?? new Date();
  const windowDays = opts.windowDays ?? 30;
  const from = new Date(now.getTime() - windowDays * 86_400_000);
  const ctx: AnalyzerContext = { snapshot, resolver, now, window: { from, to: now } };

  // Dedup by id (sources can overlap), then window-filter.
  const seen = new Set<string>();
  const windowed: UsageEvent[] = [];
  for (const e of rawEvents) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    const t = new Date(e.ts).getTime();
    if (Number.isNaN(t) || t < from.getTime() || t > now.getTime()) continue;
    windowed.push(e);
  }

  const events = enrichEvents(windowed, ctx);

  // Totals
  const byModel = new Map<string, ModelTotal>();
  const byFeature = new Map<string, { costUsd: number; events: number }>();
  const byWorkload = new Map<string, { costUsd: number; events: number }>();
  const unknown = new Map<string, number>();
  let costUsd = 0;
  let reasoningUsd = 0;
  let cacheSavedUsd = 0;

  for (const e of events) {
    costUsd += e.effectiveCostUsd;
    const label = e.entry?.displayName ?? e.model;
    const m = byModel.get(label) ?? {
      key: e.modelKey,
      model: label,
      costUsd: 0,
      events: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 0,
    };
    m.costUsd += e.effectiveCostUsd;
    m.events++;
    m.inputTokens += e.tokens.input + e.tokens.cacheRead + e.tokens.cacheWrite;
    m.outputTokens += e.tokens.output;
    m.reasoningTokens += e.tokens.reasoning;
    m.cacheReadTokens += e.tokens.cacheRead;
    byModel.set(label, m);

    const f = byFeature.get(e.feature ?? "unknown") ?? { costUsd: 0, events: 0 };
    f.costUsd += e.effectiveCostUsd;
    f.events++;
    byFeature.set(e.feature ?? "unknown", f);

    const w = byWorkload.get(e.workload) ?? { costUsd: 0, events: 0 };
    w.costUsd += e.effectiveCostUsd;
    w.events++;
    byWorkload.set(e.workload, w);

    if (!e.entry) unknown.set(e.model, (unknown.get(e.model) ?? 0) + 1);
    if (e.cost) reasoningUsd += e.cost.reasoningUsd;
    if (e.entry?.cache && e.cost) {
      const tier = e.entry.tiers[Math.min(e.cost.tierIndex, e.entry.tiers.length - 1)];
      if (tier) {
        cacheSavedUsd +=
          e.tokens.cacheRead * (tier.inputPerMtok / 1e6) * (1 - e.entry.cache.readMultiplier);
      }
    }
  }

  // Analyzers
  const { forecast, findings: forecastFindings } = computeForecast(events, ctx);
  const findings: Finding[] = [
    ...forecastFindings,
    ...analyzeRouting(events, ctx, opts),
    ...analyzeReasoning(events, ctx),
    ...analyzeCache(events, ctx),
    ...analyzeCliffs(events, ctx),
  ];

  if (unknown.size > 0) {
    const list = [...unknown.entries()].sort((a, b) => b[1] - a[1]);
    findings.push({
      analyzer: "pipeline",
      severity: "warning",
      title: `${list.reduce((s, [, n]) => s + n, 0)} events use models missing from the pricing matrix`,
      detail:
        `Unknown models: ${list.map(([m, n]) => `${m} (${n} events)`).join(", ")}. ` +
        `Their cost is NOT included in totals — figures above are an undercount. ` +
        `Add entries to packages/pricing/data/models.json (schema-validated, PRs welcome).`,
      confidence: "high",
      data: { models: Object.fromEntries(list) },
    });
  }

  const ageDays = snapshotAgeDays(snapshot, now);
  if (ageDays > STALENESS_THRESHOLD_DAYS) {
    findings.push({
      analyzer: "pipeline",
      severity: "warning",
      title: `Pricing data is ${ageDays} days old (as of ${snapshot.asOf})`,
      detail:
        `The LLM market reprices at multi-week cadence; recommendations may be stale. ` +
        `Update @routecast/pricing or PR fresh prices to packages/pricing/data/models.json.`,
      confidence: "high",
      data: { asOf: snapshot.asOf, ageDays },
    });
  }

  findings.sort(
    (a, b) =>
      severityRank[a.severity] - severityRank[b.severity] ||
      (b.estimatedMonthlySavingsUsd ?? 0) - (a.estimatedMonthlySavingsUsd ?? 0),
  );

  const top = <K, V extends { costUsd: number }>(map: Map<K, V>, n: number) =>
    [...map.entries()].sort((a, b) => b[1].costUsd - a[1].costUsd).slice(0, n);

  return {
    generatedAt: now.toISOString(),
    window: { from: from.toISOString(), to: now.toISOString(), days: windowDays },
    pricing: { asOf: snapshot.asOf, version: snapshot.version, ageDays },
    totals: {
      events: events.length,
      costUsd: round2(costUsd),
      byModel: top(byModel, 10).map(([, v]) => ({ ...v, costUsd: round2(v.costUsd) })),
      byFeature: top(byFeature, 10).map(([feature, v]) => ({
        feature,
        costUsd: round2(v.costUsd),
        events: v.events,
      })),
      byWorkload: top(byWorkload, 10).map(([workload, v]) => ({
        workload,
        costUsd: round2(v.costUsd),
        events: v.events,
      })),
      reasoningUsd: round2(reasoningUsd),
      cacheSavedUsd: round2(cacheSavedUsd),
      unknownModels: [...unknown.entries()].map(([model, events]) => ({ model, events })),
    },
    forecast,
    findings,
  };
}
