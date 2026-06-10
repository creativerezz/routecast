import { usd } from "../analyze/analyzer.js";
import type { Report } from "../analyze/pipeline.js";

const sevIcon: Record<string, string> = {
  critical: "🔴",
  warning: "🟠",
  recommendation: "💡",
  info: "ℹ️",
};

export function renderMarkdown(report: Report): string {
  const lines: string[] = [];
  const t = report.totals;
  lines.push("# Routecast report");
  lines.push("");
  lines.push(
    `Window: ${report.window.from.slice(0, 10)} → ${report.window.to.slice(0, 10)} (${report.window.days}d) · ` +
      `${t.events.toLocaleString("en-US")} events · pricing as of ${report.pricing.asOf}`,
  );
  lines.push("");
  lines.push(`## Spend: ${usd(t.costUsd)} (computed)`);
  lines.push("");
  lines.push(
    `Forecast for ${report.forecast.month}: **${usd(report.forecast.monthEndUsdP50)}** p50 · ` +
      `**${usd(report.forecast.monthEndUsdP90)}** p90 · **${usd(report.forecast.monthEndUsdP99)}** p99 ` +
      `(${report.forecast.method}, ${report.forecast.daysObserved} days observed)`,
  );
  lines.push("");
  lines.push("### By model");
  lines.push("");
  lines.push("| Model | Cost | Events | Input tokens | Output | Reasoning |");
  lines.push("|---|---:|---:|---:|---:|---:|");
  for (const m of t.byModel) {
    lines.push(
      `| ${m.model} | ${usd(m.costUsd)} | ${m.events.toLocaleString("en-US")} | ` +
        `${(m.inputTokens / 1e6).toFixed(1)}M | ${(m.outputTokens / 1e6).toFixed(1)}M | ` +
        `${(m.reasoningTokens / 1e6).toFixed(1)}M |`,
    );
  }
  lines.push("");
  if (t.byFeature.length > 0) {
    lines.push("### By project / feature");
    lines.push("");
    lines.push("| Feature | Cost | Events |");
    lines.push("|---|---:|---:|");
    for (const f of t.byFeature) {
      lines.push(`| ${f.feature} | ${usd(f.costUsd)} | ${f.events.toLocaleString("en-US")} |`);
    }
    lines.push("");
  }
  lines.push(
    `Cache already saving: ${usd(t.cacheSavedUsd)} in window · Reasoning tokens: ${usd(t.reasoningUsd)}`,
  );
  lines.push("");
  lines.push("## Findings");
  lines.push("");
  for (const f of report.findings) {
    lines.push(`### ${sevIcon[f.severity] ?? ""} ${f.title}`);
    lines.push("");
    lines.push(
      `*${f.severity} · confidence: ${f.confidence}${
        f.estimatedMonthlySavingsUsd
          ? ` · est. savings ${usd(f.estimatedMonthlySavingsUsd)}/mo`
          : ""
      }*`,
    );
    lines.push("");
    lines.push(f.detail);
    lines.push("");
  }
  if (report.findings.length === 0) {
    lines.push("_No findings — either a very clean setup or not enough data._");
    lines.push("");
  }
  return lines.join("\n");
}
