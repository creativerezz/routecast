#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import {
  detectSources,
  EventStore,
  ingestClaudeCode,
  ingestGenericJsonl,
  ingestOtlpFile,
  type Report,
  rankCandidates,
  renderMarkdown,
  runAnalysis,
  type UsageEvent,
} from "@routecast/core";
import {
  blendedPerMtok,
  computeCost,
  defaultResolver,
  defaultSnapshot,
  STALENESS_THRESHOLD_DAYS,
  snapshotAgeDays,
  type WorkloadType,
  workloadTypes,
} from "@routecast/pricing";
import { Command } from "commander";
import pc from "picocolors";
import { renderTerminal, usd } from "./render/terminal.js";

const program = new Command();

function parseSince(value: string): number {
  const match = /^(\d+)d?$/.exec(value.trim());
  if (!match?.[1]) throw new Error(`invalid --since "${value}" — use e.g. 7d, 30d, 90`);
  return Number(match[1]);
}

async function gatherEvents(opts: {
  windowDays: number;
  dir?: string;
  quiet?: boolean;
}): Promise<UsageEvent[]> {
  const since = new Date(Date.now() - opts.windowDays * 86_400_000);
  const events: UsageEvent[] = [];

  const store = new EventStore();
  const stored = await store.readAll();
  events.push(...stored);

  if (opts.dir) {
    const { events: ev, stats } = await ingestClaudeCode(opts.dir, { since });
    events.push(...ev);
    if (!opts.quiet)
      console.error(
        pc.dim(
          `scanned ${stats.files} files (${stats.lines.toLocaleString("en-US")} lines) in ${opts.dir} → ${ev.length.toLocaleString("en-US")} events${stats.skippedLines ? `, ${stats.skippedLines} lines skipped` : ""}`,
        ),
      );
  } else {
    for (const source of await detectSources()) {
      const { events: ev, stats } = await ingestClaudeCode(source.path, { since });
      events.push(...ev);
      if (!opts.quiet)
        console.error(
          pc.dim(
            `auto-detected ${source.description}: ${stats.files} files → ${ev.length.toLocaleString("en-US")} events${stats.skippedLines ? `, ${stats.skippedLines} lines skipped` : ""}`,
          ),
        );
    }
  }
  return events;
}

interface AnalyzeFlags {
  since: string;
  dir?: string;
  json?: boolean;
  md?: boolean;
  verbose?: boolean;
  maxIqDrop: string;
}

async function buildReport(flags: AnalyzeFlags): Promise<Report> {
  const windowDays = parseSince(flags.since);
  const quiet = Boolean(flags.json || flags.md);
  const events = await gatherEvents({ windowDays, dir: flags.dir, quiet });
  return runAnalysis(events, {
    windowDays,
    maxIntelligenceDrop: Number(flags.maxIqDrop),
  });
}

function emit(report: Report, flags: AnalyzeFlags) {
  if (flags.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else if (flags.md) process.stdout.write(`${renderMarkdown(report)}\n`);
  else process.stdout.write(`${renderTerminal(report, { verbose: flags.verbose })}\n`);
}

const withAnalyzeFlags = (cmd: Command) =>
  cmd
    .option("--since <window>", "analysis window, e.g. 7d / 30d / 90d", "30d")
    .option("--dir <path>", "Claude Code projects dir (default: auto-detect ~/.claude/projects)")
    .option("--json", "emit the full report as JSON")
    .option("--md", "emit the report as markdown")
    .option("--verbose", "show the math behind each finding")
    .option("--max-iq-drop <points>", "Intelligence Index drop tolerated by routing recs", "5");

program
  .name("routecast")
  .description(
    "The cost intelligence layer for AI agents — an analyzer, not a gateway.\n" +
      "Zero-config: `npx routecast analyze` reads your local Claude Code logs.",
  )
  .version("0.1.0");

withAnalyzeFlags(
  program
    .command("analyze", { isDefault: true })
    .description("ingest local usage data and print the full cost-intelligence report"),
).action(async (flags: AnalyzeFlags) => {
  emit(await buildReport(flags), flags);
});

withAnalyzeFlags(
  program.command("forecast").description("month-end spend projection with p50/p90/p99 bands"),
).action(async (flags: AnalyzeFlags) => {
  const report = await buildReport(flags);
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(report.forecast, null, 2)}\n`);
    return;
  }
  const f = report.forecast;
  console.log("");
  console.log(`${pc.bold(pc.cyan(`⚡ forecast ${f.month}`))}  ${pc.dim(`(mtd ${usd(f.mtdUsd)})`)}`);
  console.log(`  p50  ${pc.bold(usd(f.monthEndUsdP50))}`);
  console.log(`  p90  ${usd(f.monthEndUsdP90)}`);
  console.log(`  p99  ${usd(f.monthEndUsdP99)}`);
  console.log(
    pc.dim(
      `  method: ${f.method} · ${f.daysObserved} days observed · daily p50 ${usd(f.dailyUsdP50)}`,
    ),
  );
  console.log("");
});

withAnalyzeFlags(
  program.command("recommend").description("routing recommendations only (small-first cascade)"),
).action(async (flags: AnalyzeFlags) => {
  const report = await buildReport(flags);
  const recs = report.findings.filter((f) => f.analyzer === "routing");
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(recs, null, 2)}\n`);
    return;
  }
  console.log("");
  if (recs.length === 0) {
    console.log(pc.dim("no routing recommendations — traffic already on cost-appropriate models"));
  }
  for (const r of recs) {
    console.log(`${pc.green("✦")} ${pc.bold(r.title)}`);
    console.log(pc.dim(`   ${r.detail}`));
    console.log("");
  }
});

program
  .command("estimate")
  .description("estimate the cost of a hypothetical request against the pricing matrix")
  .requiredOption("-m, --model <model>", "model id or matrix key")
  .requiredOption("-i, --input <tokens>", "uncached input tokens")
  .requiredOption("-o, --output <tokens>", "output tokens")
  .option("--reasoning <tokens>", "reasoning/thinking tokens", "0")
  .option("--cache-read <tokens>", "cached input tokens (hits)", "0")
  .option("--cache-write <tokens>", "cache write tokens", "0")
  .option("--batch", "apply the provider batch discount")
  .action((flags) => {
    const entry = defaultResolver.byKey(flags.model) ?? defaultResolver.resolve(flags.model);
    if (!entry) {
      console.error(pc.red(`unknown model "${flags.model}" — see \`routecast models\``));
      process.exitCode = 1;
      return;
    }
    const cost = computeCost(entry, {
      inputTokens: Number(flags.input),
      outputTokens: Number(flags.output),
      reasoningTokens: Number(flags.reasoning),
      cacheReadTokens: Number(flags.cacheRead),
      cacheWriteTokens: Number(flags.cacheWrite),
      batch: Boolean(flags.batch),
    });
    console.log("");
    console.log(`${pc.bold(entry.displayName)} ${pc.dim(`(${entry.key})`)}`);
    console.log(`  input        ${usd(cost.inputUsd)}`);
    if (cost.cacheReadUsd > 0) console.log(`  cache read   ${usd(cost.cacheReadUsd)}`);
    if (cost.cacheWriteUsd > 0) console.log(`  cache write  ${usd(cost.cacheWriteUsd)}`);
    console.log(`  output       ${usd(cost.outputUsd)}`);
    if (cost.reasoningUsd > 0) console.log(`  reasoning    ${usd(cost.reasoningUsd)}`);
    console.log(
      `  ${pc.bold(`total        ${usd(cost.totalUsd)}`)}${cost.batchApplied ? pc.dim(" (batch)") : ""}`,
    );
    if (cost.tierIndex > 0) {
      console.log(
        pc.yellow(
          `  ⚠ priced at tier ${cost.tierIndex + 1}: prompt of ${cost.promptTokens.toLocaleString("en-US")} tokens crossed a pricing cliff`,
        ),
      );
    }
    console.log("");
  });

program
  .command("models")
  .description("print the pricing/capability matrix")
  .option("--workload <type>", `rank for a workload (${workloadTypes.join(", ")})`)
  .option("--json", "emit as JSON")
  .action((flags) => {
    if (flags.json) {
      process.stdout.write(`${JSON.stringify(defaultSnapshot, null, 2)}\n`);
      return;
    }
    const age = snapshotAgeDays(defaultSnapshot, new Date());
    console.log("");
    console.log(
      `${pc.bold(pc.cyan("⚡ pricing matrix"))} ${pc.dim(`as of ${defaultSnapshot.asOf} (${age}d old)`)}`,
    );
    if (age > STALENESS_THRESHOLD_DAYS) {
      console.log(
        pc.yellow(
          `  ⚠ stale: pricing moves at multi-week cadence — PR fresh prices to data/models.json`,
        ),
      );
    }
    console.log("");
    if (flags.workload) {
      const candidates = rankCandidates(defaultSnapshot.models, flags.workload as WorkloadType, {
        minFitness: 2,
      });
      for (const c of candidates) {
        console.log(
          `  ${c.displayName.padEnd(24)} ${`$${c.blendedPerMtok}/Mtok`.padStart(14)}  II ${String(c.intelligenceIndex ?? "—").padStart(3)}  fit ${c.fitness}/3${c.pricingConfidence === "estimated" ? pc.yellow("  ~est") : ""}`,
        );
      }
      console.log("");
      return;
    }
    const header = `  ${"model".padEnd(24)} ${"in $/M".padStart(8)} ${"out $/M".padStart(8)} ${"blend".padStart(8)}  ${"II".padStart(3)}  notes`;
    console.log(pc.dim(header));
    for (const m of defaultSnapshot.models) {
      const tier = m.tiers[0];
      if (!tier) continue;
      console.log(
        `  ${m.displayName.padEnd(24)} ${tier.inputPerMtok.toFixed(2).padStart(8)} ${tier.outputPerMtok.toFixed(2).padStart(8)} ${blendedPerMtok(m).toFixed(2).padStart(8)}  ${String(m.intelligenceIndex ?? "—").padStart(3)}  ${m.tiers.length > 1 ? pc.yellow("cliff ") : ""}${m.pricingConfidence === "estimated" ? pc.yellow("~est ") : ""}${pc.dim((m.notes ?? "").slice(0, 48))}`,
      );
    }
    console.log("");
  });

program
  .command("ingest")
  .description("ingest usage data into the local store (~/.routecast)")
  .argument("<source>", "claude-code | jsonl | otlp")
  .argument("[path]", "file path (jsonl/otlp) or directory (claude-code)")
  .option("--since <window>", "only ingest events newer than this", "90d")
  .action(async (source: string, file: string | undefined, flags: { since: string }) => {
    const since = new Date(Date.now() - parseSince(flags.since) * 86_400_000);
    let result: { events: UsageEvent[]; stats: { skippedLines: number } };
    if (source === "claude-code") {
      result = await ingestClaudeCode(file, { since });
    } else if (source === "jsonl" && file) {
      result = await ingestGenericJsonl(file, { since });
    } else if (source === "otlp" && file) {
      result = await ingestOtlpFile(file, { since });
    } else {
      console.error(pc.red("usage: routecast ingest <claude-code|jsonl|otlp> [path]"));
      process.exitCode = 1;
      return;
    }
    const store = new EventStore();
    const { written, duplicates } = await store.append(result.events);
    console.log(
      `ingested ${pc.bold(String(written))} events (${duplicates} duplicates skipped${result.stats.skippedLines ? `, ${result.stats.skippedLines} malformed lines` : ""}) → ~/.routecast/events`,
    );
  });

withAnalyzeFlags(
  program
    .command("report")
    .description("write the full report to a file")
    .option("--format <fmt>", "md | json", "md")
    .option("-o, --out <file>", "output path", "routecast-report.md"),
).action(async (flags: AnalyzeFlags & { format: string; out: string }) => {
  const report = await buildReport({ ...flags, json: true });
  const body = flags.format === "json" ? JSON.stringify(report, null, 2) : renderMarkdown(report);
  await writeFile(flags.out, body, "utf8");
  console.log(`wrote ${flags.out}`);
});

program
  .command("mcp")
  .description("start the Routecast MCP server on stdio (agents can query their own costs)")
  .action(async () => {
    const { startStdioServer } = await import("@routecast/mcp");
    await startStdioServer();
  });

program.parseAsync().catch((err) => {
  console.error(pc.red(String(err?.message ?? err)));
  process.exit(1);
});
