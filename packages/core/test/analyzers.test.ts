import { runAnalysis, type UsageEvent } from "@routecast/core";
import { pricingSnapshotSchema } from "@routecast/pricing";
import { describe, expect, it } from "vitest";

const NOW = new Date("2026-06-15T12:00:00Z");

let counter = 0;
function event(partial: {
  ts: string;
  model: string;
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
  output?: number;
  reasoning?: number;
  feature?: string;
  session?: string;
}): UsageEvent {
  return {
    id: `evt-${counter++}`,
    ts: partial.ts,
    provider: "test",
    model: partial.model,
    tokens: {
      input: partial.input ?? 0,
      cacheRead: partial.cacheRead ?? 0,
      cacheWrite: partial.cacheWrite ?? 0,
      output: partial.output ?? 0,
      reasoning: partial.reasoning ?? 0,
      reasoningEstimated: false,
    },
    costUsd: null,
    status: "ok",
    feature: partial.feature,
    session: partial.session,
    source: "test",
  };
}

describe("forecast analyzer", () => {
  it("computes empirical p50/p90/p99 month-end bands from ≥10 observed days", () => {
    // 12 days in June, $10/day (1M output tokens on Haiku 4.5 at $5/M out + 1M in at $1/M... keep simple: use input only)
    const events: UsageEvent[] = [];
    for (let day = 1; day <= 12; day++) {
      events.push(
        event({
          ts: `2026-06-${String(day).padStart(2, "0")}T08:00:00Z`,
          model: "claude-haiku-4-5",
          input: 10_000_000, // $10 at $1/Mtok
        }),
      );
    }
    const report = runAnalysis(events, { now: NOW, windowDays: 30 });
    expect(report.forecast.method).toBe("empirical");
    expect(report.forecast.daysObserved).toBe(12);
    expect(report.forecast.mtdUsd).toBeCloseTo(120, 1);
    // flat $10/day burn → all quantiles equal → month end = 120 + 15 remaining days * 10
    expect(report.forecast.monthEndUsdP50).toBeCloseTo(270, 0);
    expect(report.forecast.monthEndUsdP90).toBeCloseTo(270, 0);
  });

  it("falls back to report heuristic multipliers below 10 observed days", () => {
    const events = [
      event({ ts: "2026-06-14T08:00:00Z", model: "claude-haiku-4-5", input: 10_000_000 }),
    ];
    const report = runAnalysis(events, { now: NOW, windowDays: 30 });
    expect(report.forecast.method).toBe("heuristic");
    // p90 daily = 2x input-class median = $20/day
    expect(report.forecast.monthEndUsdP90).toBeCloseTo(10 + 15 * 20, 0);
  });
});

describe("routing analyzer", () => {
  it("recommends a cheaper fit model for extraction traffic on Sonnet", () => {
    const events: UsageEvent[] = [];
    for (let i = 0; i < 200; i++) {
      events.push(
        event({
          ts: "2026-06-14T08:00:00Z",
          model: "claude-sonnet-4-6",
          input: 2_000,
          output: 200, // extraction shape: tiny output, small prompt
          feature: "support",
        }),
      );
    }
    const report = runAnalysis(events, { now: NOW, windowDays: 30 });
    const rec = report.findings.find((f) => f.analyzer === "routing");
    expect(rec).toBeDefined();
    expect(rec?.data.from).toBe("anthropic/claude-sonnet-4-6");
    // Cheapest extraction-fit model within 5 II points of Sonnet (52): DeepSeek V4 Flash (II 47).
    expect(rec?.data.to).toBe("deepseek/deepseek-v4-flash");
    expect(rec?.estimatedMonthlySavingsUsd).toBeGreaterThan(1);
    expect(rec?.detail).toContain("Intelligence Index");
  });
});

describe("reasoning analyzer", () => {
  it("flags models where thinking dominates output spend", () => {
    const events = [
      event({
        ts: "2026-06-14T08:00:00Z",
        model: "claude-opus-4-7",
        input: 10_000,
        output: 2_000,
        reasoning: 8_000,
      }),
    ];
    const report = runAnalysis(events, { now: NOW, windowDays: 30 });
    const info = report.findings.find((f) => f.analyzer === "reasoning" && f.severity === "info");
    expect(info?.title).toContain("80%");
    const rec = report.findings.find(
      (f) => f.analyzer === "reasoning" && f.severity === "recommendation",
    );
    expect(rec).toBeUndefined(); // only $0.20 of reasoning — below the $1 floor
  });
});

describe("cache analyzer", () => {
  it("detects repeated large uncached prompts as a cache opportunity", () => {
    const events: UsageEvent[] = [];
    for (let i = 0; i < 20; i++) {
      events.push(
        event({
          ts: "2026-06-14T08:00:00Z",
          model: "claude-sonnet-4-6",
          input: 60_000,
          output: 500,
          feature: "rag-api",
        }),
      );
    }
    const report = runAnalysis(events, { now: NOW, windowDays: 30 });
    const rec = report.findings.find((f) => f.analyzer === "cache");
    expect(rec).toBeDefined();
    expect(rec?.severity).toBe("recommendation");
    expect(rec?.title).toContain("rag-api");
    expect(rec?.data.assumedCacheableShare).toBe(0.5);
  });

  it("reports realized savings when cache reads are present", () => {
    const events = [
      event({
        ts: "2026-06-14T08:00:00Z",
        model: "claude-sonnet-4-6",
        input: 1_000,
        cacheRead: 5_000_000,
        output: 500,
      }),
    ];
    const report = runAnalysis(events, { now: NOW, windowDays: 30 });
    const info = report.findings.find((f) => f.analyzer === "cache" && f.severity === "info");
    expect(info?.title).toContain("already saving");
    expect(report.totals.cacheSavedUsd).toBeCloseTo(5 * 3 * 0.9, 1); // 5M * $3/M * 90% off
  });
});

describe("cliffs analyzer", () => {
  it("quantifies the Gemini 200K cliff surcharge", () => {
    const events = [
      event({
        ts: "2026-06-14T08:00:00Z",
        model: "gemini-3.1-pro",
        input: 300_000,
        output: 1_000,
      }),
    ];
    const report = runAnalysis(events, { now: NOW, windowDays: 30 });
    const warn = report.findings.find((f) => f.analyzer === "cliffs" && f.severity === "warning");
    expect(warn).toBeDefined();
    expect(warn?.title).toContain("200K");
    // surcharge: input 0.3M*($4-$2) + output 0.001M*($18-$12) = $0.606
    expect(warn?.data.surchargeUsd).toBeCloseTo(0.61, 1);
  });

  it("escalates deprecation warnings inside 30 days", () => {
    const snapshot = pricingSnapshotSchema.parse({
      asOf: "2026-06-01",
      version: "test",
      models: [
        {
          key: "test/old-model",
          provider: "other",
          displayName: "Old Model",
          aliases: ["old-model*"],
          contextWindow: 100_000,
          tiers: [{ upToContextTokens: null, inputPerMtok: 1, outputPerMtok: 5 }],
          cache: null,
          reasoningBilledAs: "none",
          deprecation: { retiresOn: "2026-07-01" },
        },
      ],
    });
    const events = [
      event({ ts: "2026-06-14T08:00:00Z", model: "old-model", input: 1_000, output: 100 }),
    ];
    const report = runAnalysis(events, { now: NOW, windowDays: 30, snapshot });
    const dep = report.findings.find((f) => f.title.includes("retires"));
    expect(dep?.severity).toBe("critical"); // 16 days out
  });
});

describe("pipeline", () => {
  it("surfaces unknown models as an undercount warning, never silently", () => {
    const events = [
      event({ ts: "2026-06-14T08:00:00Z", model: "mystery-9000", input: 1_000_000, output: 1_000 }),
    ];
    const report = runAnalysis(events, { now: NOW, windowDays: 30 });
    expect(report.totals.costUsd).toBe(0);
    const warn = report.findings.find((f) => f.analyzer === "pipeline");
    expect(warn?.title).toContain("missing from the pricing matrix");
    expect(warn?.detail).toContain("mystery-9000");
  });

  it("warns when the pricing snapshot is stale", () => {
    const events = [
      event({ ts: "2026-06-14T08:00:00Z", model: "claude-haiku-4-5", input: 1_000, output: 100 }),
    ];
    // Bundled snapshot is asOf 2026-04-28; at NOW (June 15) that's 48 days — past the 45-day threshold.
    const report = runAnalysis(events, { now: NOW, windowDays: 30 });
    const stale = report.findings.find((f) => f.title.includes("days old"));
    expect(stale).toBeDefined();
  });
});
