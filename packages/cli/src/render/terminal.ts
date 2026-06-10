import type { Finding, Report } from "@routecast/core";
import pc from "picocolors";

const usd = (n: number): string =>
  n >= 100 ? `$${Math.round(n).toLocaleString("en-US")}` : `$${n.toFixed(2)}`;

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

  out.push("");
  out.push(`${pc.bold(pc.cyan("⚡ routecast"))} ${pc.dim("· cost intelligence for AI agents")}`);
  out.push(
    pc.dim(
      `window ${report.window.days}d · ${t.events.toLocaleString("en-US")} events · pricing as of ${report.pricing.asOf} (${report.pricing.ageDays}d old)`,
    ),
  );
  out.push("");
  out.push(
    `${pc.bold("SPEND")}     ${pc.bold(usd(t.costUsd))} computed` +
      (t.cacheSavedUsd > 0 ? pc.green(`   cache saved ${usd(t.cacheSavedUsd)}`) : "") +
      (t.reasoningUsd > 0 ? pc.magenta(`   reasoning ${usd(t.reasoningUsd)}`) : ""),
  );
  out.push(
    `${pc.bold("FORECAST")}  ${f.month}  ` +
      `${pc.bold(usd(f.monthEndUsdP50))} p50 · ${usd(f.monthEndUsdP90)} p90 · ${usd(f.monthEndUsdP99)} p99` +
      pc.dim(`  (${f.method}, ${f.daysObserved}d observed)`),
  );
  out.push("");

  if (t.byModel.length > 0) {
    out.push(pc.bold("BY MODEL"));
    const max = Math.max(...t.byModel.map((m) => m.costUsd), 0.01);
    for (const m of t.byModel) {
      const bar = "█".repeat(Math.max(1, Math.round((m.costUsd / max) * 24)));
      const share = t.costUsd > 0 ? ` ${Math.round((m.costUsd / t.costUsd) * 100)}%` : "";
      out.push(
        `  ${m.model.padEnd(26).slice(0, 26)} ${usd(m.costUsd).padStart(10)}${share.padStart(5)}  ${pc.cyan(bar)}`,
      );
    }
    out.push("");
  }

  if (t.byFeature.length > 1) {
    out.push(pc.bold("BY PROJECT"));
    for (const feat of t.byFeature.slice(0, 8)) {
      out.push(
        `  ${feat.feature.padEnd(34).slice(0, 34)} ${usd(feat.costUsd).padStart(10)}  ${pc.dim(`${feat.events.toLocaleString("en-US")} calls`)}`,
      );
    }
    out.push("");
  }

  out.push(pc.bold(`FINDINGS (${report.findings.length})`));
  for (const finding of report.findings) {
    const savings = finding.estimatedMonthlySavingsUsd
      ? pc.green(pc.bold(` ~${usd(finding.estimatedMonthlySavingsUsd)}/mo`))
      : "";
    out.push(` ${sevBadge[finding.severity]} ${pc.bold(finding.title)}${savings}`);
    if (opts.verbose) {
      out.push(pc.dim(wrap(finding.detail, 90, "      ")));
      out.push("");
    }
  }
  if (report.findings.length === 0)
    out.push(pc.dim("  none — not enough data or a very clean setup"));
  if (!opts.verbose && report.findings.length > 0) {
    out.push("");
    out.push(pc.dim("  run with --verbose for the math behind each finding"));
  }
  out.push("");
  return out.join("\n");
}

export { usd };
