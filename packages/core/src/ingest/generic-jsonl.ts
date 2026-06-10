import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import readline from "node:readline";
import { z } from "zod";
import type { UsageEvent } from "../events/schema.js";
import type { IngestOptions, IngestResult } from "./adapter.js";

/**
 * The documented bring-your-own-data format: one JSON object per line.
 * Minimum: a timestamp, a model, and token counts. See docs/architecture.md.
 */
const genericLineSchema = z.object({
  ts: z.string().optional(),
  timestamp: z.string().optional(),
  provider: z.string().optional(),
  model: z.string(),
  input_tokens: z.number().nonnegative().default(0),
  output_tokens: z.number().nonnegative().default(0),
  cache_read_tokens: z.number().nonnegative().default(0),
  cache_write_tokens: z.number().nonnegative().default(0),
  reasoning_tokens: z.number().nonnegative().default(0),
  cost_usd: z.number().optional(),
  latency_ms: z.number().optional(),
  feature: z.string().optional(),
  session: z.string().optional(),
  status: z.enum(["ok", "error", "unknown"]).default("ok"),
});

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 24);

export async function ingestGenericJsonl(
  file: string,
  opts: IngestOptions = {},
): Promise<IngestResult> {
  const stats = { files: 1, lines: 0, skippedLines: 0 };
  const events: UsageEvent[] = [];

  const rl = readline.createInterface({
    input: createReadStream(file, "utf8"),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  let lineNo = 0;
  for await (const line of rl) {
    lineNo++;
    if (!line.trim()) continue;
    stats.lines++;
    try {
      const row = genericLineSchema.parse(JSON.parse(line));
      const ts = row.ts ?? row.timestamp;
      if (!ts) throw new Error("missing ts/timestamp");
      if (opts.since && new Date(ts).getTime() < opts.since.getTime()) continue;
      events.push({
        id: sha(`generic:${file}:${lineNo}:${ts}:${row.model}`),
        ts,
        provider: row.provider ?? "other",
        model: row.model,
        tokens: {
          input: row.input_tokens,
          cacheRead: row.cache_read_tokens,
          cacheWrite: row.cache_write_tokens,
          output: row.output_tokens,
          reasoning: row.reasoning_tokens,
          reasoningEstimated: false,
        },
        costUsd: row.cost_usd ?? null,
        latencyMs: row.latency_ms,
        status: row.status,
        feature: row.feature,
        session: row.session,
        source: "generic-jsonl",
      });
    } catch {
      stats.skippedLines++;
    }
  }
  return { events, stats };
}
