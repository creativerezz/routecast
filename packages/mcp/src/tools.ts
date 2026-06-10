import {
  detectSources,
  EventStore,
  ingestClaudeCode,
  type Report,
  rankCandidates,
  runAnalysis,
  type UsageEvent,
} from "@routecast/core";
import {
  blendedPerMtok,
  computeCost,
  defaultResolver,
  defaultSnapshot,
  type WorkloadType,
} from "@routecast/pricing";

export type WindowSpec = "7d" | "30d" | "mtd";

export function windowDaysOf(window: WindowSpec, now = new Date()): number {
  if (window === "7d") return 7;
  if (window === "30d") return 30;
  return Math.max(1, now.getUTCDate()); // mtd
}

let cached: { report: Report; key: string; at: number } | null = null;
const TTL_MS = 5 * 60 * 1000;

/** Build (and briefly cache) a report over the local store + auto-detected Claude Code logs. */
export async function loadReport(window: WindowSpec = "30d"): Promise<Report> {
  const now = new Date();
  const windowDays = windowDaysOf(window, now);
  const key = `${window}:${windowDays}`;
  if (cached && cached.key === key && now.getTime() - cached.at < TTL_MS) return cached.report;

  const since = new Date(now.getTime() - windowDays * 86_400_000);
  const events: UsageEvent[] = await new EventStore().readAll();
  for (const source of await detectSources()) {
    const { events: ev } = await ingestClaudeCode(source.path, { since });
    events.push(...ev);
  }
  const report = runAnalysis(events, { windowDays });
  cached = { report, key, at: now.getTime() };
  return report;
}

export function estimateCostTool(args: {
  model: string;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens?: number;
  cached_input_tokens?: number;
  cache_write_tokens?: number;
  batch?: boolean;
}) {
  const entry = defaultResolver.byKey(args.model) ?? defaultResolver.resolve(args.model);
  if (!entry) {
    return {
      error: `unknown model "${args.model}" — not in the pricing matrix (as of ${defaultSnapshot.asOf})`,
    };
  }
  const cost = computeCost(entry, {
    inputTokens: args.input_tokens,
    outputTokens: args.output_tokens,
    reasoningTokens: args.reasoning_tokens,
    cacheReadTokens: args.cached_input_tokens,
    cacheWriteTokens: args.cache_write_tokens,
    batch: args.batch,
  });
  return {
    model: entry.key,
    displayName: entry.displayName,
    pricingConfidence: entry.pricingConfidence,
    pricingAsOf: defaultSnapshot.asOf,
    ...cost,
    crossedPricingCliff: cost.tierIndex > 0,
  };
}

export function recommendModelTool(args: {
  workload: WorkloadType;
  context_tokens?: number;
  min_intelligence_index?: number;
}) {
  const candidates = rankCandidates(defaultSnapshot.models, args.workload, {
    minFitness: 2,
    minIntelligenceIndex: args.min_intelligence_index,
    maxContextTokens: args.context_tokens,
  });
  return {
    workload: args.workload,
    pricingAsOf: defaultSnapshot.asOf,
    note: "blendedPerMtok uses a 3:1 input:output ratio. Fitness is 0–3 from the Routecast capability matrix; validate on your traffic.",
    candidates: candidates.slice(0, 8),
  };
}

export function checkPricingCliffTool(args: { model: string; context_tokens: number }) {
  const entry = defaultResolver.byKey(args.model) ?? defaultResolver.resolve(args.model);
  if (!entry) return { error: `unknown model "${args.model}"` };
  let tierIndex = entry.tiers.length - 1;
  for (const [i, tier] of entry.tiers.entries()) {
    if (tier.upToContextTokens === null || args.context_tokens <= tier.upToContextTokens) {
      tierIndex = i;
      break;
    }
  }
  const tier = entry.tiers[tierIndex];
  const next = entry.tiers[tierIndex + 1];
  const prevBoundary = tier?.upToContextTokens;
  const base = entry.tiers[0];
  return {
    model: entry.key,
    contextTokens: args.context_tokens,
    exceedsContextWindow: args.context_tokens > entry.contextWindow,
    tierInEffect: tierIndex,
    inputPerMtok: tier?.inputPerMtok,
    outputPerMtok: tier?.outputPerMtok,
    surchargeVsBaseTier:
      base && tier && base.inputPerMtok > 0
        ? Math.round((tier.inputPerMtok / base.inputPerMtok) * 100) / 100
        : 1,
    nextCliffAtTokens: next ? prevBoundary : null,
    tokensUntilNextCliff:
      next && prevBoundary ? Math.max(0, prevBoundary - args.context_tokens) : null,
    advice:
      tierIndex > 0
        ? `This request is priced at tier ${tierIndex + 1} (${tier?.inputPerMtok}/Mtok input vs ${base?.inputPerMtok}/Mtok base). Prune context below ${entry.tiers[tierIndex - 1]?.upToContextTokens?.toLocaleString("en-US")} tokens or use a flat-priced model (e.g. anthropic/claude-sonnet-4-6 is flat to 1M).`
        : "Within base-tier pricing.",
  };
}

export async function getSpendSummaryTool(args: { window?: WindowSpec }) {
  const report = await loadReport(args.window ?? "30d");
  return {
    window: report.window,
    pricingAsOf: report.pricing.asOf,
    totals: report.totals,
    note: "Costs computed from the Routecast pricing matrix; models marked unknown are excluded (see findings).",
  };
}

export async function forecastMonthEndTool(args: { window?: WindowSpec }) {
  const report = await loadReport(args.window ?? "30d");
  return report.forecast;
}

export async function listFindingsTool(args: {
  severity?: "critical" | "warning" | "recommendation" | "info";
  analyzer?: "forecast" | "routing" | "reasoning" | "cache" | "cliffs" | "pipeline";
  window?: WindowSpec;
}) {
  const report = await loadReport(args.window ?? "30d");
  let findings = report.findings;
  if (args.severity) findings = findings.filter((f) => f.severity === args.severity);
  if (args.analyzer) findings = findings.filter((f) => f.analyzer === args.analyzer);
  return { count: findings.length, findings };
}

export const matrixSummary = () => ({
  asOf: defaultSnapshot.asOf,
  models: defaultSnapshot.models.map((m) => ({
    key: m.key,
    displayName: m.displayName,
    blendedPerMtok: Math.round(blendedPerMtok(m) * 1000) / 1000,
    intelligenceIndex: m.intelligenceIndex,
    pricingConfidence: m.pricingConfidence,
  })),
});
