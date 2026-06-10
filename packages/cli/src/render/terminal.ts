import type { Finding, Report } from "@routecast/core";
import pc from "picocolors";

const usd = (n: number): string =>
  n >= 100 ? `$${Math.round(n).toLocaleString("en-US")}` : `$${n.toFixed(2)}`;

const pct = (part: number, total: number): string =>
  total > 0 ? `${Math.round((part / total) * 100)}%` : "0%";

const sevBadge: Record<Finding["severity"], string> = {
  critical: pc.red("●  critical "),
  warning: pc.yellow("▲  warning  "),
  recommendation: pc.green("✦  save     "),
  info: pc.dim("ℹ  info     "),
};

function wrap(text: string, width: number, indent: string): string {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line && line.length + word.length + 1 > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines.map((l) => indent + l).join("\n");
}

export function renderTerminal(report: Report, opts: { verbose?: boolean } = {}): string {
  const out: string[] = [];
  const t = report.totals;
  const f = report.forecast;
  const actionable = report.findings.filter((finding) => finding.severity !== "info");
  const signals = report.findings.filter(
    (finding) => finding.severity === "info" && finding.analyzer !== "forecast",
  );

  out.push("");
  out.push(`${pc.bold(pc.cyan("⚡ routecast"))} ${pc.dim("· cost intelligence for AI agents")}`);
  out.push(
    pc.dim(
      `DATA      ${t.events.toLocaleString("en-US")} events · ${report.window.days}d window · pricing ${report.pricing.asOf} (${report.pricing.ageDays}d old)`,
    ),
  );
  out.push("");
  out.push(
    `${pc.bold("SPEND")}     ${pc.bold(usd(t.costUsd))} total` +
      (t.cacheSavedUsd > 0 ? pc.green(` · ${usd(t.cacheSavedUsd)} cache saved`) : "") +
      (t.reasoningUsd > 0 ? pc.magenta(` · ${usd(t.reasoningUsd)} reasoning`) : ""),
  );
  out.push(
    `${pc.bold("FORECAST")}  ${f.month}  ` +
      `${pc.bold(usd(f.monthEndUsdP50))} p50 · ${usd(f.monthEndUsdP90)} p90 · ${usd(f.monthEndUsdP99)} p99` +
      pc.dim(`  (${f.method}, ${f.daysObserved}d observed)`),
  );
  out.push("");

  if (t.byModel.length > 0) {
    out.push(pc.bold("BREAKDOWN"));
    out.push(pc.dim("  Models"));
    const max = Math.max(...t.byModel.map((m) => m.costUsd), 0.01);
    for (const m of t.byModel) {
      const bar = "█".repeat(Math.max(1, Math.round((m.costUsd / max) * 24)));
      out.push(
        `  ${m.model.padEnd(26).slice(0, 26)} ${usd(m.costUsd).padStart(10)} ${pct(m.costUsd, t.costUsd).padStart(4)}  ${pc.cyan(bar)}`,
      );
    }
  }

  if (t.byFeature.length > 1) {
    out.push("");
    out.push(pc.dim("  Projects"));
    for (const feat of t.byFeature.slice(0, 8)) {
      out.push(
        `  ${feat.feature.padEnd(34).slice(0, 34)} ${usd(feat.costUsd).padStart(10)} ${pct(feat.costUsd, t.costUsd).padStart(4)}  ${pc.dim(`${feat.events.toLocaleString("en-US")} calls`)}`,
      );
    }
  }

  if (t.byWorkload.length > 1) {
    out.push("");
    out.push(pc.dim("  Workloads"));
    for (const workload of t.byWorkload.slice(0, 6)) {
      out.push(
        `  ${workload.workload.padEnd(34).slice(0, 34)} ${usd(workload.costUsd).padStart(10)} ${pct(workload.costUsd, t.costUsd).padStart(4)}  ${pc.dim(`${workload.events.toLocaleString("en-US")} calls`)}`,
      );
    }
  }

  if (t.byModel.length > 0 || t.byFeature.length > 1 || t.byWorkload.length > 1) out.push("");

  const savings = actionable.filter((finding) => finding.severity === "recommendation");
  const warnings = actionable.filter((finding) => finding.severity !== "recommendation");
  if (savings.length > 0) {
    out.push(pc.bold(`SAVINGS (${savings.length})`));
    for (const finding of savings) {
      const monthly =
        finding.estimatedMonthlySavingsUsd && !finding.title.includes("/mo")
          ? pc.green(pc.bold(` ${usd(finding.estimatedMonthlySavingsUsd)}/mo`))
          : "";
      out.push(` ${sevBadge[finding.severity]} ${pc.bold(finding.title)}${monthly}`);
      if (opts.verbose) {
        out.push(pc.dim(wrap(finding.detail, 90, "      ")));
        out.push("");
      }
    }
    out.push("");
  }

  if (warnings.length > 0) {
    out.push(pc.bold(`WATCH (${warnings.length})`));
    for (const finding of warnings) {
      out.push(` ${sevBadge[finding.severity]} ${pc.bold(finding.title)}`);
      if (opts.verbose) {
        out.push(pc.dim(wrap(finding.detail, 90, "      ")));
        out.push("");
      }
    }
    out.push("");
  }

  if (signals.length > 0) {
    out.push(pc.bold(`SIGNALS (${signals.length})`));
    for (const finding of signals) {
      const savings = finding.estimatedMonthlySavingsUsd
        ? pc.green(pc.bold(` ~${usd(finding.estimatedMonthlySavingsUsd)}/mo`))
        : "";
      out.push(` ${sevBadge[finding.severity]} ${pc.bold(finding.title)}${savings}`);
      if (opts.verbose) {
        out.push(pc.dim(wrap(finding.detail, 90, "      ")));
        out.push("");
      }
    }
    out.push("");
  }

  if (report.findings.length === 0)
    out.push(pc.dim("  none — not enough data or a very clean setup"));
  if (!opts.verbose && report.findings.length > 0) {
    out.push(pc.dim("  run with --verbose for the math behind each finding"));
  }
  out.push("");
  return out.join("\n");
}

export { usd };
