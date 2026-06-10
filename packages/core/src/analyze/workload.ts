import type { WorkloadType } from "@routecast/pricing";
import type { UsageEvent } from "../events/schema.js";

/**
 * Heuristic workload classification from token shape and session density.
 * Documented honesty rule: this is a heuristic — routing findings derived from
 * it carry confidence levels, never certainty.
 */
export function classifyWorkload(event: UsageEvent, sessionCallCount: number): WorkloadType {
  const t = event.tokens;
  const prompt = t.input + t.cacheRead + t.cacheWrite;

  // Many calls in one session = an agent loop (tool calling, multi-turn autonomy).
  if (sessionCallCount >= 5) return "agentic-loop";
  if (prompt >= 20_000 && t.output <= 3_000) return "summarization";
  if (prompt >= 32_000) return "rag-long";
  if (prompt >= 3_000) return "rag-short";
  if (t.output <= 400) return "extraction";
  return "chat";
}

export function sessionCallCounts(events: UsageEvent[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const e of events) {
    if (!e.session) continue;
    counts.set(e.session, (counts.get(e.session) ?? 0) + 1);
  }
  return counts;
}
