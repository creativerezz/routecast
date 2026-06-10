import type { UsageEvent } from "../events/schema.js";

export interface IngestStats {
  files: number;
  lines: number;
  /** Lines that looked relevant but could not be parsed — reported, never fatal. */
  skippedLines: number;
}

export interface IngestResult {
  events: UsageEvent[];
  stats: IngestStats;
}

export interface IngestOptions {
  /** Only emit events at or after this time. */
  since?: Date;
}
