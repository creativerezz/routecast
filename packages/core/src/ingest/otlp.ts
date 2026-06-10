import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { UsageEvent } from "../events/schema.js";
import type { IngestOptions, IngestResult } from "./adapter.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 24);

type AttrValue = { stringValue?: string; intValue?: string | number; doubleValue?: number };

function attrsToMap(attrs: Array<{ key: string; value?: AttrValue }> | undefined) {
  const map = new Map<string, string | number>();
  for (const a of attrs ?? []) {
    const v = a.value;
    if (!v) continue;
    if (v.stringValue !== undefined) map.set(a.key, v.stringValue);
    else if (v.intValue !== undefined) map.set(a.key, Number(v.intValue));
    else if (v.doubleValue !== undefined) map.set(a.key, v.doubleValue);
  }
  return map;
}

const num = (m: Map<string, string | number>, ...keys: string[]): number => {
  for (const k of keys) {
    const v = m.get(k);
    if (typeof v === "number") return v;
    if (typeof v === "string" && v !== "" && !Number.isNaN(Number(v))) return Number(v);
  }
  return 0;
};
const str = (m: Map<string, string | number>, ...keys: string[]): string | undefined => {
  for (const k of keys) {
    const v = m.get(k);
    if (typeof v === "string" && v) return v;
  }
  return undefined;
};

/**
 * Ingest an OTLP/JSON trace export containing GenAI semantic-convention spans
 * (OpenLLMetry / OpenTelemetry gen_ai.* attributes).
 */
export async function ingestOtlpFile(
  file: string,
  opts: IngestOptions = {},
): Promise<IngestResult> {
  const stats = { files: 1, lines: 0, skippedLines: 0 };
  const events: UsageEvent[] = [];

  let doc: any;
  try {
    doc = JSON.parse(await readFile(file, "utf8"));
  } catch {
    stats.skippedLines++;
    return { events, stats };
  }

  for (const rs of doc?.resourceSpans ?? []) {
    for (const ss of rs?.scopeSpans ?? []) {
      for (const span of ss?.spans ?? []) {
        stats.lines++;
        try {
          const attrs = attrsToMap(span.attributes);
          const model = str(attrs, "gen_ai.response.model", "gen_ai.request.model");
          if (!model) {
            stats.skippedLines++;
            continue;
          }
          const input = num(attrs, "gen_ai.usage.input_tokens", "gen_ai.usage.prompt_tokens");
          const output = num(attrs, "gen_ai.usage.output_tokens", "gen_ai.usage.completion_tokens");
          const startNano = Number(span.startTimeUnixNano ?? 0);
          const ts = new Date(startNano / 1e6).toISOString();
          if (opts.since && new Date(ts).getTime() < opts.since.getTime()) continue;
          const costUsd = num(attrs, "gen_ai.usage.cost") || null;
          events.push({
            id: sha(`otlp:${span.traceId ?? file}:${span.spanId ?? stats.lines}`),
            ts,
            provider: str(attrs, "gen_ai.system") ?? "other",
            model,
            tokens: {
              input,
              cacheRead: num(attrs, "gen_ai.usage.cache_read_input_tokens"),
              cacheWrite: num(attrs, "gen_ai.usage.cache_creation_input_tokens"),
              output,
              reasoning: num(attrs, "gen_ai.usage.reasoning_tokens"),
              reasoningEstimated: false,
            },
            costUsd,
            status: "ok",
            feature: str(attrs, "service.name") ?? span.name,
            session: str(attrs, "gen_ai.conversation.id", "session.id"),
            source: "otlp",
          });
        } catch {
          stats.skippedLines++;
        }
      }
    }
  }
  return { events, stats };
}
