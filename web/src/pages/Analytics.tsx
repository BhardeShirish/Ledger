import { useQuery } from "@tanstack/react-query";
import { clsx } from "clsx";
import { useMemo, useState } from "react";
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, ComposedChart, Line, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { ArrowDownRight, ArrowRight, ArrowUpRight } from "lucide-react";
import { api } from "../api/client";
import { Link, useOutletContext } from "react-router-dom";
import { addDaysISO, fmtDate, fmtDateShort, moneyCfg, todayISO } from "../lib/format";
import { buildPresets, previousRange } from "../lib/ranges";
import { ExportButton } from "../components/DataButtons";
import SpendReview from "../components/SpendReview";
import { PurchasePatterns, TradePatterns } from "../components/Patterns";
import { KotGaps } from "../components/KotGaps";
import { ProfitAndLoss } from "../components/ProfitAndLoss";
import {
  Badge, Button, Card, EmptyState, ErrorNote, Input, SectionLabel, Spinner, StatTile,
} from "../components/ui";
import { MenuItems } from "./MenuItems";
function fmtDay(iso: string) {
  return new Date(iso + "T12:00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

type Ctx = { outletId: number };
const MAX_ANALYTICS_RANGE_DAYS = 3660;

function isISODate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(year, month - 1, day);
  return parsed.getFullYear() === year
    && parsed.getMonth() === month - 1
    && parsed.getDate() === day;
}

function rangeLength(start: string, end: string) {
  if (!isISODate(start) || !isISODate(end)) return null;
  return Math.round(
    (new Date(end + "T12:00:00").getTime() -
     new Date(start + "T12:00:00").getTime()) / 86400000,
  ) + 1;
}

function dateRangeLabel(start: string, end: string) {
  const format = (iso: string) => new Date(iso + "T12:00:00")
    .toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
  return start === end ? format(start) : `${format(start)} – ${format(end)}`;
}

function monthLabel(month: string) {
  const [year, number] = month.split("-").map(Number);
  return new Date(year, number - 1, 1)
    .toLocaleDateString("en-IN", { month: "long", year: "numeric" });
}

type CoverageFact = {
  title?: string;
  label?: string;
  detail?: string;
  severity?: "act" | "watch" | "good" | "info";
};

function qualityFacts(data: any, rangeDays: number): CoverageFact[] {
  const coverage = data?.recording_coverage ?? data?.recording ?? {};
  const supplied = coverage.findings ?? data?.recording_findings ?? data?.quality_findings;
  if (Array.isArray(supplied)) return supplied;

  const salesDays = coverage.sales_days ?? coverage.sales_recording_days ?? data?.days_recorded ?? 0;
  const cashCloseGaps = coverage.cash_close_gap_days ?? data?.cash_close_gap_days ??
    data?.cash_close_gaps ?? [];
  const facts: CoverageFact[] = [{
    severity: salesDays === 0 ? "watch" : "info",
    title: "Sales recording",
    detail: salesDays === 0
      ? `No sales days recorded in this ${rangeDays}-day range.`
      : `${salesDays} of ${rangeDays} days have recorded sales.`,
  }];
  if (Array.isArray(cashCloseGaps) && cashCloseGaps.length > 0) {
    facts.push({
      severity: "act",
      title: "Cash closes need attention",
      detail: `${cashCloseGaps.length} recorded day${cashCloseGaps.length === 1 ? "" : "s"} ` +
        "still need a cash close or review.",
    });
  }
  return facts;
}

function toneFor(fact: CoverageFact) {
  return fact.severity === "act" ? "bad" : fact.severity === "watch" ? "warn"
    : fact.severity === "good" ? "good" : "neutral";
}

type MetricItem = { key: string; label: string };

const METRIC_GROUPS: { group: string; items: MetricItem[] }[] = [
  {
    group: "Sales",
    items: [
      { key: "sales_total", label: "Total sales" },
      { key: "sales_net", label: "Net sales" },
      { key: "sales_cash", label: "Cash" },
      { key: "sales_upi", label: "UPI" },
      { key: "sales_card", label: "Card" },
      { key: "sales_aggregator", label: "Delivery apps & Paytm settlements" },
    ],
  },
  {
    group: "Cost groups",
    items: [
      { key: "expenses", label: "All expenses" },
      { key: "food_cost", label: "Food cost" },
      { key: "beverage_cost", label: "Beverage cost" },
      { key: "labour_cost", label: "Labour" },
      { key: "occupancy_cost", label: "Rent & occupancy" },
      { key: "operating_cost", label: "Running costs" },
      { key: "other_cost", label: "Other costs" },
      { key: "expense_cash", label: "Cash expenses" },
    ],
  },
  {
    group: "Other",
    items: [
      { key: "tips", label: "Tips" },
      { key: "discounts", label: "Discounts" },
      { key: "tax", label: "Tax collected" },
      { key: "bills", label: "Bill count" },
      { key: "avg_ticket", label: "Avg ticket" },
    ],
  },
];

const LABELS: Record<string, string> = Object.fromEntries(
  METRIC_GROUPS.flatMap((g) => g.items.map((i) => [i.key, i.label])));
const SERIES_COLORS = ["#0F766E", "#2563EB", "#7C3AED", "#B45309", "#0284C7",
  "#B91C1C", "#4F46E5", "#64748B"];
const METRIC_COLORS: Record<string, string> = {
  sales_total: "#0F766E", sales_net: "#0F766E", sales_cash: "#15803D",
  sales_upi: "#2563EB", sales_card: "#7C3AED", sales_aggregator: "#0E7490",
  expenses: "#B91C1C", food_cost: "#B45309", beverage_cost: "#7C3AED",
  labour_cost: "#4F46E5", occupancy_cost: "#64748B", operating_cost: "#0E7490",
  other_cost: "#78716C", expense_cash: "#B91C1C",
};

function metricColor(key: string, index = 0) {
  if (key.toLowerCase().includes("water")) return "#0284C7";
  return METRIC_COLORS[key] ?? SERIES_COLORS[index % SERIES_COLORS.length];
}

function medianOrNull(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * An insight that names no next step is a number the owner has to re-decide
 * every time they read it. Every action below is arithmetic over rows the
 * books already hold: it states the figures it came from, the reading that
 * would be wrong, and the screen where the work is actually done. Nothing
 * here predicts, scores, or changes money — the owner does that, on the
 * workflow page.
 */
type ActionRank = "act" | "check" | "record";

export type NextAction = {
  id: string;
  rank: ActionRank;
  title: string;
  evidence: string;
  caveat: string;
  href: string;
  cta: string;
};

const RANK_ORDER: Record<ActionRank, number> = { act: 0, check: 1, record: 2 };
const RANK_WORD: Record<ActionRank, string> = {
  act: "Act on this", check: "Check this", record: "Fill the record",
};
// The traffic-light triad, unchanged: red means a decision is required, amber
// means the books raised something a person must confirm. A recording gap is
// amber — the word, not a fourth colour, says what kind of work it is.
const RANK_TONE: Record<ActionRank, "bad" | "warn"> = {
  act: "bad", check: "warn", record: "warn",
};

/** Where each cost group is actually changed — analytics never changes it. */
const COST_WORKFLOW: Record<string, { href: string; cta: string }> = {
  food_cost: { href: "/money/unitprices", cta: "Compare purchase prices" },
  beverage_cost: { href: "/money/unitprices", cta: "Compare purchase prices" },
  labour_cost: { href: "/staff/shifts", cta: "Review rostered shifts" },
  occupancy_cost: { href: "/settings", cta: "Review standing costs" },
  operating_cost: { href: "/money/expenses", cta: "Open the expense list" },
  other_cost: { href: "/money/expenses", cta: "Open the expense list" },
};

const rupees = (value: number) =>
  `${moneyCfg.symbol}${Math.round(value).toLocaleString("en-IN")}`;
const plural = (count: number) => (count === 1 ? "" : "s");

function dayList(days: string[], limit = 3) {
  const shown = days.slice(0, limit).map((day) => fmtDateShort(day));
  const rest = days.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} and ${rest} more` : shown.join(", ");
}

/** Every rupee, percentage and multiple in prose is still set as a figure. */
function withFigures(text: string) {
  const symbol = moneyCfg.symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = text.split(
    new RegExp(`(${symbol}[\\d,]+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?[%×])`, "g"));
  return parts.map((part, index) =>
    (index % 2 ? <span key={index} className="num">{part}</span> : part));
}

export function buildNextActions({ data, previous, today, previousLabel, metricLabels }: {
  data: any; previous: any; today: string; previousLabel: string;
  metricLabels: Record<string, string>;
}): NextAction[] {
  const days: string[] = data?.days ?? [];
  if (!days.length) return [];
  const sales: number[] = data.series?.sales_total ?? [];
  const spend: number[] = data.series?.expenses ?? [];
  // A day that has not happened cannot be missing a record.
  const past = days.map((day, index) => ({ day, index })).filter(({ day }) => day <= today);
  const actions: NextAction[] = [];

  const unrecorded = past.filter(({ index }) => !(sales[index] > 0)).map(({ day }) => day);
  if (past.length > 0 && unrecorded.length > 0) {
    actions.push({
      id: "sales-days-unrecorded",
      rank: unrecorded.length / past.length >= 0.25 ? "act" : "record",
      title: `${unrecorded.length} of ${past.length} day${plural(past.length)} in range have no sales recorded`,
      evidence: `Nothing is entered for ${dayList(unrecorded)}. Every average, share and comparison on this page divides by recorded days only.`,
      caveat: "A day you were shut and a day nobody entered look identical here. Enter the takings, or zero for a closure, so the gap stops repeating.",
      href: `/sales?date=${unrecorded[0]}`,
      cta: `Open the sales sheet for ${fmtDateShort(unrecorded[0])}`,
    });
  }

  const tradingDays = past.filter(({ index }) => sales[index] > 0);
  const spendless = tradingDays.filter(({ index }) => !(spend[index] > 0)).map(({ day }) => day);
  if (tradingDays.length > 0 && spendless.length > 0) {
    actions.push({
      id: "spend-days-unrecorded",
      rank: spendless.length / tradingDays.length >= 0.5 ? "check" : "record",
      title: `${spendless.length} trading day${plural(spendless.length)} carr${spendless.length === 1 ? "ies" : "y"} no recorded spend`,
      evidence: `Sales are recorded but no expense is, on ${dayList(spendless)}.`,
      caveat: "A genuinely purchase-free day reads the same as bills still sitting in a drawer. Until they are logged, every cost share on this page reads lower than reality.",
      href: "/money/expenses",
      cta: "Log the missing bills",
    });
  }

  const salesTotal = data.totals?.sales_total ?? 0;
  if (salesTotal > 0 && data.bill_metrics_available === false) {
    actions.push({
      id: "bill-counts-missing",
      rank: "record",
      title: "Average ticket cannot be shown for this range",
      evidence: `${rupees(salesTotal)} of sales is recorded with no bill count behind it.`,
      caveat: "Bill counts arrive with imported POS sales; a day total typed by hand carries none. Without them, per-bill figures are unavailable rather than zero.",
      href: "/sales/import",
      cta: "Import POS sales",
    });
  }

  // Share of sales, not rupees: it is the only comparison that survives a
  // previous period of a different trading size.
  const previousSales = previous?.totals?.sales_total ?? 0;
  if (salesTotal > 0 && previousSales > 0) {
    const [mover] = Object.keys(COST_WORKFLOW)
      .map((key) => {
        const now = data.totals?.[key] ?? 0;
        const before = previous.totals?.[key] ?? 0;
        const nowShare = (now / salesTotal) * 100;
        const beforeShare = (before / previousSales) * 100;
        return { key, now, before, nowShare, beforeShare, move: nowShare - beforeShare };
      })
      .filter((item) => item.now > 0 && item.before > 0 && item.move >= 3)
      .sort((a, b) => b.move - a.move);
    if (mover) {
      const label = metricLabels[mover.key] ?? mover.key;
      actions.push({
        id: `cost-share-${mover.key}`,
        rank: mover.move >= 6 ? "act" : "check",
        title: `${label} takes ${mover.move.toFixed(1)} more points of sales than ${previousLabel.toLowerCase()}`,
        evidence: `${mover.nowShare.toFixed(1)}% of recorded sales now (${rupees(mover.now)} on ${rupees(salesTotal)}), against ${mover.beforeShare.toFixed(1)}% before (${rupees(mover.before)} on ${rupees(previousSales)}).`,
        caveat: "Both periods count recorded rows only. A bulk purchase, or one bill dated into the wrong period, produces this move on its own — confirm the dates before you change a price or a roster.",
        ...COST_WORKFLOW[mover.key],
      });
    }
  }

  const spendDays = days
    .map((day, index) => ({ day, amount: spend[index] ?? 0 }))
    .filter((entry) => entry.amount > 0);
  if (spendDays.length >= 5) {
    const middle = medianOrNull(spendDays.map((entry) => entry.amount)) ?? 0;
    const peak = spendDays.reduce((a, b) => (b.amount > a.amount ? b : a));
    if (middle > 0 && peak.amount >= middle * 4 && peak.amount - middle >= 5000) {
      actions.push({
        id: "spend-day-outlier",
        rank: "check",
        title: `One day carries ${rupees(peak.amount)} of recorded spend`,
        evidence: `${fmtDate(peak.day)} is ${(peak.amount / middle).toFixed(1)}× the ${rupees(middle)} middle day across ${spendDays.length} days with spend.`,
        caveat: "A monthly bulk buy, a duplicated entry and a misplaced decimal all look like this. Read that day's bills before treating it as a cost trend.",
        href: "/money/expenses",
        cta: `Check the bills dated ${fmtDateShort(peak.day)}`,
      });
    }
  }

  const cashIn = data.totals?.sales_cash ?? 0;
  const cashOut = data.totals?.expense_cash ?? 0;
  if (cashOut - cashIn >= 1000) {
    const lastPast = past.length ? past[past.length - 1].day : today;
    actions.push({
      id: "cash-out-exceeds-cash-in",
      rank: "act",
      title: "More cash was paid out than was taken in",
      evidence: `${rupees(cashOut)} of cash expenses against ${rupees(cashIn)} of recorded cash sales — ${rupees(cashOut - cashIn)} more out than in over this range.`,
      caveat: "An opening float, a bank withdrawal, or cash takings nobody recorded each explain this. The drawer is counted and reconciled in the cash register; this page only adds up what is already written down.",
      href: `/money/cash?date=${lastPast}`,
      cta: "Open the cash register",
    });
  }

  return actions.sort((a, b) => RANK_ORDER[a.rank] - RANK_ORDER[b.rank]);
}

export default function Analytics() {
  const { outletId } = useOutletContext<Ctx>();
  const presets = buildPresets();
  const [rangeIdx, setRangeIdx] = useState(4); // This month
  const [custom, setCustom] = useState<{ start: string; end: string } | null>(null);
  const [scopeAll, setScopeAll] = useState(false);
  const [selected, setSelected] = useState<string[]>(["sales_total", "expenses"]);
  const [chartType, setChartType] = useState<"line" | "bar">("line");
  const [scaleMode, setScaleMode] = useState<"amount" | "indexed">("amount");

  const range = custom
    ? { ...custom, label: "Custom" }
    : presets[rangeIdx];
  const [compare, setCompare] = useState(true);
  const rangeDays = rangeLength(range.start, range.end);
  const rangeError = rangeDays == null
    ? "Choose both a valid start and end date."
    : rangeDays < 1
      ? "End date must not be before the start date."
      : rangeDays > MAX_ANALYTICS_RANGE_DAYS
        ? `Choose a range of up to ${MAX_ANALYTICS_RANGE_DAYS.toLocaleString("en-IN")} days.`
        : "";
  const prev = rangeError ? { ...range, label: "Previous period" } : previousRange({ ...range });
  const q = useQuery({
    queryKey: ["analytics", range.start, range.end, scopeAll ? null : outletId],
    queryFn: () =>
      api.get(`/stats/analytics?start=${range.start}&end=${range.end}` +
              (scopeAll || !outletId ? "" : `&outlet_id=${outletId}`)),
    enabled: !rangeError,
  });
  const pq = useQuery({
    queryKey: ["analytics-prev", prev.start, prev.end, scopeAll ? null : outletId],
    queryFn: () =>
      api.get(`/stats/analytics?start=${prev.start}&end=${prev.end}` +
              (scopeAll || !outletId ? "" : `&outlet_id=${outletId}`)),
    enabled: compare && !rangeError,
  });
  const comparisonAvailable = compare && pq.isSuccess && pq.data != null;
  const comparisonUnavailable = compare && !rangeError && (
    pq.isError || (!pq.isLoading && pq.data == null)
  );

  const data = q.data;
  const salesTotal = data?.totals?.sales_total ?? 0;
  const expensesTotal = data?.totals?.expenses ?? 0;
  const foodCost = data?.totals?.food_cost ?? 0;
  const hasSales = salesTotal > 0;
  const foodCostRate = hasSales ? foodCost / salesTotal * 100 : null;
  const facts = qualityFacts(data, rangeDays ?? 0);
  const representedMonth = range.end.slice(0, 7);
  const metricLabels = useMemo<Record<string, string>>(() => ({
    ...LABELS,
    ...Object.fromEntries((data?.cost_metrics ?? []).map((item: MetricItem) => [item.key, item.label])),
    ...Object.fromEntries((data?.expense_metrics ?? []).map((item: MetricItem) => [item.key, item.label])),
  }), [data]);
  const metricGroups = useMemo(() => {
    const categories = (data?.expense_metrics ?? []) as MetricItem[];
    return categories.length
      ? [...METRIC_GROUPS, { group: "Expense categories", items: categories }]
      : METRIC_GROUPS;
  }, [data]);
  const waterMetric = (data?.expense_metrics ?? []).find(
    (item: MetricItem) => item.label.toLowerCase() === "water",
  ) as MetricItem | undefined;
  const nextActions = useMemo(() => buildNextActions({
    data,
    previous: comparisonAvailable ? pq.data : null,
    today: todayISO(),
    previousLabel: prev.label,
    metricLabels,
  }), [data, pq.data, comparisonAvailable, prev.label, metricLabels]);
  const pick = (key: string) =>
    setSelected((cur) =>
      cur.includes(key) ? cur.filter((k) => k !== key)
                        : [...cur, key]);

  const chartData = useMemo(() => {
    if (!data) return [];
    return data.days.map((d: string, i: number) => {
      const row: any = { date: d };
      selected.forEach((k) => { row[k] = data.series[k]?.[i] ?? 0; });
      return row;
    });
  }, [data, selected]);

  // A ₹5,000 food cost next to ₹2,00,000 of sales is a flat line on a shared
  // rupee axis, which reads as "we spend nothing". Say so, and offer a view
  // where each metric is measured against its own average instead.
  const scaleSpread = useMemo(() => {
    const totals = selected
      .map((k) => Math.abs(data?.totals?.[k] ?? 0))
      .filter((value) => value > 0);
    if (totals.length < 2) return 1;
    return Math.max(...totals) / Math.min(...totals);
  }, [data, selected]);
  const mixedScale = scaleSpread >= 5;
  const indexed = scaleMode === "indexed" && selected.length > 1;

  const metricAverages = useMemo(() => {
    const averages: Record<string, number> = {};
    selected.forEach((k) => {
      const series: number[] = data?.series?.[k] ?? [];
      const sum = series.reduce((total, value) => total + (value ?? 0), 0);
      averages[k] = series.length ? sum / series.length : 0;
    });
    return averages;
  }, [data, selected]);

  const indexedData = useMemo(() => chartData.map((row: any) => {
    const out: any = { date: row.date };
    selected.forEach((k) => {
      const average = metricAverages[k] ?? 0;
      out[k] = average > 0 ? Math.round((row[k] / average) * 100) : null;
      out[`raw_${k}`] = row[k];
    });
    return out;
  }), [chartData, selected, metricAverages]);

  const cashflowData = useMemo(() => {
    if (!data) return [];
    let sales = 0;
    let expenses = 0;
    return data.days.map((day: string, index: number) => {
      sales += data.series.sales_total?.[index] ?? 0;
      expenses += data.series.expenses?.[index] ?? 0;
      return { date: day, sales, expenses };
    });
  }, [data]);

  const pulse = useMemo(() => {
    const sales = (data?.series?.sales_total ?? []).filter((value: number) => value > 0);
    const total = data?.totals?.sales_total ?? 0;
    const expenseTotal = data?.totals?.expenses ?? 0;
    const previousTotal = comparisonAvailable ? pq.data?.totals?.sales_total ?? 0 : 0;
    return {
      typicalDay: medianOrNull(sales),
      averageActiveDay: sales.length ? total / sales.length : null,
      bestDay: sales.length ? Math.max(...sales) : null,
      recordedSpendRate: total > 0 ? expenseTotal / total * 100 : null,
      periodChange: previousTotal > 0 ? (total - previousTotal) / previousTotal * 100 : null,
    };
  }, [data, pq.data, comparisonAvailable]);

  const deltaFor = (key: string): number | null => {
    if (!comparisonAvailable || !data) return null;
    const cur = data.totals?.[key] ?? 0;
    const prv = pq.data.totals?.[key] ?? 0;
    if (prv === 0) return null;
    return Math.round(((cur - prv) / prv) * 100);
  };
  const upIsGood = (key: string) =>
    !(key.startsWith("expenses") || key === "discounts" || key === "tax");

  // overlay: primary metric current vs previous, aligned day-by-day
  const primary = selected[0];
  const overlayData = useMemo(() => {
    if (!comparisonAvailable || !data || !pq.data) return [];
    const prevSeries = pq.data.series?.[primary] ?? [];
    const curSeries = data.series?.[primary] ?? [];
    const n = Math.max(curSeries.length, prevSeries.length);
    return Array.from({ length: n }, (_, i) => ({
      day: `D${i + 1}`,
      current: curSeries[i] ?? null,
      previous: prevSeries[i] ?? null,
    }));
  }, [data, pq.data, primary, comparisonAvailable]);

  const compareBars = useMemo(() => {
    if (!comparisonAvailable || !data || !pq.data) return [];
    return selected.map((k) => ({
      metric: metricLabels[k] ?? k,
      Current: data.totals?.[k] ?? 0,
      Previous: pq.data.totals?.[k] ?? 0,
    }));
  }, [selected, data, pq.data, comparisonAvailable, metricLabels]);

  if (q.isLoading && !data) return <Spinner />;

  const mixData = ["cash", "upi", "card", "aggregator", "wallet"]
    .map((k) => ({
      key: `sales_${k}`,
      name: metricLabels[`sales_${k}`] ?? k,
      value: data?.totals?.[`sales_${k}`] ?? 0,
    }))
    .filter((x) => x.value > 0);

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Decisions for {range.label}</h1>
      </header>

      {/* Range + scope */}
      <Card className="space-y-3 p-4">
        <div className="flex flex-wrap gap-1.5">
          {presets.map((p, i) => (
            <button key={p.label}
                    onClick={() => { setRangeIdx(i); setCustom(null); }}
                    aria-pressed={!custom && rangeIdx === i}
                    className={`rounded-full border px-3 py-1.5 text-sm ${
                      !custom && rangeIdx === i
                        ? "border-accent bg-accent-soft font-semibold text-accent"
                        : "border-rule-strong hover:bg-paper-3"}`}>
              {p.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-ink-faint">Custom:</span>
          <Input type="date" size="compact" aria-label="Custom date start"
                 value={custom?.start ?? range.start}
                 min={isISODate(range.end)
                   ? addDaysISO(range.end, -(MAX_ANALYTICS_RANGE_DAYS - 1)) : undefined}
                 max={isISODate(range.end) ? range.end : undefined}
                 onChange={(e) => setCustom({ start: e.target.value, end: custom?.end ?? range.end })}
                 className="!w-auto" />
          →
          <Input type="date" size="compact" aria-label="Custom date end"
                 value={custom?.end ?? range.end}
                 min={isISODate(range.start) ? range.start : undefined}
                 max={isISODate(range.start)
                   ? addDaysISO(range.start, MAX_ANALYTICS_RANGE_DAYS - 1) : undefined}
                 onChange={(e) => setCustom({ start: custom?.start ?? range.start, end: e.target.value })}
                 className="!w-auto" />
          <button onClick={() => setScopeAll(!scopeAll)} aria-pressed={scopeAll}
                  className={`ml-auto rounded-full border px-3 py-1 ${
                    scopeAll ? "border-accent bg-accent-soft text-accent" : "border-rule-strong"}`}>
            All outlets
          </button>
        </div>
        <p className="text-xs text-ink-faint">
          {rangeError
            ? rangeError
            : `Showing ${dateRangeLabel(range.start, range.end)} · ${scopeAll ? "all outlets" : "this outlet"}`}
        </p>
      </Card>

      {(rangeError || q.isError) ? (
        <Card className="space-y-3 p-4">
          <ErrorNote msg={rangeError || (q.error as Error)?.message || "Couldn't load this analysis."} />
          <Button variant="outline" size="sm" onClick={() => setCustom(null)}>
            Return to {presets[rangeIdx].label}
          </Button>
        </Card>
      ) : (
        <>
      {/* What needs a decision comes before anything that has to be configured. */}
      <Card className="space-y-3 p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <SectionLabel as="h2">What to do next</SectionLabel>
          <p className="text-xs text-ink-faint">
            arithmetic over recorded rows · nothing here changes money
          </p>
        </div>
        {nextActions.length === 0 ? (
          <p className="text-sm text-ink-soft">
            Nothing in what is recorded for this range asks for a next step. That is a
            statement about the books, not a verdict on the business.
          </p>
        ) : (
          <ol aria-label="Next actions" className="space-y-2">
            {nextActions.map((action) => (
              <li key={action.id}
                  className="rounded-md border border-rule-strong px-3 py-2.5">
                <div className="flex flex-wrap items-start gap-x-2 gap-y-1">
                  <Badge tone={RANK_TONE[action.rank]}>{RANK_WORD[action.rank]}</Badge>
                  <h3 className="min-w-0 flex-1 font-semibold">{withFigures(action.title)}</h3>
                </div>
                <p className="mt-1 text-sm text-ink-soft">{withFigures(action.evidence)}</p>
                <p className="mt-1 text-xs text-ink-faint">
                  <span className="font-medium">Before you act</span> · {action.caveat}
                </p>
                <Link to={action.href}
                      className="group mt-2 inline-flex items-center gap-1 rounded text-sm font-semibold text-accent underline decoration-accent/40 hover:decoration-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
                  {action.cta}
                  <ArrowRight size={14} aria-hidden="true"
                              className="transition-transform duration-200 group-hover:translate-x-0.5" />
                </Link>
              </li>
            ))}
          </ol>
        )}
        <div className="border-t border-rule pt-2.5">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <h3 className="label-caps">Recording quality</h3>
            <p className="text-xs text-ink-faint">deterministic checks from your books</p>
          </div>
          <ul className="mt-2 space-y-2">
            {facts.map((fact, index) => (
              <li key={`${fact.title ?? fact.label}-${index}`}
                  className="flex flex-wrap items-start gap-2 text-sm">
                <Badge tone={toneFor(fact)}>{fact.severity === "act" ? "Act on this"
                  : fact.severity === "watch" ? "Keep an eye" : "For info"}</Badge>
                <span className="min-w-0 flex-1">
                  <span className="font-semibold">{fact.title ?? fact.label}</span>
                  {fact.detail && <span className="text-ink-soft"> · {fact.detail}</span>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5">
        <StatTile label="Sales" value={moneyCfg.symbol + salesTotal.toLocaleString("en-IN")}
                    sub={hasSales ? "recorded in this range" : "no sales recorded"} />
        <StatTile label="Expenses" value={moneyCfg.symbol + expensesTotal.toLocaleString("en-IN")}
                    sub="recorded in this range" />
        <StatTile label="Food cost" value={moneyCfg.symbol + foodCost.toLocaleString("en-IN")}
                    sub={foodCostRate == null ? "needs recorded sales"
                      : `${foodCostRate.toFixed(1)}% of recorded sales`} />
        {hasSales ? (
          <StatTile label="After recorded expenses"
                      value={moneyCfg.symbol + (salesTotal - expensesTotal).toLocaleString("en-IN")}
                      sub="not profit — imports may still be incomplete" />
        ) : (
          <StatTile label="After recorded expenses" value="—"
                      sub="needs recorded sales; not a profit figure" />
        )}
        <StatTile label="Recording days"
                    value={String(data?.days_recorded ?? 0)}
                    sub={`of ${rangeDays} days in range`} />
      </div>

      <Card className="space-y-5 p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">Build a graph</h2>
            <p className="mt-1 text-sm text-ink-faint">
              Choose exactly what to compare. Every line uses the date range above.
            </p>
          </div>
          <div className="flex rounded-md border border-rule-strong p-0.5 text-sm">
            <button aria-pressed={chartType === "line"} onClick={() => setChartType("line")}
                    className={clsx("rounded px-2.5 py-1.5 font-medium",
                      chartType === "line" ? "bg-ink text-paper" : "text-ink-soft hover:bg-paper-3")}>
              Lines
            </button>
            <button aria-pressed={chartType === "bar"} onClick={() => setChartType("bar")}
                    className={clsx("rounded px-2.5 py-1.5 font-medium",
                      chartType === "bar" ? "bg-ink text-paper" : "text-ink-soft hover:bg-paper-3")}>
              Bars
            </button>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button onClick={() => setSelected(["sales_total", "food_cost"])}
                  aria-pressed={selected.length === 2 && selected[0] === "sales_total" && selected[1] === "food_cost"}
                  className="rounded-full border border-rule-strong px-3 py-1.5 text-sm font-medium hover:bg-paper-3">
            Sales vs food cost
          </button>
          {waterMetric && (
            <button onClick={() => setSelected(["sales_total", waterMetric.key, "food_cost"])}
                    aria-pressed={selected.length === 3 && selected[0] === "sales_total" && selected[1] === waterMetric.key && selected[2] === "food_cost"}
                    className="rounded-full border border-rule-strong px-3 py-1.5 text-sm font-medium hover:bg-paper-3">
              Sales vs water vs food cost
            </button>
          )}
          <button onClick={() => setSelected(["sales_total", "labour_cost"])}
                  aria-pressed={selected.length === 2 && selected[0] === "sales_total" && selected[1] === "labour_cost"}
                  className="rounded-full border border-rule-strong px-3 py-1.5 text-sm font-medium hover:bg-paper-3">
            Sales vs labour
          </button>
        </div>
        <div className="space-y-3 border-y border-rule py-4">
          {metricGroups.map((group) => (
            <div key={group.group} className="flex flex-wrap items-center gap-1.5">
              <span className="w-28 shrink-0 text-xs font-medium text-ink-faint">{group.group}</span>
              {group.items.map((item, index) => {
                const selectedIndex = selected.indexOf(item.key);
                return (
                  <button key={item.key} onClick={() => pick(item.key)}
                          aria-pressed={selectedIndex >= 0}
                          className={clsx(
                            "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition-colors",
                            selectedIndex >= 0
                              ? "border-ink bg-paper-3 font-semibold text-ink"
                              : "border-rule-strong text-ink-soft hover:bg-paper-3",
                          )}>
                    <span className="h-2 w-2 rounded-full" style={{ background: metricColor(item.key, index) }} />
                    {item.label}{selectedIndex >= 0 ? ` #${selectedIndex + 1}` : ""}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        {selected.length === 0 ? (
          <EmptyState title="Choose one or more metrics"
                      hint="Start with a quick comparison above, or select individual metrics." />
        ) : (
          <>
            {selected.length > 1 && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <div className="flex rounded-md border border-rule-strong p-0.5 text-sm">
                  <button aria-pressed={scaleMode === "amount"} onClick={() => setScaleMode("amount")}
                          className={clsx("rounded px-2.5 py-1.5 font-medium",
                            scaleMode === "amount" ? "bg-ink text-paper" : "text-ink-soft hover:bg-paper-3")}>
                    Amounts ({moneyCfg.symbol})
                  </button>
                  <button aria-pressed={scaleMode === "indexed"} onClick={() => setScaleMode("indexed")}
                          className={clsx("rounded px-2.5 py-1.5 font-medium",
                            scaleMode === "indexed" ? "bg-ink text-paper" : "text-ink-soft hover:bg-paper-3")}>
                    Indexed
                  </button>
                </div>
                <p className="min-w-0 flex-1 text-xs text-ink-faint">
                  {indexed
                    ? "Each line is that metric against its own average for this range (100 = its average day). Shapes are comparable; the sizes are not — exact rupee totals stay in the tiles and table below."
                    : mixedScale
                      ? `One shared ${moneyCfg.symbol} scale. The largest metric here is about ${Math.round(scaleSpread)}× the smallest, so the smaller lines look flat — switch to Indexed to compare how they move.`
                      : `One shared ${moneyCfg.symbol} scale, and these metrics are close enough in size to read against each other.`}
                </p>
              </div>
            )}
            <ul aria-label="Graph legend" className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-soft">
              {selected.map((key, index) => (
                <li key={key} className="flex items-center gap-1.5">
                  <span aria-hidden="true" className="h-2 w-2 rounded-full"
                        style={{ background: metricColor(key, index) }} />
                  {metricLabels[key] ?? key}
                  {index === 0 ? " · first choice" : ""}
                </li>
              ))}
            </ul>
            <div className="h-80">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={indexed ? indexedData : chartData}
                               margin={{ top: 8, right: 8, bottom: 0, left: -14 }}>
                  <CartesianGrid stroke="#E7E0D8" vertical={false} />
                  <XAxis dataKey="date" tick={{ fontSize: 11, fill: "#57534E" }} tickLine={false}
                         axisLine={{ stroke: "#D6CDC2" }} tickFormatter={(value: string) => fmtDay(value)}
                         interval="preserveStartEnd" minTickGap={28} />
                  <YAxis tick={{ fontSize: 11, fill: "#57534E" }} tickLine={false} axisLine={false}
                         tickFormatter={(value: number) => indexed
                           ? String(value)
                           : value >= 1000 ? `${Math.round(value / 1000)}k` : String(value)} />
                  <Tooltip formatter={(value: number, name: string, item: any) => {
                    const raw = indexed ? item?.payload?.[`raw_${name}`] ?? 0 : value;
                    const exact = name === "bills"
                      ? Number(raw).toLocaleString("en-IN")
                      : `${moneyCfg.symbol}${Number(raw).toLocaleString("en-IN")}`;
                    return [
                      indexed ? `${Math.round(value)} vs its average · ${exact}` : exact,
                      metricLabels[name] ?? name,
                    ];
                  }}
                           labelFormatter={(label) => fmtDay(label)}
                           itemStyle={{ color: "#1C1917" }} contentStyle={{ background: "#FAF7F2", border: "1px solid #D6CDC2", borderRadius: 8 }} />
                  {selected.map((key, index) => chartType === "bar" ? (
                    <Bar key={key} dataKey={key} fill={metricColor(key, index)}
                         radius={[3, 3, 0, 0]} maxBarSize={42} />
                  ) : (
                    <Line key={key} type="monotone" dataKey={key}
                          stroke={metricColor(key, index)}
                          strokeWidth={index === 0 ? 2.75 : 2}
                          dot={false} activeDot={{ r: 4 }} />
                  ))}
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </>
        )}
      </Card>

      <Card className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <SectionLabel>Business pulse</SectionLabel>
          <span className="text-xs text-ink-faint">based only on recorded days and costs</span>
        </div>
        <dl className="mt-3 grid gap-x-5 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <dt className="text-ink-faint">Typical recorded sales day</dt>
            <dd className="num mt-0.5 font-semibold">
              {pulse.typicalDay == null ? "—" : `${moneyCfg.symbol}${pulse.typicalDay.toLocaleString("en-IN")}`}
            </dd>
            <dd className="text-xs text-ink-faint">middle day, not skewed by one peak</dd>
          </div>
          <div>
            <dt className="text-ink-faint">Average per recorded sales day</dt>
            <dd className="num mt-0.5 font-semibold">
              {pulse.averageActiveDay == null ? "—" : `${moneyCfg.symbol}${Math.round(pulse.averageActiveDay).toLocaleString("en-IN")}`}
            </dd>
            <dd className="text-xs text-ink-faint">{data?.days_recorded ?? 0} day{(data?.days_recorded ?? 0) === 1 ? "" : "s"} with sales</dd>
          </div>
          <div>
            <dt className="text-ink-faint">Best recorded sales day</dt>
            <dd className="num mt-0.5 font-semibold">
              {pulse.bestDay == null ? "—" : `${moneyCfg.symbol}${pulse.bestDay.toLocaleString("en-IN")}`}
            </dd>
            <dd className="text-xs text-ink-faint">a reference, not a target forecast</dd>
          </div>
          <div>
            <dt className="text-ink-faint">Recorded spend rate</dt>
            <dd className="num mt-0.5 font-semibold">
              {pulse.recordedSpendRate == null ? "—" : `${pulse.recordedSpendRate.toFixed(1)}%`}
            </dd>
            <dd className="text-xs text-ink-faint">
              {pulse.periodChange == null ? "needs prior sales to compare"
                : `${pulse.periodChange >= 0 ? "+" : ""}${pulse.periodChange.toFixed(1)}% sales vs ${prev.label.toLowerCase()}`}
            </dd>
          </div>
        </dl>
      </Card>

      <Card className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <SectionLabel as="h2" id="cumulative-sales-expenses-heading">Sales vs recorded expenses over time</SectionLabel>
          <Badge>{data?.days_recorded ?? 0} sales days</Badge>
        </div>
        <p className="mt-1 text-xs text-ink-faint">
          Cumulative values make the gap between money in and recorded spending visible. This is not profit.
        </p>
        <figure aria-labelledby="cumulative-sales-expenses-heading"
                aria-describedby="cumulative-sales-expenses-summary">
          <ul aria-label="Cumulative legend" className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-soft">
            <li className="flex items-center gap-1.5">
              <span aria-hidden="true" className="h-2 w-2 rounded-full" style={{ background: "#0F766E" }} />
              Sales
            </li>
            <li className="flex items-center gap-1.5">
              <span aria-hidden="true" className="h-2 w-2 rounded-full" style={{ background: "#B91C1C" }} />
              Recorded expenses
            </li>
          </ul>
          <div aria-hidden="true" className="mt-3 h-72">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={cashflowData} accessibilityLayer={false}
                         margin={{ top: 4, right: 4, bottom: 0, left: -14 }}>
                <CartesianGrid stroke="#EDE6DC" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 11, fill: "#57534E" }} tickLine={false}
                       axisLine={{ stroke: "#E7E0D8" }} tickFormatter={(value: string) => value.slice(8)}
                       interval="preserveStartEnd" />
                <YAxis tick={{ fontSize: 11, fill: "#57534E" }} tickLine={false} axisLine={false}
                       tickFormatter={(value: number) => value >= 1000 ? `${Math.round(value / 1000)}k` : String(value)} />
                <Tooltip formatter={(value: number, name: string) =>
                  [`${moneyCfg.symbol}${Number(value).toLocaleString("en-IN")}`,
                    name === "sales" ? "Sales" : "Recorded expenses"]}
                         labelFormatter={(label) => fmtDay(label)}
                         itemStyle={{ color: "#1C1917" }} contentStyle={{ background: "#FAF7F2", border: "1px solid #E7E0D8", borderRadius: 8 }} />
                <Area type="monotone" dataKey="sales" stroke="#0F766E" strokeWidth={2.25}
                      fill="#0F766E" fillOpacity={0.1} />
                <Area type="monotone" dataKey="expenses" stroke="#B91C1C" strokeWidth={1.75}
                      fill="#B91C1C" fillOpacity={0.05} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          <figcaption id="cumulative-sales-expenses-summary" className="mt-2 text-xs text-ink-faint">
            Both lines run on one shared {moneyCfg.symbol} scale, so recorded expenses sit low when sales are
            much larger. Running totals to {dateRangeLabel(range.end, range.end)}:{" "}
            <span className="num">{moneyCfg.symbol}{salesTotal.toLocaleString("en-IN")}</span> sales
            and <span className="num">{moneyCfg.symbol}{expensesTotal.toLocaleString("en-IN")}</span> recorded
            expenses — the gap between them is not profit.
          </figcaption>
        </figure>
      </Card>

      <div>
        <SectionLabel>Month-only decisions · {monthLabel(representedMonth)}</SectionLabel>
        <p className="mt-1 text-sm text-ink-faint">
          Spend review and P&amp;L below represent {monthLabel(representedMonth)}, not {range.label.toLowerCase()}.
        </p>
      </div>

      <SpendReview month={range.end.slice(0, 7)}
                     outletId={scopeAll ? null : outletId} />

      <ProfitAndLoss month={range.end.slice(0, 7)}
                       outletId={scopeAll ? null : outletId} />

      <TradePatterns start={range.start} end={range.end}
                       outletId={scopeAll ? null : outletId} />
      <PurchasePatterns start={range.start} end={range.end}
                        outletId={scopeAll ? null : outletId} />

      {/* Food that left the kitchen with nothing recorded against it. It
          sits after the trading patterns because it is a leak, not a
          habit — you read it once you know what a normal day looks like. */}
      <KotGaps start={range.start} end={range.end}
               outletId={scopeAll ? null : outletId} />

      {/* Stat tiles in selection order, with period deltas */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {selected.map((k, i) => {
          const total = data?.totals?.[k] ?? 0;
          const sub = k.startsWith("sales_") || k === "expenses"
            ? `avg ₹${Math.round(total / Math.max(1, data?.days.length ?? 1)).toLocaleString("en-IN")}/day`
            : undefined;
          const share = i > 0 && primary && data?.totals?.[primary]
            ? `${Math.round((total / data.totals[primary]) * 100)}% of ${metricLabels[primary]}`
            : undefined;
          const d = deltaFor(k);
          return (
            <div key={k} className="relative">
              <StatTile label={`${i === 0 ? "★ " : ""}${metricLabels[k] ?? k}`}
                        value={moneyCfg.symbol + total.toLocaleString("en-IN")}
                        sub={share ?? sub} />
              {d != null && (
                <span className={`absolute right-3 top-3 inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[11px] font-semibold ${
                  d === 0 ? "bg-paper-3 text-ink-faint"
                  : (d > 0) === upIsGood(k) ? "bg-good/10 text-green-800"
                    : "bg-bad/10 text-bad"}`}>
                  {d > 0 ? <ArrowUpRight size={11} /> : <ArrowDownRight size={11} />}
                  {Math.abs(d)}%
                </span>
              )}
            </div>
          );
        })}
        {compare && (
          <button onClick={() => setCompare(false)} aria-pressed={compare}
                  className="self-start rounded-full border border-rule-strong px-3 py-1 text-xs text-ink-faint hover:bg-paper-3">
            {comparisonUnavailable ? "comparison unavailable — hide"
              : `comparing vs ${prev.label} — hide`}
          </button>
        )}
        {!compare && (
          <button onClick={() => setCompare(true)} aria-pressed={compare}
                  className="self-start rounded-full border border-dashed border-rule-strong px-3 py-1 text-xs text-ink-faint hover:bg-paper-3">
            compare with previous period
          </button>
        )}
      </div>

      {/* Period comparison: totals side by side */}
      {comparisonUnavailable && (
        <Card className="space-y-3 p-4">
          <p className="text-sm font-medium">Comparison unavailable</p>
          <ErrorNote msg={(pq.error as Error | null)?.message ||
            `Couldn't load ${prev.label.toLowerCase()} for comparison.`} />
          <Button variant="outline" size="sm" onClick={() => pq.refetch()}>
            Retry comparison
          </Button>
        </Card>
      )}
      {comparisonAvailable && compareBars.length > 0 && (
        <Card className="p-4">
          <SectionLabel as="h2" id="current-vs-previous-heading">
            Current vs previous · {range.label} vs {prev.label}
          </SectionLabel>
          <figure aria-labelledby="current-vs-previous-heading">
            <ul aria-label="Comparison legend" className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-soft">
              <li className="flex items-center gap-1.5">
                <span aria-hidden="true" className="h-2 w-2 rounded-full" style={{ background: "#78716C" }} />
                {prev.label}
              </li>
              <li className="flex items-center gap-1.5">
                <span aria-hidden="true" className="h-2 w-2 rounded-full bg-accent" />
                {range.label}
              </li>
            </ul>
            <div className="mt-3 h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={compareBars} margin={{ top: 4, right: 4, bottom: 0, left: -14 }}>
                  <CartesianGrid stroke="#EDE6DC" vertical={false} />
                  <XAxis dataKey="metric" tick={{ fontSize: 11, fill: "#57534E" }} tickLine={false}
                         axisLine={{ stroke: "#E7E0D8" }} interval={0} />
                  <YAxis tick={{ fontSize: 11, fill: "#57534E" }} tickLine={false} axisLine={false}
                         tickFormatter={(v: any) => v >= 1000 ? `${Math.round(v / 1000)}k` : v} />
                  <Tooltip formatter={(v: any, n: any) =>
                        [`${moneyCfg.symbol}${Number(v).toLocaleString("en-IN")}`, n]}
                           itemStyle={{ color: "#1C1917" }} contentStyle={{ background: "#FAF7F2", border: "1px solid #E7E0D8", borderRadius: 8 }} />
                  <Bar dataKey="Previous" fill="#78716C" radius={[4, 4, 0, 0]} maxBarSize={34} />
                  <Bar dataKey="Current" fill="#C2410C" radius={[4, 4, 0, 0]} maxBarSize={34} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </figure>
        </Card>
      )}

      {/* Primary metric day-by-day overlay */}
      {comparisonAvailable && overlayData.length > 1 && (
        <Card className="p-4">
          <SectionLabel as="h2" id="day-by-day-heading">
            Day-by-day · {metricLabels[primary] ?? primary} — current vs previous
          </SectionLabel>
          <figure aria-labelledby="day-by-day-heading">
            <ul aria-label="Day-by-day legend" className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-soft">
              <li className="flex items-center gap-1.5">
                <span aria-hidden="true" className="h-2 w-2 rounded-full" style={{ background: "#78716C" }} />
                {prev.label}
              </li>
              <li className="flex items-center gap-1.5">
                <span aria-hidden="true" className="h-2 w-2 rounded-full bg-accent" />
                {range.label}
              </li>
            </ul>
            <div className="mt-3 h-56">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={overlayData} margin={{ top: 4, right: 4, bottom: 0, left: -14 }}>
                  <CartesianGrid stroke="#EDE6DC" vertical={false} />
                  <XAxis dataKey="day" tick={{ fontSize: 10, fill: "#57534E" }} tickLine={false}
                         axisLine={{ stroke: "#E7E0D8" }} interval="preserveStartEnd" />
                  <YAxis tick={{ fontSize: 11, fill: "#57534E" }} tickLine={false} axisLine={false}
                         tickFormatter={(v: any) => v >= 1000 ? `${Math.round(v / 1000)}k` : v} />
                  <Tooltip formatter={(v: any, n: any) =>
                        [`${moneyCfg.symbol}${Number(v).toLocaleString("en-IN")}`,
                         n === "current" ? "Current" : "Previous"]}
                           labelStyle={{ color: "#57534E" }}
                           itemStyle={{ color: "#1C1917" }} contentStyle={{ background: "#FAF7F2", border: "1px solid #E7E0D8", borderRadius: 8 }} />
                  <Line type="monotone" dataKey="previous" stroke="#78716C"
                        strokeWidth={1.75} strokeDasharray="5 4" dot={false} />
                  <Line type="monotone" dataKey="current" stroke="#C2410C"
                        strokeWidth={2.25} dot={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </figure>
        </Card>
      )}

      <div className="grid gap-3 lg:grid-cols-2">
        {/* Totals ranking */}
        <Card className="p-4">
          <SectionLabel>Totals in this range</SectionLabel>
          <div className="mt-3 space-y-2">
            {[...selected].sort((a, b) =>
              (data?.totals?.[b] ?? 0) - (data?.totals?.[a] ?? 0)).map((k, i) => {
              const max = Math.max(...selected.map((x) => data?.totals?.[x] ?? 0), 1);
              const v = data?.totals?.[k] ?? 0;
              return (
                <div key={k} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm sm:flex-nowrap">
                  <span className="min-w-0 flex-1 truncate text-ink-soft sm:w-28 sm:flex-none">{metricLabels[k]}</span>
                  <span className="num shrink-0 text-right font-medium sm:order-3 sm:w-28">
                    {moneyCfg.symbol}{v.toLocaleString("en-IN")}
                  </span>
                  {i === 0 && <span className="shrink-0 sm:order-4"><Badge tone="accent">top</Badge></span>}
                  <div className="h-2.5 w-full basis-full overflow-hidden rounded-full bg-paper-3 sm:order-2 sm:w-auto sm:min-w-0 sm:flex-1 sm:basis-auto">
                    <div className="h-full rounded-full"
                         style={{ width: `${(v / max) * 100}%`,
                                  background: metricColor(k, selected.indexOf(k)) }} />
                  </div>
                </div>
              );
            })}
          </div>
        </Card>

        {/* Weekday rhythm */}
        <Card className="p-4">
          <SectionLabel>Weekday rhythm · avg total sales</SectionLabel>
          <div className="mt-2 h-48">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].map((d, i) =>
                    ({ day: d, avg: data?.weekday_avg_sales?.[i] ?? 0 }))}
                        margin={{ top: 4, right: 4, bottom: 0, left: -18 }}>
                <CartesianGrid stroke="#EDE6DC" vertical={false} />
                <XAxis dataKey="day" tick={{ fontSize: 11, fill: "#57534E" }} tickLine={false} axisLine={false} />
                <YAxis tick={{ fontSize: 11, fill: "#57534E" }} tickLine={false} axisLine={false} hide />
                <Tooltip formatter={(v: any) => [`${moneyCfg.symbol}${Number(v).toLocaleString("en-IN")}`, "avg"]}
                         itemStyle={{ color: "#1C1917" }} contentStyle={{ background: "#FAF7F2", border: "1px solid #E7E0D8", borderRadius: 8 }} />
                <Bar dataKey="avg" fill="#C2410C" radius={[4, 4, 0, 0]} maxBarSize={38} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>

        {/* Channel mix */}
        {mixData.length > 1 && (
          <Card className="min-w-0 p-4">
            <SectionLabel as="h2" id="channel-mix-heading">Channel mix in range</SectionLabel>
            <figure aria-labelledby="channel-mix-heading">
              <div className="mt-2 flex flex-wrap items-center gap-4">
                <div aria-hidden="true" className="shrink-0">
                  <ResponsiveContainer width={150} height={150}>
                    <PieChart accessibilityLayer={false}>
                      <Pie data={mixData} dataKey="value" nameKey="name" rootTabIndex={-1}
                           innerRadius={44} outerRadius={68} paddingAngle={2} stroke="#FAF7F2">
                        {mixData.map((m, i) => (
                          <Cell key={i} fill={metricColor(m.key, i)} />
                        ))}
                      </Pie>
                      <Tooltip formatter={(v: any) => `${moneyCfg.symbol}${Number(v).toLocaleString("en-IN")}`}
                               itemStyle={{ color: "#1C1917" }} contentStyle={{ background: "#FAF7F2", border: "1px solid #E7E0D8", borderRadius: 8 }} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <ul className="min-w-0 flex-1 space-y-1 text-sm">
                  {mixData.sort((a, b) => b.value - a.value).map((m, i) => (
                    <li key={m.name} className="flex items-center gap-2">
                      <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full"
                            style={{ background: metricColor(m.key, i) }} />
                      <span className="min-w-0 truncate">{m.name}</span>
                      <span className="num ml-auto shrink-0 font-medium">
                        {moneyCfg.symbol}{m.value.toLocaleString("en-IN")}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </figure>
          </Card>
        )}

        <Card className="flex flex-col justify-between p-4">
          <SectionLabel>Export this view</SectionLabel>
          <p className="mt-2 text-sm text-ink-faint">
            Days as rows, every metric as a column — straight to Excel.
          </p>
          <ExportButton entity="analytics" label="Download xlsx"
                        params={{ start: range.start, end: range.end,
                                  outlet_id: scopeAll ? "" : outletId }} />
        </Card>
      </div>

      <MenuEngineering outletId={scopeAll ? null : outletId}
                       start={range.start} end={range.end} />

      <MenuItems outletId={scopeAll ? null : outletId}
                 start={range.start} end={range.end} />
        </>
      )}
    </div>
  );
}

function MenuEngineering({ outletId, start, end }: {
  outletId: number | null; start: string; end: string;
}) {
  const menu = useQuery({
    queryKey: ["menu-engineering", outletId, start, end],
    queryFn: () => api.get(`/insights/menu-engineering?start=${start}&end=${end}` +
                           (outletId ? `&outlet_id=${outletId}` : "")),
  });
  const rows: any[] = menu.data?.items ?? [];

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <SectionLabel>Menu engineering</SectionLabel>
          <h2 className="mt-1 font-semibold">Demand with evidence-gated food cost</h2>
          <p className="mt-1 text-sm text-ink-faint">
            Food-cost and recorded contribution signals appear only when every recipe link and purchase cost is compatible.
          </p>
        </div>
        <div className="flex gap-2 text-xs">
          <a className="rounded-md border border-rule-strong px-2.5 py-1.5 hover:bg-paper-3" href="/inventory/links">
            Recipes
          </a>
          <a className="rounded-md border border-rule-strong px-2.5 py-1.5 hover:bg-paper-3" href="/money/unitprices">
            Purchase costs
          </a>
        </div>
      </div>
      {menu.isLoading ? (
        <div className="mt-4 grid animate-pulse gap-2 sm:grid-cols-2">
          <div className="h-20 rounded-md bg-paper-3" />
          <div className="h-20 rounded-md bg-paper-3" />
        </div>
      ) : menu.isError ? (
        <div className="mt-4"><ErrorNote msg="Menu evidence could not be loaded. Try refreshing this analysis." /></div>
      ) : rows.length === 0 ? (
        <EmptyState title="No item-level sales in this range"
                    hint="Import POS item sales to compare dish demand and confirm recipe links before costing dishes." />
      ) : (
        /* A scroll container must be keyboard reachable (WCAG 2.1.1). */
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        <div role="region" tabIndex={0} aria-label="Menu engineering table, scrollable sideways"
             className="mt-4 max-w-full overflow-x-auto rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
          <table className="w-full min-w-[700px] text-left text-sm">
            <caption className="sr-only">
              Dish demand, momentum, food cost and recorded contribution for this range
            </caption>
            <thead className="border-b border-rule text-xs text-ink-faint">
              <tr>
                <th className="pb-2 font-medium">Dish</th>
                <th className="pb-2 font-medium">Demand</th>
                <th className="pb-2 font-medium">Momentum</th>
                <th className="pb-2 font-medium">Food cost</th>
                <th className="pb-2 font-medium">Recorded contribution</th>
                <th className="pb-2 font-medium">Evidence</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-rule">
              {rows.map((row: any) => (
                <tr key={`${row.outlet_id}-${row.item}`}>
                  <td className="py-3 pr-4 font-medium">
                    <div>{row.item}</div>
                    {outletId == null && <div className="mt-0.5 text-xs font-normal text-ink-faint">Outlet {row.outlet_id}</div>}
                  </td>
                  <td className="num py-3 pr-4">{row.sales_velocity_per_day}/day</td>
                  <td className="num py-3 pr-4">
                    {row.momentum_percent == null ? "—" : `${row.momentum_percent > 0 ? "+" : ""}${row.momentum_percent}%`}
                  </td>
                  {row.cost_status === "recorded" ? (
                    <>
                      <td className="num py-3 pr-4">
                        {moneyCfg.symbol}{row.food_cost_per_dish_rupees.toLocaleString("en-IN")} · {row.food_cost_percent}%
                      </td>
                      <td className="num py-3 pr-4">
                        {moneyCfg.symbol}{row.recorded_contribution_after_food_cost_rupees.toLocaleString("en-IN")}
                      </td>
                      <td className="py-3"><Badge tone="good">complete</Badge></td>
                    </>
                  ) : (
                    <td colSpan={3} className="py-3 text-xs text-ink-faint">
                      Withheld · {row.cost_withheld_reason}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-3 text-xs text-ink-faint">
        Recorded contribution is sales less recorded ingredient cost only; it is not profit and excludes labour, rent, and other costs.
      </p>
    </Card>
  );
}
