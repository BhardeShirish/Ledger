import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, ComposedChart, Legend, Line, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import { api } from "../api/client";
import { useOutletContext } from "react-router-dom";
import { addDaysISO, moneyCfg } from "../lib/format";
import { buildPresets, previousRange } from "../lib/ranges";
import { ExportButton } from "../components/DataButtons";
import SpendReview from "../components/SpendReview";
import { PurchasePatterns, TradePatterns } from "../components/Patterns";
import { KotGaps } from "../components/KotGaps";
import { ProfitAndLoss } from "../components/ProfitAndLoss";
import { Badge, Button, Card, EmptyState, ErrorNote, SectionLabel, Spinner, StatTile } from "../components/ui";
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

const METRIC_GROUPS: { group: string; items: { key: string; label: string }[] }[] = [
  {
    group: "Sales",
    items: [
      { key: "sales_total", label: "Total sales" },
      { key: "sales_net", label: "Net sales" },
      { key: "sales_cash", label: "Cash" },
      { key: "sales_upi", label: "UPI" },
      { key: "sales_card", label: "Card" },
      { key: "sales_aggregator", label: "Delivery apps" },
    ],
  },
  {
    group: "Money out",
    items: [
      { key: "expenses", label: "All expenses" },
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
const SERIES_COLORS = ["#C2410C", "#1D4ED8", "#15803D", "#B91C1C", "#7C3AED",
  "#B45309", "#0E7490", "#57534E"];

function medianOrNull(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

export default function Analytics() {
  const { outletId } = useOutletContext<Ctx>();
  const presets = buildPresets();
  const [rangeIdx, setRangeIdx] = useState(4); // This month
  const [custom, setCustom] = useState<{ start: string; end: string } | null>(null);
  const [scopeAll, setScopeAll] = useState(false);
  const [selected, setSelected] = useState<string[]>(["sales_total", "expenses"]);

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

  const data = q.data;
  const salesTotal = data?.totals?.sales_total ?? 0;
  const expensesTotal = data?.totals?.expenses ?? 0;
  const hasSales = salesTotal > 0;
  const facts = qualityFacts(data, rangeDays ?? 0);
  const representedMonth = range.end.slice(0, 7);
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
    const previousTotal = pq.data?.totals?.sales_total ?? 0;
    return {
      typicalDay: medianOrNull(sales),
      averageActiveDay: sales.length ? total / sales.length : null,
      bestDay: sales.length ? Math.max(...sales) : null,
      recordedSpendRate: total > 0 ? expenseTotal / total * 100 : null,
      periodChange: previousTotal > 0 ? (total - previousTotal) / previousTotal * 100 : null,
    };
  }, [data, pq.data]);

  const deltaFor = (key: string): number | null => {
    if (!compare || !pq.data || !data) return null;
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
    if (!compare || !data || !pq.data) return [];
    const prevSeries = pq.data.series?.[primary] ?? [];
    const curSeries = data.series?.[primary] ?? [];
    const n = Math.max(curSeries.length, prevSeries.length);
    return Array.from({ length: n }, (_, i) => ({
      day: `D${i + 1}`,
      current: curSeries[i] ?? null,
      previous: prevSeries[i] ?? null,
    }));
  }, [data, pq.data, primary, compare]);

  const compareBars = useMemo(() => {
    if (!compare) return [];
    void pq.data;
    return selected.map((k) => ({
      metric: LABELS[k] ?? k,
      Current: data?.totals?.[k] ?? 0,
      Previous: pq.data?.totals?.[k] ?? 0,
    }));
  }, [selected, data, pq.data, compare]);

  if (q.isLoading && !data) return <Spinner />;

  const mixData = ["cash", "upi", "card", "aggregator", "wallet"]
    .map((k) => ({
      name: k,
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
          <input type="date" value={custom?.start ?? range.start}
                 min={isISODate(range.end)
                   ? addDaysISO(range.end, -(MAX_ANALYTICS_RANGE_DAYS - 1)) : undefined}
                 max={isISODate(range.end) ? range.end : undefined}
                 onChange={(e) => setCustom({ start: e.target.value, end: custom?.end ?? range.end })}
                 className="rounded-md border border-rule-strong bg-paper px-2 py-1 num" />
          →
          <input type="date" value={custom?.end ?? range.end}
                 min={isISODate(range.start) ? range.start : undefined}
                 max={isISODate(range.start)
                   ? addDaysISO(range.start, MAX_ANALYTICS_RANGE_DAYS - 1) : undefined}
                 onChange={(e) => setCustom({ start: custom?.start ?? range.start, end: e.target.value })}
                 className="rounded-md border border-rule-strong bg-paper px-2 py-1 num" />
          <button onClick={() => setScopeAll(!scopeAll)}
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
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Sales" value={moneyCfg.symbol + salesTotal.toLocaleString("en-IN")}
                    sub={hasSales ? "recorded in this range" : "no sales recorded"} />
        <StatTile label="Expenses" value={moneyCfg.symbol + expensesTotal.toLocaleString("en-IN")}
                    sub="recorded in this range" />
        {hasSales ? (
          <StatTile label="After recorded expenses"
                      value={moneyCfg.symbol + (salesTotal - expensesTotal).toLocaleString("en-IN")}
                      sub="not profit — payroll and other costs excluded" />
        ) : (
          <StatTile label="After recorded expenses" value="—"
                      sub="needs recorded sales; not a profit figure" />
        )}
        <StatTile label="Recording days"
                    value={String(data?.days_recorded ?? 0)}
                    sub={`of ${rangeDays} days in range`} />
      </div>

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
          <SectionLabel>Sales vs recorded expenses over time</SectionLabel>
          <Badge>{data?.days_recorded ?? 0} sales days</Badge>
        </div>
        <p className="mt-1 text-xs text-ink-faint">
          Cumulative values make the gap between money in and recorded spending visible. This is not profit.
        </p>
        <div className="mt-3 h-72">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={cashflowData} margin={{ top: 4, right: 4, bottom: 0, left: -14 }}>
              <CartesianGrid stroke="#EDE6DC" vertical={false} />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} tickLine={false}
                     axisLine={{ stroke: "#E7E0D8" }} tickFormatter={(value: string) => value.slice(8)}
                     interval="preserveStartEnd" />
              <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false}
                     tickFormatter={(value: number) => value >= 1000 ? `${Math.round(value / 1000)}k` : String(value)} />
              <Tooltip formatter={(value: number, name: string) =>
                [`${moneyCfg.symbol}${Number(value).toLocaleString("en-IN")}`,
                  name === "sales" ? "Sales" : "Recorded expenses"]}
                       labelFormatter={(label) => fmtDay(label)}
                       contentStyle={{ background: "#FAF7F2", border: "1px solid #E7E0D8", borderRadius: 8 }} />
              <Legend formatter={(value) => value === "sales" ? "Sales" : "Recorded expenses"} />
              <Area type="monotone" dataKey="sales" stroke="#C2410C" strokeWidth={2.25}
                    fill="#C2410C" fillOpacity={0.08} />
              <Area type="monotone" dataKey="expenses" stroke="#B91C1C" strokeWidth={1.75}
                    fill="#B91C1C" fillOpacity={0.05} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </Card>

      <Card className="space-y-2.5 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <SectionLabel>Attention & recording quality</SectionLabel>
          <span className="text-xs text-ink-faint">deterministic checks from your books</span>
        </div>
        <ul className="space-y-2">
          {facts.map((fact, index) => (
            <li key={`${fact.title ?? fact.label}-${index}`}
                className="flex flex-wrap items-start gap-2 text-sm">
              <Badge tone={toneFor(fact)}>{fact.severity === "act" ? "Act on this"
                : fact.severity === "watch" ? "Keep an eye" : "For info"}</Badge>
              <span>
                <span className="font-semibold">{fact.title ?? fact.label}</span>
                {fact.detail && <span className="text-ink-soft"> · {fact.detail}</span>}
              </span>
            </li>
          ))}
        </ul>
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

      {/* Metric picker — order of clicking = order of importance */}
      <Card className="space-y-2.5 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <SectionLabel>Explore other metrics</SectionLabel>
          <span className="text-xs text-ink-faint">
            first pick leads the chart · tap again to remove
          </span>
        </div>
        {METRIC_GROUPS.map((g) => (
          <div key={g.group} className="flex flex-wrap items-center gap-1.5">
            <span className="w-20 shrink-0 text-xs text-ink-faint">{g.group}</span>
            {g.items.map((it) => {
              const idx = selected.indexOf(it.key);
              return (
                <button key={it.key} onClick={() => pick(it.key)}
                        className={`rounded-full border px-3 py-1 text-sm ${
                          idx >= 0 ? "border-accent bg-accent-soft font-semibold text-accent"
                                   : "border-rule-strong hover:bg-paper-3"}`}>
                  {it.label}{idx > 0 ? ` #${idx + 1}` : ""}
                </button>
              );
            })}
          </div>
        ))}
        {selected.length === 0 && (
          <p className="text-sm text-ink-faint">Pick at least one metric.</p>
        )}
      </Card>

      {/* Stat tiles in selection order, with period deltas */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {selected.map((k, i) => {
          const total = data?.totals?.[k] ?? 0;
          const sub = k.startsWith("sales_") || k === "expenses"
            ? `avg ₹${Math.round(total / Math.max(1, data?.days.length ?? 1)).toLocaleString("en-IN")}/day`
            : undefined;
          const share = i > 0 && primary && data?.totals?.[primary]
            ? `${Math.round((total / data.totals[primary]) * 100)}% of ${LABELS[primary]}`
            : undefined;
          const d = deltaFor(k);
          return (
            <div key={k} className="relative">
              <StatTile label={`${i === 0 ? "★ " : ""}${LABELS[k] ?? k}`}
                        value={moneyCfg.symbol + total.toLocaleString("en-IN")}
                        sub={share ?? sub} />
              {d != null && (
                <span className={`absolute right-3 top-3 inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[11px] font-semibold ${
                  d === 0 ? "bg-paper-3 text-ink-faint"
                  : (d > 0) === upIsGood(k) ? "bg-good/10 text-good"
                    : "bg-bad/10 text-bad"}`}>
                  {d > 0 ? <ArrowUpRight size={11} /> : <ArrowDownRight size={11} />}
                  {Math.abs(d)}%
                </span>
              )}
            </div>
          );
        })}
        {compare && (
          <button onClick={() => setCompare(false)}
                  className="self-start rounded-full border border-rule-strong px-3 py-1 text-xs text-ink-faint hover:bg-paper-3">
            comparing vs {prev.label} — hide
          </button>
        )}
        {!compare && (
          <button onClick={() => setCompare(true)}
                  className="self-start rounded-full border border-dashed border-rule-strong px-3 py-1 text-xs text-ink-faint hover:bg-paper-3">
            compare with previous period
          </button>
        )}
      </div>

      {/* Main comparison chart */}
      {(data?.days_recorded ?? 0) === 0 && (
        <Card className="p-4 text-center">
          <p className="text-sm font-medium">No days with data in {range.label.toLowerCase()}.</p>
          <p className="mt-1 text-sm text-ink-faint">
            The charts below are empty for this reason — pick a wider range above,
            such as “Last 90 days” or “All time”.
          </p>
        </Card>
      )}
      <Card className="p-4">
        <div className="flex items-center justify-between">
          <SectionLabel>Daily metric comparison · {range.label}</SectionLabel>
          <Badge>{data?.days_recorded ?? 0} active days</Badge>
        </div>
        <div className="mt-3 h-72">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={chartData}
                           margin={{ top: 4, right: 4, bottom: 0, left: -14 }}>
              <CartesianGrid stroke="#EDE6DC" vertical={false} />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} tickLine={false}
                     axisLine={{ stroke: "#E7E0D8" }}
                     tickFormatter={(v: string) => v.slice(8)}
                     interval="preserveStartEnd" />
              <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false}
                     tickFormatter={(v: any) => v >= 1000 ? `${Math.round(v / 1000)}k` : v} />
              <Tooltip formatter={(v: any, n: any) =>
                    [`${moneyCfg.symbol}${Number(v).toLocaleString("en-IN")}`, LABELS[n] ?? n]}
                       labelStyle={{ color: "#57534E" }} labelFormatter={(l) => fmtDay(l)}
                       contentStyle={{ background: "#FAF7F2", border: "1px solid #E7E0D8", borderRadius: 8 }} />
              <Legend formatter={(v) => LABELS[v] ?? v} iconType="plainline" />
              {selected.map((k, i) => (
                <Line key={k} type="monotone" dataKey={k}
                      stroke={SERIES_COLORS[i % SERIES_COLORS.length]}
                      strokeWidth={i === 0 ? 2.5 : 1.75}
                      dot={false} activeDot={{ r: 3 }} />
              ))}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </Card>

      {/* Period comparison: totals side by side */}
      {compare && compareBars.length > 0 && (
        <Card className="p-4">
          <SectionLabel>
            Current vs previous · {range.label} vs {prev.label}
          </SectionLabel>
          <div className="mt-3 h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={compareBars} margin={{ top: 4, right: 4, bottom: 0, left: -14 }}>
                <CartesianGrid stroke="#EDE6DC" vertical={false} />
                <XAxis dataKey="metric" tick={{ fontSize: 11 }} tickLine={false}
                       axisLine={{ stroke: "#E7E0D8" }} interval={0} />
                <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false}
                       tickFormatter={(v: any) => v >= 1000 ? `${Math.round(v / 1000)}k` : v} />
                <Tooltip formatter={(v: any, n: any) =>
                      [`${moneyCfg.symbol}${Number(v).toLocaleString("en-IN")}`, n]}
                         contentStyle={{ background: "#FAF7F2", border: "1px solid #E7E0D8", borderRadius: 8 }} />
                <Legend />
                <Bar dataKey="Previous" fill="#A8A29E" radius={[4, 4, 0, 0]} maxBarSize={34} />
                <Bar dataKey="Current" fill="#C2410C" radius={[4, 4, 0, 0]} maxBarSize={34} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
      )}

      {/* Primary metric day-by-day overlay */}
      {compare && overlayData.length > 1 && (
        <Card className="p-4">
          <SectionLabel>
            Day-by-day · {LABELS[primary] ?? primary} — current vs previous
          </SectionLabel>
          <div className="mt-3 h-56">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={overlayData} margin={{ top: 4, right: 4, bottom: 0, left: -14 }}>
                <CartesianGrid stroke="#EDE6DC" vertical={false} />
                <XAxis dataKey="day" tick={{ fontSize: 10 }} tickLine={false}
                       axisLine={{ stroke: "#E7E0D8" }} interval="preserveStartEnd" />
                <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false}
                       tickFormatter={(v: any) => v >= 1000 ? `${Math.round(v / 1000)}k` : v} />
                <Tooltip formatter={(v: any, n: any) =>
                      [`${moneyCfg.symbol}${Number(v).toLocaleString("en-IN")}`,
                       n === "current" ? "Current" : "Previous"]}
                         labelStyle={{ color: "#57534E" }}
                         contentStyle={{ background: "#FAF7F2", border: "1px solid #E7E0D8", borderRadius: 8 }} />
                <Legend />
                <Line type="monotone" dataKey="previous" stroke="#A8A29E"
                      strokeWidth={1.75} strokeDasharray="5 4" dot={false} />
                <Line type="monotone" dataKey="current" stroke="#C2410C"
                      strokeWidth={2.25} dot={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
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
                <div key={k} className="flex items-center gap-2 text-sm">
                  <span className="w-28 shrink-0 truncate text-ink-soft">{LABELS[k]}</span>
                  <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-paper-3">
                    <div className="h-full rounded-full"
                         style={{ width: `${(v / max) * 100}%`,
                                  background: SERIES_COLORS[selected.indexOf(k) % SERIES_COLORS.length] }} />
                  </div>
                  <span className="num w-28 shrink-0 text-right font-medium">
                    {moneyCfg.symbol}{v.toLocaleString("en-IN")}
                  </span>
                  {i === 0 && <Badge tone="accent">top</Badge>}
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
                <XAxis dataKey="day" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
                <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} hide />
                <Tooltip formatter={(v: any) => [`${moneyCfg.symbol}${Number(v).toLocaleString("en-IN")}`, "avg"]}
                         contentStyle={{ background: "#FAF7F2", border: "1px solid #E7E0D8", borderRadius: 8 }} />
                <Bar dataKey="avg" fill="#C2410C" radius={[4, 4, 0, 0]} maxBarSize={38} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>

        {/* Channel mix */}
        {mixData.length > 1 && (
          <Card className="p-4">
            <SectionLabel>Channel mix in range</SectionLabel>
            <div className="mt-2 flex items-center gap-4">
              <ResponsiveContainer width={150} height={150}>
                <PieChart>
                  <Pie data={mixData} dataKey="value" nameKey="name"
                       innerRadius={44} outerRadius={68} paddingAngle={2} stroke="#FAF7F2">
                    {mixData.map((_, i) => (
                      <Cell key={i} fill={SERIES_COLORS[i % SERIES_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(v: any) => `${moneyCfg.symbol}${Number(v).toLocaleString("en-IN")}`}
                           contentStyle={{ background: "#FAF7F2", border: "1px solid #E7E0D8", borderRadius: 8 }} />
                </PieChart>
              </ResponsiveContainer>
              <ul className="flex-1 space-y-1 text-sm">
                {mixData.sort((a, b) => b.value - a.value).map((m, i) => (
                  <li key={m.name} className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full"
                          style={{ background: SERIES_COLORS[i % SERIES_COLORS.length] }} />
                    <span className="capitalize">{m.name}</span>
                    <span className="num ml-auto font-medium">
                      {moneyCfg.symbol}{m.value.toLocaleString("en-IN")}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
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
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[700px] text-left text-sm">
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

function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
