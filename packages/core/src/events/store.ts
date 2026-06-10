import { createReadStream } from "node:fs";
import { appendFile, mkdir, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { type UsageEvent, usageEventSchema } from "./schema.js";

export const defaultStoreDir = () => path.join(homedir(), ".routecast", "events");

const monthOf = (ts: string) => ts.slice(0, 7); // "2026-06"

async function readJsonlEvents(file: string): Promise<UsageEvent[]> {
  const events: UsageEvent[] = [];
  const rl = readline.createInterface({
    input: createReadStream(file, "utf8"),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      events.push(usageEventSchema.parse(JSON.parse(line)));
    } catch {
      // Skip malformed lines — never crash on a bad log entry.
    }
  }
  return events;
}

/**
 * Append-only JSONL store under ~/.routecast/events, one file per month,
 * deduplicated by event id.
 */
export class EventStore {
  constructor(private readonly dir: string = defaultStoreDir()) {}

  async append(events: UsageEvent[]): Promise<{ written: number; duplicates: number }> {
    await mkdir(this.dir, { recursive: true });
    const existing = new Set((await this.readAll()).map((e) => e.id));
    const byMonth = new Map<string, UsageEvent[]>();
    let duplicates = 0;
    for (const event of events) {
      if (existing.has(event.id)) {
        duplicates++;
        continue;
      }
      existing.add(event.id);
      const month = monthOf(event.ts);
      const bucket = byMonth.get(month) ?? [];
      bucket.push(event);
      byMonth.set(month, bucket);
    }
    let written = 0;
    for (const [month, bucket] of byMonth) {
      const file = path.join(this.dir, `events-${month}.jsonl`);
      await appendFile(file, `${bucket.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8");
      written += bucket.length;
    }
    return { written, duplicates };
  }

  async readAll(): Promise<UsageEvent[]> {
    let files: string[];
    try {
      files = (await readdir(this.dir)).filter((f) => f.endsWith(".jsonl"));
    } catch {
      return [];
    }
    const events: UsageEvent[] = [];
    for (const file of files.sort()) {
      events.push(...(await readJsonlEvents(path.join(this.dir, file))));
    }
    return events;
  }
}
