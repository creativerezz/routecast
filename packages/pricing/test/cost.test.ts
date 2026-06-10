import { blendedPerMtok, computeCost, defaultResolver } from "@routecast/pricing";
import { describe, expect, it } from "vitest";

const model = (key: string) => {
  const m = defaultResolver.byKey(key);
  if (!m) throw new Error(`missing model ${key}`);
  return m;
};

describe("computeCost", () => {
  it("prices a plain Sonnet 4.6 request ($3/$15)", () => {
    const cost = computeCost(model("anthropic/claude-sonnet-4-6"), {
      inputTokens: 1_000_000,
      outputTokens: 100_000,
    });
    expect(cost.inputUsd).toBeCloseTo(3.0, 6);
    expect(cost.outputUsd).toBeCloseTo(1.5, 6);
    expect(cost.totalUsd).toBeCloseTo(4.5, 6);
    expect(cost.tierIndex).toBe(0);
  });

  it("bills Anthropic cache reads at 10% and writes at 125% of input", () => {
    const cost = computeCost(model("anthropic/claude-opus-4-7"), {
      inputTokens: 100_000,
      cacheReadTokens: 800_000,
      cacheWriteTokens: 100_000,
      outputTokens: 0,
    });
    // input: 0.1M * $5 = $0.50; reads: 0.8M * $5 * 0.1 = $0.40; writes: 0.1M * $5 * 1.25 = $0.625
    expect(cost.inputUsd).toBeCloseTo(0.5, 6);
    expect(cost.cacheReadUsd).toBeCloseTo(0.4, 6);
    expect(cost.cacheWriteUsd).toBeCloseTo(0.625, 6);
    expect(cost.totalUsd).toBeCloseTo(1.525, 6);
  });

  it("reprices the WHOLE request when Gemini 3.1 Pro crosses the 200K cliff", () => {
    const below = computeCost(model("google/gemini-3-1-pro"), {
      inputTokens: 200_000,
      outputTokens: 1_000,
    });
    expect(below.tierIndex).toBe(0);
    expect(below.inputUsd).toBeCloseTo(0.2 * 2.0, 6); // 0.2M * $2

    const above = computeCost(model("google/gemini-3-1-pro"), {
      inputTokens: 250_000,
      outputTokens: 1_000,
    });
    expect(above.tierIndex).toBe(1);
    expect(above.inputUsd).toBeCloseTo(0.25 * 4.0, 6); // ALL 250K at $4
    expect(above.outputUsd).toBeCloseTo(0.001 * 18.0, 6);
  });

  it("selects the GPT-5.5 272K tier using total prompt size including cache", () => {
    const cost = computeCost(model("openai/gpt-5-5"), {
      inputTokens: 50_000,
      cacheReadTokens: 250_000, // prompt = 300K > 272K
      outputTokens: 10_000,
    });
    expect(cost.tierIndex).toBe(1);
    expect(cost.inputUsd).toBeCloseTo(0.05 * 10.0, 6);
    expect(cost.cacheReadUsd).toBeCloseTo(0.25 * 10.0 * 0.1, 6);
    expect(cost.outputUsd).toBeCloseTo(0.01 * 45.0, 6);
  });

  it("bills reasoning tokens at the output rate", () => {
    const cost = computeCost(model("anthropic/claude-opus-4-7"), {
      inputTokens: 10_000,
      outputTokens: 2_000,
      reasoningTokens: 8_000,
    });
    expect(cost.outputUsd).toBeCloseTo(0.002 * 25, 6);
    expect(cost.reasoningUsd).toBeCloseTo(0.008 * 25, 6);
  });

  it("applies the 50% batch discount across all components", () => {
    const plain = computeCost(model("anthropic/claude-haiku-4-5"), {
      inputTokens: 1_000_000,
      outputTokens: 200_000,
    });
    const batched = computeCost(model("anthropic/claude-haiku-4-5"), {
      inputTokens: 1_000_000,
      outputTokens: 200_000,
      batch: true,
    });
    expect(batched.totalUsd).toBeCloseTo(plain.totalUsd / 2, 6);
    expect(batched.batchApplied).toBe(true);
  });

  it("ignores batch for models without a batch API (Grok)", () => {
    const cost = computeCost(model("xai/grok-4-1-fast"), {
      inputTokens: 1_000_000,
      outputTokens: 0,
      batch: true,
    });
    expect(cost.batchApplied).toBe(false);
    expect(cost.inputUsd).toBeCloseTo(0.2, 6);
  });
});

describe("blendedPerMtok", () => {
  it("matches the report's 3:1 blended figures", () => {
    expect(blendedPerMtok(model("anthropic/claude-opus-4-7"))).toBeCloseTo(10.0, 2);
    expect(blendedPerMtok(model("anthropic/claude-sonnet-4-6"))).toBeCloseTo(6.0, 2);
    expect(blendedPerMtok(model("anthropic/claude-haiku-4-5"))).toBeCloseTo(2.0, 2);
    expect(blendedPerMtok(model("deepseek/deepseek-v4-flash"))).toBeCloseTo(0.175, 2);
  });
});
