import {
  defaultResolver,
  defaultSnapshot,
  normalizeModelId,
  pricingSnapshotSchema,
} from "@routecast/pricing";
import { describe, expect, it } from "vitest";

describe("normalizeModelId", () => {
  it("strips Bedrock/Vertex/gateway prefixes and bracket suffixes", () => {
    expect(normalizeModelId("us.anthropic.claude-haiku-4-5-20251001-v1:0")).toBe(
      "claude-haiku-4-5-20251001-v1",
    );
    expect(normalizeModelId("models/gemini-3.1-pro-preview")).toBe("gemini-3.1-pro-preview");
    expect(normalizeModelId("anthropic/claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
    expect(normalizeModelId("claude-fable-5[1m]")).toBe("claude-fable-5");
  });
});

describe("defaultResolver", () => {
  it.each([
    ["claude-sonnet-4-6-20250929", "anthropic/claude-sonnet-4-6"],
    ["claude-opus-4-7", "anthropic/claude-opus-4-7"],
    ["claude-haiku-4-5-20251001", "anthropic/claude-haiku-4-5"],
    ["claude-fable-5[1m]", "anthropic/claude-fable-5"],
    ["gpt-5.5-2026-04-23", "openai/gpt-5-5"],
    ["gpt-5.4-mini", "openai/gpt-5-4-mini"],
    ["gemini-3.1-pro-preview", "google/gemini-3-1-pro"],
    ["us.amazon.nova-micro-v1:0", "amazon/nova-micro"],
    ["deepseek-chat", "deepseek/deepseek-v4-flash"],
  ])("resolves %s → %s", (raw, key) => {
    expect(defaultResolver.resolve(raw)?.key).toBe(key);
  });

  it("returns null for unknown models instead of guessing", () => {
    expect(defaultResolver.resolve("totally-new-model-9000")).toBeNull();
  });

  it("does not let gpt-5.4 aliases swallow mini/nano variants", () => {
    expect(defaultResolver.resolve("gpt-5.4")?.key).toBe("openai/gpt-5-4");
    expect(defaultResolver.resolve("gpt-5.4-nano")?.key).toBe("openai/gpt-5-4-nano");
  });
});

describe("bundled data", () => {
  it("models.json passes schema + invariants", () => {
    expect(() => pricingSnapshotSchema.parse(defaultSnapshot)).not.toThrow();
    expect(defaultSnapshot.models.length).toBeGreaterThanOrEqual(20);
  });
});
