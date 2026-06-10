import type { EnrichedEvent } from "../events/schema.js";
import { type AnalyzerContext, type Finding, usd } from "./analyzer.js";

export interface Forecast {
  /** "YYYY-MM" being forecast (the month containing ctx.now). */
  month: string;
  mtdUsd: number;
  monthEndUsdP50: number;
  monthEndUsdP90: number;
  monthEndUsdP99: number;
  dailyUsdP50: number;
  /** "empirical" = quantiles of observed daily burn; "heuristic" = report multipliers (p90: 2x in / 3x out / 5x reasoning; p99: 5x/8x/10x). */
  method: "empirical" | "heuristic";
  daysObserved: number;
}

/** Linear-interpolated quantile of a sorted ascending array. */
export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo] ?? 0;
  const b = sorted[hi] ?? a;
  return a + (b - a) * (pos - lo);
}

interface DayBucket {
  total: number;
  input: number;
  output: number;
  reasoning: number;
}

export function computeForecast(
  events: EnrichedEvent[],
  ctx: AnalyzerContext,
): { forecast: Forecast; findings: Finding[] } {
  const days = new Map<string, DayBucket>();
  for (const e of events) {
    const day = e.ts.slice(0, 10);
    const bucket = days.get(day) ?? { total: 0, input: 0, output: 0, reasoning: 0 };
    bucket.total += e.effectiveCostUsd;
    if (e.cost) {
      bucket.input += e.cost.inputUsd + e.cost.cacheReadUsd + e.cost.cacheWriteUsd;
      bucket.output += e.cost.outputUsd;
      bucket.reasoning += e.cost.reasoningUsd;
    } else {
      bucket.output += e.effectiveCostUsd; // unknown split: treat as output (conservative)
    }
    days.set(day, bucket);
  }

  const now = ctx.now;
  const year = now.getUTCFullYear();
  const monthIdx = now.getUTCMonth();
  const month = `${year}-${String(monthIdx + 1).padStart(2, "0")}`;
  const daysInMonth = new Date(Date.UTC(year, monthIdx + 1, 0)).getUTCDate();
  const remainingDays = Math.max(0, daysInMonth - now.getUTCDate());

  let mtdUsd = 0;
  for (const [day, bucket] of days) if (day.startsWith(month)) mtdUsd += bucket.total;

  const daily = [...days.values()];
  const dailyTotals = daily.map((d) => d.total).sort((a, b) => a - b);
  const daysObserved = daily.length;

  let p50: number;
  let p90: number;
  let p99: number;
  let method: Forecast["method"];
  if (daysObserved >= 10) {
    method = "empirical";
    p50 = quantile(dailyTotals, 0.5);
    p90 = quantile(dailyTotals, 0.9);
    p99 = quantile(dailyTotals, 0.99);
  } else {
    // Too few days for stable quantiles: apply the report's variance multipliers
    // to the median day's token-class breakdown.
    method = "heuristic";
    const med = (sel: (d: DayBucket) => number) =>
      quantile(
        daily.map(sel).sort((a, b) => a - b),
        0.5,
      );
    const mIn = med((d) => d.input);
    const mOut = med((d) => d.output);
    const mReas = med((d) => d.reasoning);
    p50 = mIn + mOut + mReas;
    p90 = 2 * mIn + 3 * mOut + 5 * mReas;
    p99 = 5 * mIn + 8 * mOut + 10 * mReas;
  }

  const round2 = (n: number) => Math.round(n * 100) / 100;
  const forecast: Forecast = {
    month,
    mtdUsd: round2(mtdUsd),
    monthEndUsdP50: round2(mtdUsd + remainingDays * p50),
    monthEndUsdP90: round2(mtdUsd + remainingDays * p90),
    monthEndUsdP99: round2(mtdUsd + remainingDays * p99),
    dailyUsdP50: round2(p50),
    method,
    daysObserved,
  };

  const findings: Finding[] = [];
  if (events.length > 0) {
    findings.push({
      analyzer: "forecast",
      severity: "info",
      title: `${month} forecast: ${usd(forecast.monthEndUsdP50)} (p50) / ${usd(forecast.monthEndUsdP90)} (p90) / ${usd(forecast.monthEndUsdP99)} (p99)`,
      detail:
        `Month-to-date ${usd(forecast.mtdUsd)} + ${remainingDays} remaining days × daily burn quantiles ` +
        `(p50 ${usd(p50)}/day). Method: ${method} over ${daysObserved} observed days` +
        (method === "heuristic"
          ? " — fewer than 10 days of history, so variance bands use the report multipliers (p90 = 2× input / 3× output / 5× reasoning; p99 = 5×/8×/10×). Token usage is right-skewed; p99 days are expected, alerts firing on p50 days indicate misrouting."
          : ". Token usage is right-skewed; p99 days are expected, alerts firing on p50 days indicate misrouting."),
      confidence: method === "empirical" ? "high" : "medium",
      data: { forecast },
    });
  }
  return { forecast, findings };
}
