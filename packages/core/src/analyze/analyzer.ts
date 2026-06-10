import type { ModelResolver, PricingSnapshot } from "@routecast/pricing";

export type Severity = "info" | "recommendation" | "warning" | "critical";
export type Confidence = "high" | "medium" | "low";

export interface Finding {
  analyzer: "forecast" | "routing" | "reasoning" | "cache" | "cliffs" | "pipeline";
  severity: Severity;
  title: string;
  /** Human paragraph that always shows the math behind any claim. */
  detail: string;
  estimatedMonthlySavingsUsd?: number;
  confidence: Confidence;
  /** Structured payload for renderers and MCP consumers. */
  data: Record<string, unknown>;
}

export interface AnalyzerContext {
  snapshot: PricingSnapshot;
  resolver: ModelResolver;
  /** Injected for deterministic tests. */
  now: Date;
  window: { from: Date; to: Date };
}

export const severityRank: Record<Severity, number> = {
  critical: 0,
  warning: 1,
  recommendation: 2,
  info: 3,
};

export const usd = (n: number): string =>
  n >= 100 ? `$${Math.round(n).toLocaleString("en-US")}` : `$${n.toFixed(2)}`;

/** Scale a windowed total to a 30-day month. */
export function monthlyRate(windowTotal: number, window: { from: Date; to: Date }): number {
  const days = Math.max(1, (window.to.getTime() - window.from.getTime()) / 86_400_000);
  return (windowTotal / days) * 30;
}
