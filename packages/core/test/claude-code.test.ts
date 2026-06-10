import path from "node:path";
import { ingestClaudeCode } from "@routecast/core";
import { describe, expect, it } from "vitest";

const fixtureDir = path.join(import.meta.dirname, "fixtures", "claude-code");

describe("ingestClaudeCode", () => {
  it("parses transcripts, merges requestId lines, estimates reasoning, skips junk", async () => {
    const { events, stats } = await ingestClaudeCode(fixtureDir);

    expect(stats.files).toBe(1);
    expect(stats.skippedLines).toBe(1); // the broken JSON line

    // req_1 (merged across two lines) + req_3 (unknown model). <synthetic> dropped.
    expect(events).toHaveLength(2);

    const merged = events.find((e) => e.model.startsWith("claude-sonnet"));
    expect(merged).toBeDefined();
    expect(merged?.tokens.input).toBe(100);
    expect(merged?.tokens.cacheRead).toBe(5000);
    expect(merged?.tokens.cacheWrite).toBe(2000);
    // 800 thinking chars → 200 estimated reasoning tokens; output max(300,350)=350 → 150 visible.
    expect(merged?.tokens.reasoning).toBe(200);
    expect(merged?.tokens.reasoningEstimated).toBe(true);
    expect(merged?.tokens.output).toBe(150);
    expect(merged?.feature).toBe("acme-app");
    expect(merged?.session).toBe("s1");

    const unknown = events.find((e) => e.model === "mystery-model-1");
    expect(unknown).toBeDefined();
  });

  it("returns empty for a missing directory instead of throwing", async () => {
    const { events, stats } = await ingestClaudeCode("/nonexistent/path");
    expect(events).toHaveLength(0);
    expect(stats.files).toBe(0);
  });
});
