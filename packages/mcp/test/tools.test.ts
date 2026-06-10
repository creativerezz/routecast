import {
  checkPricingCliffTool,
  estimateCostTool,
  recommendModelTool,
  windowDaysOf,
} from "@routecast/mcp";
import { describe, expect, it } from "vitest";

describe("estimate_cost tool", () => {
  it("estimates a Sonnet request with cache and reasoning", () => {
    const result = estimateCostTool({
      model: "claude-sonnet-4-6",
      input_tokens: 10_000,
      output_tokens: 2_000,
      reasoning_tokens: 5_000,
      cached_input_tokens: 50_000,
    });
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.model).toBe("anthropic/claude-sonnet-4-6");
    expect(result.totalUsd).toBeCloseTo(0.01 * 3 + 0.05 * 3 * 0.1 + 0.002 * 15 + 0.005 * 15, 4);
    expect(result.crossedPricingCliff).toBe(false);
  });

  it("errors honestly on unknown models", () => {
    const result = estimateCostTool({ model: "nope-1", input_tokens: 1, output_tokens: 1 });
    expect("error" in result && result.error).toContain("unknown model");
  });
});

describe("recommend_model tool", () => {
  it("ranks extraction candidates cheapest-first with fitness ≥2", () => {
    const result = recommendModelTool({ workload: "extraction" });
    expect(result.candidates.length).toBeGreaterThan(3);
    const first = result.candidates[0];
    expect(first?.key).toBe("amazon/nova-micro"); // $0.06 blended, extraction fitness 3
    const prices = result.candidates.map((c) => c.blendedPerMtok);
    expect([...prices].sort((a, b) => a - b)).toEqual(prices);
  });

  it("filters by required context size", () => {
    const result = recommendModelTool({ workload: "rag-long", context_tokens: 500_000 });
    for (const c of result.candidates) {
      expect(c.key).not.toBe("anthropic/claude-haiku-4-5"); // 200K window
    }
  });
});

describe("check_pricing_cliff tool", () => {
  it("reports distance to the Gemini 200K cliff from below", () => {
    const result = checkPricingCliffTool({ model: "gemini-3.1-pro", context_tokens: 150_000 });
    if ("error" in result) throw new Error("unexpected error");
    expect(result.tierInEffect).toBe(0);
    expect(result.tokensUntilNextCliff).toBe(50_000);
  });

  it("reports the surcharge once over the cliff", () => {
    const result = checkPricingCliffTool({ model: "gemini-3.1-pro", context_tokens: 250_000 });
    if ("error" in result) throw new Error("unexpected error");
    expect(result.tierInEffect).toBe(1);
    expect(result.surchargeVsBaseTier).toBe(2);
    expect(result.advice).toContain("flat-priced");
  });
});

describe("windowDaysOf", () => {
  it("maps mtd to the current day of month", () => {
    expect(windowDaysOf("mtd", new Date("2026-06-15T12:00:00Z"))).toBe(15);
    expect(windowDaysOf("7d")).toBe(7);
  });
});
