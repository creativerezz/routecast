import { access } from "node:fs/promises";
import { defaultClaudeCodeDir } from "./claude-code.js";

export interface DetectedSource {
  type: "claude-code";
  path: string;
  description: string;
}

/** Auto-detect local usage-data sources for the zero-config `routecast analyze` path. */
export async function detectSources(): Promise<DetectedSource[]> {
  const sources: DetectedSource[] = [];
  const claudeDir = defaultClaudeCodeDir();
  try {
    await access(claudeDir);
    sources.push({
      type: "claude-code",
      path: claudeDir,
      description: "Claude Code session transcripts",
    });
  } catch {
    // not present
  }
  return sources;
}
