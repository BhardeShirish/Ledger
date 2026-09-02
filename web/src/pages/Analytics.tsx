import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import {
  Bar, BarChart, CartesianGrid, Cell, ComposedChart, Legend, Line, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import { api, downloadFile } from "../api/client";
import { useOutletContext } from "react-router-dom";
import { moneyCfg } from "../lib/format";
import { buildPresets, previousRange } from "../lib/ranges";
import { ExportButton } from "../components/DataButtons";
import { Badge, Button, Card, SectionLabel, Spinner, StatTile } from "../components/ui";
import { MenuItems } from "./MenuItems";
function fmtDay(iso: string) {
  return new Date(iso + "T12:00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

type Ctx = { outletId: number };

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

export default function Analytics() {
  const { outletId } = useOutletContext<Ctx>();
  const presets = buildPresets();
  const [rangeIdx, setRangeIdx] = useState(4); // This month
  const [custom, setCustom] = useState<{ start: string; end: string } | null>(null);
  const [scopeAll, setScopeAll] = useState(false);
  const [selected, setSelected] = useState<string[]>(["sales_total"]);

  const range = custom
    ? { ...custom, label: "Custom" }
    : presets[rangeIdx];
  const [compare, setCompare] = useState(true);
  const prev = previousRange({ ...range });
  const q = useQuery({
    queryKey: ["analytics", range.start, range.end, scopeAll ? null : outletId],
    queryFn: () =>
      api.get(`/stats/analytics?start=${range.start}&end=${range.end}` +
              (scopeAll || !outletId ? "" : `&outlet_id=${outletId}`)),
  });
  const pq = useQuery({
    queryKey: ["analytics-prev", prev.start, prev.end, scopeAll ? null : outletId],
    queryFn: () =>
      api.get(`/stats/analytics?start=${prev.start}&end=${prev.end}` +
              (scopeAll || !outletId ? "" : `&outlet_id=${outletId}`)),
    enabled: compare,
  });

  const data = q.data;
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
        <SectionLabel>Insights · Analysis</SectionLabel>
        <h1 className="text-2xl font-semibold tracking-tight">Compare anything</h1>
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
                 onChange={(e) => setCustom({ start: e.target.value, end: custom?.end ?? range.end })}
                 className="rounded-md border border-rule-strong bg-paper px-2 py-1 num" />
          →
          <input type="date" value={custom?.end ?? range.end}
                 onChange={(e) => setCustom({ start: custom?.start ?? range.start, end: e.target.value })}
                 className="rounded-md border border-rule-strong bg-paper px-2 py-1 num" />
          <button onClick={() => setScopeAll(!scopeAll)}
                  className={`ml-auto rounded-full border px-3 py-1 ${
                    scopeAll ? "border-accent bg-accent-soft text-accent" : "border-rule-strong"}`}>
            All outlets
          </button>
        </div>
      </Card>

      {/* Metric picker — order of clicking = order of importance */}
      <Card className="space-y-2.5 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <SectionLabel>Pick metrics to compare</SectionLabel>
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
          <SectionLabel>Daily comparison · {range.label}</SectionLabel>
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
    </div>
  );
}

function MenuEngineering({ outletId, start, end }: {
  outletId: number | null; start: string; end: string;
}) {
  const dp = useQuery({
    queryKey: ["dish-profit", outletId, start, end],
    queryFn: () => api.get(`/inventory/dish-profitability?start=${start}&end=${end}` +
                           (outletId ? `&outlet_id=${outletId}` : "")),
  });

  if (dp.isLoading) return null;
  const rows: any[] = (dp.data ?? []).filter((r: any) => r.has_recipe);
  if (rows.length < 3) return null;

  const medPop = median(rows.map((r) => r.qty));
  const medMargin = median(rows.map((r) => r.margin_percent ?? 0));
  const quadrant = (r: any) => {
    const pop = r.qty >= medPop, prof = (r.margin_percent ?? 0) >= medMargin;
    return pop && prof ? { label: "★ Star", tone: "good" }
         : pop ? { label: "Plowhorse", tone: "warn" }
         : prof ? { label: "Puzzle", tone: "accent" }
         : { label: "Dog", tone: "bad" };
  };

  return (
    <Card className="p-4">
      <SectionLabel>Menu engineering · popularity vs profitability</SectionLabel>
      <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { key: "star", title: "★ Stars", hint: "popular + profitable", tone: "good" },
          { key: "plow", title: "Plowhorses", hint: "popular, thin margin", tone: "warn" },
          { key: "puzzle", title: "Puzzles", hint: "profitable, slow", tone: "accent" },
          { key: "dog", title: "Dogs", hint: "neither — consider cutting", tone: "bad" },
        ].map((q) => {
          const list = rows.filter((r: any) => quadrant(r).label.includes(q.title.replace("★ ", "")));
          return (
            <div key={q.key} className={`rounded-md border p-3 ${
              q.tone === "good" ? "border-good/40 bg-good/5"
              : q.tone === "warn" ? "border-amber-300 bg-amber-50"
              : q.tone === "bad" ? "border-bad/40 bg-bad/5"
              : "border-accent/40 bg-accent-soft"}`}>
              <div className="text-xs font-bold uppercase tracking-wide">{q.title}</div>
              <div className="mt-1 space-y-0.5 text-xs">
                {list.slice(0, 5).map((r: any) => (
                  <div key={r.item} className="flex justify-between gap-1">
                    <span className="truncate">{r.item}</span>
                    <span className="num shrink-0">{r.margin_percent}%</span>
                  </div>
                ))}
                {list.length === 0 && <div className="text-ink-faint">none</div>}
              </div>
            </div>
          );
        })}
      </div>
      <p className="mt-2 text-xs text-ink-faint">
        median popularity {Math.round(medPop)} plates · median margin {medMargin}%
        · ingredient costs from confirmed auto-recipes
      </p>
    </Card>
  );
}

function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
