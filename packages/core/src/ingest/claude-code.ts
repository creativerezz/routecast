import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import type { UsageEvent } from "../events/schema.js";
import type { IngestOptions, IngestResult } from "./adapter.js";

export const defaultClaudeCodeDir = () => path.join(homedir(), ".claude", "projects");

interface PendingRequest {
  ts: string;
  model: string;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  thinkingChars: number;
  feature?: string;
  session?: string;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 24);

/**
 * Ingest Claude Code session transcripts (~/.claude/projects/**\/*.jsonl).
 *
 * Each assistant line carries `message.usage` with cache-aware token counts.
 * Multiple lines can share one `requestId` (text + tool_use emitted separately),
 * so we aggregate per requestId per file: usage taken as the max, thinking-block
 * characters summed. Anthropic does not report a reasoning-token split, but the
 * transcript contains the thinking text — we estimate reasoning tokens at
 * chars/4 and flag them `reasoningEstimated`.
 */
export async function ingestClaudeCode(
  rootDir: string = defaultClaudeCodeDir(),
  opts: IngestOptions = {},
): Promise<IngestResult> {
  const stats = { files: 0, lines: 0, skippedLines: 0 };
  const events: UsageEvent[] = [];

  let entries: string[];
  try {
    entries = (await readdir(rootDir, { recursive: true })) as string[];
  } catch {
    return { events, stats };
  }

  const files = entries.filter((f) => f.endsWith(".jsonl")).map((f) => path.join(rootDir, f));

  for (const file of files) {
    try {
      const fileStat = await stat(file);
      // Cheap skip: file untouched since before the window.
      if (opts.since && fileStat.mtimeMs < opts.since.getTime()) continue;
    } catch {
      continue;
    }
    stats.files++;
    const pending = new Map<string, PendingRequest>();

    const rl = readline.createInterface({
      input: createReadStream(file, "utf8"),
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    let lineNo = 0;
    for await (const line of rl) {
      lineNo++;
      stats.lines++;
      // Fast pre-filter before paying for JSON.parse on every line.
      if (!line.includes('"assistant"') || !line.includes('"usage"')) continue;
      try {
        const entry = JSON.parse(line);
        if (entry?.type !== "assistant") continue;
        const usage = entry.message?.usage;
        const model: string | undefined = entry.message?.model;
        if (!usage || !model || model === "<synthetic>") continue;
        const ts: string = entry.timestamp ?? new Date(0).toISOString();
        if (opts.since && new Date(ts).getTime() < opts.since.getTime()) continue;

        const requestId: string = entry.requestId ?? `${path.basename(file)}:${lineNo}`;
        let thinkingChars = 0;
        const content = entry.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block?.type === "thinking" && typeof block.thinking === "string") {
              thinkingChars += block.thinking.length;
            }
          }
        }

        const existing = pending.get(requestId);
        if (existing) {
          existing.output = Math.max(existing.output, usage.output_tokens ?? 0);
          existing.thinkingChars += thinkingChars;
        } else {
          pending.set(requestId, {
            ts,
            model,
            input: usage.input_tokens ?? 0,
            cacheRead: usage.cache_read_input_tokens ?? 0,
            cacheWrite: usage.cache_creation_input_tokens ?? 0,
            output: usage.output_tokens ?? 0,
            thinkingChars,
            feature: typeof entry.cwd === "string" ? path.basename(entry.cwd) : undefined,
            session: typeof entry.sessionId === "string" ? entry.sessionId : undefined,
          });
        }
      } catch {
        stats.skippedLines++;
      }
    }

    for (const [requestId, r] of pending) {
      const reasoning = Math.round(r.thinkingChars / 4);
      const visibleOutput = Math.max(0, r.output - reasoning);
      events.push({
        id: sha(`claude-code:${requestId}`),
        ts: r.ts,
        provider: "anthropic",
        model: r.model,
        tokens: {
          input: r.input,
          cacheRead: r.cacheRead,
          cacheWrite: r.cacheWrite,
          output: visibleOutput,
          reasoning,
          reasoningEstimated: reasoning > 0,
        },
        costUsd: null,
        status: "ok",
        feature: r.feature,
        session: r.session,
        source: "claude-code",
      });
    }
  }

  return { events, stats };
}
