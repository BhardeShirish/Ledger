import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useOutletContext } from "react-router-dom";
import { useMemo, useState } from "react";
import {
  Area, AreaChart, Cell, Pie, PieChart, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from "recharts";
import { api } from "../api/client";
import { useGuarded } from "../lib/auth";
import { useAuth } from "../lib/auth";
import { fmtDateShort, inr, monthLabel, monthLabelShort } from "../lib/format";
import { Badge, Button, Card, SectionLabel, Spinner, StatTile } from "../components/ui";
import { EmptyMonthHint } from "../components/EmptyMonthHint";

type Ctx = { outletId: number };
const PIE_COLORS = ["#C2410C", "#EA580C", "#F59E0B", "#78716C", "#57534E",
  "#A8A29E", "#D97706", "#9A3412", "#78350F", "#44403C"];

export default function Reports() {
  const { outletId } = useOutletContext<Ctx>();
  const { me } = useAuth();
  const [monthOffset, setMonthOffset] = useState(0);
  const [scopeAll, setScopeAll] = useState(false);

  const month = useMemo(() => {
    const d = new Date();
    d.setDate(1);
    d.setMonth(d.getMonth() + monthOffset);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  }, [monthOffset]);

  const q = useQuery({
    queryKey: ["dashboard", scopeAll ? null : outletId, month],
    queryFn: () => api.get(`/stats/dashboard?month=${month}${!scopeAll && outletId ? `&outlet_id=${outletId}` : ""}`),
  });

  if (q.isLoading) return <Spinner />;
  const d = q.data;
  if (!d) return <Spinner />;

  // Sales recorded but no payroll accrued means rent/salaries are missing from the
  // maths, so "profit" and "margin" are overstated. Don't dress them up as good news.
  const costsIncomplete = d.sales_total_rupees > 0 && (d.payroll_accrual_rupees ?? 0) === 0;
  const costsNote = "payroll not run — real profit is lower";

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <SectionLabel>Insights</SectionLabel>
          <h1 className="text-2xl font-semibold tracking-tight">{monthLabel(month)}</h1>
        </div>
        <div className="flex items-center gap-2 text-sm">
          {me?.role === "owner" && me.outlet_ids.length > 1 && (
            <button onClick={() => setScopeAll(!scopeAll)}
              className={`rounded-md border px-2.5 py-1.5 font-medium ${scopeAll ? "border-accent bg-accent-soft text-accent" : "border-rule-strong"}`}>
              All outlets
            </button>
          )}
          <button className="rounded border border-rule-strong px-2 py-1"
                  onClick={() => setMonthOffset(monthOffset - 1)}>‹</button>
          <span className="min-w-[5.5rem] px-1 text-center font-medium">{monthLabelShort(month)}</span>
          <button disabled={monthOffset >= 0}
                  className="rounded border border-rule-strong px-2 py-1 disabled:opacity-40"
                  onClick={() => setMonthOffset(monthOffset + 1)}>›</button>
        </div>
      </header>

      <EmptyMonthHint
        month={month}
        outletId={scopeAll ? null : outletId}
        onJump={(target) => {
          const now = new Date();
          const [ty, tm] = target.split("-").map(Number);
          setMonthOffset((ty! - now.getFullYear()) * 12 + (tm! - (now.getMonth() + 1)));
        }}
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Sales" value={inr(Math.round(d.sales_total_rupees * 100))} />
        <StatTile label="Expenses" value={inr(Math.round(d.expense_total_rupees * 100))} />
        <StatTile label="Avg / working day"
                  value={inr(Math.round((d.avg_day_rupees ?? 0) * 100))}
                  sub={`${d.days_recorded} days recorded`} />
        {me?.role === "owner" ? (
          <StatTile label="Profit estimate" value={inr(Math.round((d.profit_rupees ?? 0) * 100))}
                    tone={costsIncomplete ? undefined : profitTone(d.profit_rupees, d.days_recorded)}
                    sub={costsIncomplete ? costsNote
                         : d.best_day ? `best: ${fmtDateShort(d.best_day.date)} · ${inr(Math.round(d.best_day.total_rupees * 100))}` : undefined} />
        ) : (
          <StatTile label="Days with data" value={String(d.days_recorded)} />
        )}
      </div>
      {me?.role === "owner" && (
        <div className={`grid grid-cols-2 gap-3 ${(d.loss_total_rupees ?? 0) > 0 ? "lg:grid-cols-5" : "lg:grid-cols-4"}`}>
          <StatTile label="Payroll accrual" value={inr(Math.round((d.payroll_accrual_rupees ?? 0) * 100))}
                    sub={`${d.labor_cost_percent}% of sales`} />
          {(d.loss_total_rupees ?? 0) > 0 && (
            <StatTile label="Losses" value={inr(Math.round((d.loss_total_rupees ?? 0) * 100))}
                      tone="bad" sub="refunds, wastage, cash short" />
          )}
          <StatTile label="Tips collected" value={inr(Math.round((d.tips_rupees ?? 0) * 100))} />
          <StatTile label="Cash variance" value={inr(Math.round((d.cash_variance_rupees ?? 0) * 100), { sign: true })}
                    tone={d.days_recorded === 0 ? undefined
                          : (d.cash_variance_rupees ?? 0) === 0 ? "good" : "bad"} />
          <StatTile label="Net margin"
                    sub={costsIncomplete ? costsNote : "sales − expenses − payroll − losses"}
                    value={d.sales_total_rupees > 0
                      ? `${Math.round(((d.profit_rupees ?? 0) / d.sales_total_rupees) * 100)}%`
                      : "—"}
                    tone={costsIncomplete ? undefined : profitTone(d.profit_rupees, d.days_recorded)} />
        </div>
      )}

      {/* Trend: sales vs expenses */}
      <Card className="p-4">
        <SectionLabel>Daily sales vs expenses</SectionLabel>
        {(d.trend ?? []).length === 0 ? (
          <p className="py-10 text-center text-sm text-ink-faint">
            No days recorded in {monthLabel(month)}.
          </p>
        ) : (
        <div className="mt-3 h-56">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={d.trend} margin={{ top: 4, right: 4, bottom: 0, left: -18 }}>
              <XAxis dataKey="date" tickFormatter={fmtDateShort} tick={{ fontSize: 11 }}
                     tickLine={false} axisLine={{ stroke: "#E7E0D8" }} interval="preserveStartEnd" />
              <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false}
                     tickFormatter={(v: any) => v >= 1000 ? `${Math.round(v / 1000)}k` : String(v)} />
              <Tooltip formatter={(v: any, name: any) =>
                    [`₹${Number(v).toLocaleString("en-IN")}`, name === "total_rupees" ? "Sales" : "Expenses"]}
                       labelStyle={{ color: "#57534E" }}
                       contentStyle={{ background: "#FAF7F2", border: "1px solid #E7E0D8", borderRadius: 8 }} />
              <Area type="monotone" dataKey="total_rupees" stroke="#C2410C" strokeWidth={2}
                    fill="#C2410C" fillOpacity={0.08} />
              <Area type="monotone" dataKey="expense_rupees" stroke="#B91C1C" strokeWidth={1.5}
                    fill="#B91C1C" fillOpacity={0.06} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
        )}
      </Card>

      <div className="grid gap-3 md:grid-cols-2">
        {/* Payment mix */}
        <Card className="p-4">
          <SectionLabel>How money came in</SectionLabel>
          <div className="mt-2 space-y-1.5">
            {d.modes.map((m: any) => (
              <div key={m.kind} className="flex items-center gap-2 text-sm">
                <span className="w-24 capitalize text-ink-soft">{m.kind}</span>
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-paper-3">
                  <div className="h-full rounded-full bg-accent/70"
                       style={{ width: `${pct(m.net_rupees, d.modes)}%` }} />
                </div>
                <span className="num w-24 text-right font-medium">
                  {inr(Math.round(m.net_rupees * 100))}
                </span>
              </div>
            ))}
            {d.modes.length === 0 && <p className="py-4 text-center text-sm text-ink-faint">No sales this month.</p>}
            {(d.tips_rupees ?? 0) > 0 && (
              <div className="mt-2 flex items-center justify-between border-t border-rule pt-2 text-sm">
                <span className="text-ink-soft">Tips collected</span>
                <span className="num font-medium">{inr(Math.round(d.tips_rupees * 100))}</span>
              </div>
            )}
          </div>
        </Card>

        {/* Expense donut */}
        <Card className="p-4">
          <SectionLabel>Where expenses went</SectionLabel>
          {d.expense_donut.length === 0 ? (
            <p className="py-6 text-center text-sm text-ink-faint">No expenses this month.</p>
          ) : (
            <div className="mt-2 flex items-center gap-3">
              <ResponsiveContainer width={140} height={140}>
                <PieChart>
                  <Pie data={d.expense_donut} dataKey="rupees" nameKey="name"
                       innerRadius={42} outerRadius={64} paddingAngle={2}
                       stroke="#FAF7F2">
                    {d.expense_donut.map((_: any, i: number) => (
                      <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(v: any) => `₹${Number(v).toLocaleString("en-IN")}`}
                           contentStyle={{ background: "#FAF7F2", border: "1px solid #E7E0D8", borderRadius: 8 }} />
                </PieChart>
              </ResponsiveContainer>
              <ul className="min-w-0 flex-1 space-y-0.5 overflow-hidden text-xs">
                {d.expense_donut.slice(0, 6).map((e: any, i: number) => (
                  <li key={i} className="flex items-center gap-1.5">
                    <span className="h-2 w-2 shrink-0 rounded-full"
                          style={{ background: PIE_COLORS[i % PIE_COLORS.length] }} />
                    <span className="truncate">{e.name}</span>
                    <span className="num ml-auto shrink-0 font-medium">₹{e.rupees.toLocaleString("en-IN")}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>
      </div>

      {/* Cash gaps (owner only) */}
      {me?.role === "owner" && (
        <Card className="px-4 py-3.5">
          <SectionLabel>Cash discipline</SectionLabel>
          {d.cash_gap_days.length === 0 ? (
            d.days_recorded === 0
              ? <p className="mt-1 text-sm text-ink-soft">No days closed yet, so there is nothing to check.</p>
              : <p className="mt-1 text-sm text-good">No suspicious cash variances this month ✓</p>
          ) : (
            <div className="mt-2 space-y-1">
              {d.cash_gap_days.map((g: any) => (
                <div key={g.date} className="flex justify-between text-sm">
                  <span className="text-ink-soft">{fmtDateShort(g.date)}</span>
                  <span className="num font-medium text-bad">{inr(Math.round(g.variance_rupees * 100), { sign: true })}</span>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      <InsightCards outletId={scopeAll ? null : outletId} month={month}
                    daysRecorded={d.days_recorded} />
    </div>
  );
}

function InsightCards({ outletId, month, daysRecorded }:
  { outletId: number | null; month: string; daysRecorded: number }) {
  const { me } = useAuth();
  const qc = useQueryClient();
  const fc = useQuery({
    queryKey: ["forecast", outletId, month],
    queryFn: () => api.get(`/insights/forecast?month=${month}${outletId ? `&outlet_id=${outletId}` : ""}`),
  });
  const an = useQuery({
    queryKey: ["anomalies", outletId, month],
    queryFn: () => api.get(`/insights/anomalies?month=${month}${outletId ? `&outlet_id=${outletId}` : ""}`),
  });
  const bg = useQuery({
    queryKey: ["budgets", outletId, month],
    queryFn: () => api.get(`/insights/budgets?month=${month}${outletId ? `&outlet_id=${outletId}` : ""}`),
  });
  const be = useQuery({
    queryKey: ["breakeven", outletId, month],
    queryFn: () => api.get(`/insights/breakeven?month=${month}${outletId ? `&outlet_id=${outletId}` : ""}`),
  });
  const [y, m] = month.split("-").map(Number);
  const monthStart = `${month}-01`;
  const monthEnd = `${month}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}`;
  const multiOutlet = (me?.outlet_ids?.length ?? 0) > 1;
  const bm = useQuery({
    enabled: multiOutlet,
    queryKey: ["benchmark", monthStart, monthEnd],
    queryFn: () => api.get(`/insights/benchmark?start=${monthStart}&end=${monthEnd}`),
  });
  const [targetInput, setTargetInput] = useState("");
  const guarded = useGuarded();

  const setTarget = useMutation({
    mutationFn: () => {
      const oid = outletId ?? me?.outlet_ids?.[0];
      return guarded(() => api.put("/insights/target",
        { outlet_id: oid, month, amount_rupees: Number(targetInput) }));
    },
    onSuccess: () => { setTargetInput(""); qc.invalidateQueries({ queryKey: ["forecast"] }); },
  });

  return (
    <>
      {/* Forecast & pace */}
      {!fc.isLoading && fc.data && (
        <Card className="p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <SectionLabel>Month forecast</SectionLabel>
            <Badge tone={fc.data.on_track === undefined ? "neutral"
                          : fc.data.on_track ? "good" : "warn"}>
              {fc.data.on_track === undefined
                ? "no target set"
                : fc.data.on_track ? "on track" : "behind target"}
            </Badge>
          </div>
          <div className="num mt-1 text-2xl font-semibold">
            {inr(Math.round((fc.data.projected_rupees ?? 0) * 100))}
            <span className="ml-1 text-sm font-normal text-ink-faint">projected month-end</span>
          </div>
          {!!fc.data.target_rupees && (
            <div className="mt-2">
              <div className="h-2 overflow-hidden rounded-full bg-paper-3">
                <div className={`h-full rounded-full ${fc.data.on_track ? "bg-good" : "bg-bad"}`}
                     style={{ width: `${Math.min(100, fc.data.percent_of_target)}%` }} />
              </div>
              <p className="mt-1 text-xs text-ink-faint">
                {fc.data.percent_of_target}% of {inr(Math.round(fc.data.target_rupees * 100))} target
                {(!fc.data.on_track) && ` · need ₹${Math.round(fc.data.pace_needed_per_day_rupees).toLocaleString("en-IN")}/day`}
              </p>
            </div>
          )}
          {me?.role === "owner" && (
            <div className="mt-2.5 flex items-center gap-1.5">
              <input inputMode="decimal" placeholder="Set monthly target ₹"
                     value={targetInput} onChange={(e) => setTargetInput(e.target.value)}
                     onKeyDown={(e) => e.key === "Enter" && Number(targetInput) > 0
                       && !setTarget.isPending && setTarget.mutate()}
                     className="w-40 rounded-md border border-rule-strong bg-paper px-2 py-1 num text-sm" />
              <Button size="sm" variant="ghost"
                      disabled={!(Number(targetInput) > 0) || setTarget.isPending}
                      onClick={() => setTarget.mutate()}>
                {setTarget.isPending ? "Saving…" : "Save"}
              </Button>
            </div>
          )}
        </Card>
      )}

      {/* Anomalies */}
      {!an.isLoading && (
        <Card className="p-4">
          <SectionLabel>Watch-outs this month</SectionLabel>
          {(an.data ?? []).length === 0 ? (
            daysRecorded === 0
              ? <p className="mt-1 text-sm text-ink-soft">Nothing logged this month yet.</p>
              : <p className="mt-1 text-sm text-good">Nothing unusual detected ✓</p>
          ) : (
            <ul className="mt-1.5 max-h-44 space-y-1 overflow-y-auto text-sm">
              {an.data.map((a: any, i: number) => (
                <li key={i} className="flex items-start gap-2">
                  <Badge tone={a.severity === "high" ? "bad" : "warn"}>{a.type.replace("_", " ")}</Badge>
                  <span className="min-w-0 flex-1 truncate">{fmtDateShort(a.date)} — {a.detail}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {/* Budget usage (owner sets, both see burn) */}
      {!bg.isLoading && (bg.data ?? []).length > 0 && (
        <Card className="p-4 lg:col-span-2">
          <div className="flex items-center justify-between">
            <SectionLabel>Category budgets</SectionLabel>
            {me?.role !== "owner" && <span className="text-xs text-ink-faint">set by owner</span>}
          </div>
          <div className="mt-2 space-y-1.5">
            {(bg.data ?? []).map((b: any) => (
              <div key={b.category_id} className="flex items-center gap-2 text-sm">
                <span className="w-36 shrink-0 truncate text-ink-soft">{b.category}</span>
                <div className={`h-2 flex-1 overflow-hidden rounded-full ${b.over ? "bg-bad/15" : "bg-paper-3"}`}>
                  <div className={`h-full rounded-full ${b.over ? "bg-bad" :
                        b.percent_used > 80 ? "bg-amber-500" : "bg-good"}`}
                       style={{ width: `${Math.min(100, b.percent_used)}%` }} />
                </div>
                <span className="num w-32 shrink-0 text-right">
                  {inr(Math.round(b.used_rupees * 100))} / {inr(Math.round(b.budget_rupees * 100))}
                </span>
                <Badge tone={b.over ? "bad" : b.percent_used > 80 ? "warn"
                              : b.used_rupees > 0 ? "good" : "neutral"}>
                  {b.percent_used}%
                </Badge>
              </div>
            ))}
          </div>
        </Card>
      )}
      {/* Break-even */}
      {!be.isLoading && be.data && (
        <Card className="p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <SectionLabel>Break-even</SectionLabel>
            <Badge tone={be.data.coverage_percent == null ? "neutral"
                          : be.data.breakeven_met ? "good" : "warn"}>
              {be.data.coverage_percent == null ? "no costs recorded"
                : be.data.breakeven_met ? "covered" : "not covered yet"}
            </Badge>
          </div>
          {be.data.coverage_percent == null ? (
            <p className="mt-1 text-sm text-ink-faint">
              Record expenses or run payroll to see break-even.
            </p>
          ) : (
            <>
              <div className="num mt-1 text-2xl font-semibold">
                {be.data.coverage_percent}%
                <span className="ml-2 text-sm font-normal text-ink-faint">of costs covered by sales</span>
              </div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-paper-3">
                <div className={`h-full rounded-full ${be.data.breakeven_met ? "bg-good" : "bg-bad"}`}
                     style={{ width: `${Math.min(100, be.data.coverage_percent)}%` }} />
              </div>
              {be.data.fixed_costs_rupees === 0 && (
                <p className="mt-1.5 text-xs text-amber-700">
                  No rent, salaries or other fixed costs recorded this month — the real
                  break-even is higher than this.
                </p>
              )}
            </>
          )}
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
            <BeRow label="Sales" value={inr(Math.round(be.data.sales_rupees * 100))} />
            <BeRow label="Fixed + payroll" value={inr(Math.round(be.data.fixed_costs_rupees * 100))} />
            <BeRow label="Variable" value={inr(Math.round(be.data.variable_costs_rupees * 100))} />
            <BeRow label="Daily nut" value={inr(Math.round(be.data.fixed_cover_per_day_rupees * 100))} />
            {be.data.cost_per_bill_rupees != null && (
              <BeRow label="Cost per bill" value={inr(Math.round(be.data.cost_per_bill_rupees * 100))} />
            )}
            {be.data.bills_count > 0 && (
              <BeRow label="Bills" value={be.data.bills_count.toLocaleString("en-IN")} />
            )}
          </dl>
        </Card>
      )}

      {/* Outlet benchmark */}
      {multiOutlet && !bm.isLoading && (bm.data ?? []).length > 1 && (
        <Card className="p-4 lg:col-span-2">
          <SectionLabel>Outlet comparison</SectionLabel>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[34rem] text-sm">
              <thead>
                <tr className="border-b border-rule text-xs uppercase tracking-wide text-ink-faint">
                  <th className="py-1 text-left font-medium">Outlet</th>
                  <th className="py-1 text-right font-medium">Sales</th>
                  <th className="py-1 text-right font-medium">Expenses</th>
                  <th className="py-1 text-right font-medium">Losses</th>
                  <th className="py-1 text-right font-medium">Profit</th>
                  <th className="py-1 text-right font-medium">Avg / active day</th>
                  <th className="py-1 text-right font-medium">Best day</th>
                </tr>
              </thead>
              <tbody>
                {bm.data.map((o: any, i: number) => (
                  <tr key={o.outlet_id} className="border-b border-rule/60 last:border-0">
                    <td className="py-1.5 pr-2">
                      <span className="truncate">{o.name}</span>
                      {i === 0 && <span className="ml-1.5"><Badge tone="good">top</Badge></span>}
                    </td>
                    <td className="num py-1.5 text-right">{inr(Math.round(o.sales_rupees * 100))}</td>
                    <td className="num py-1.5 text-right text-ink-soft">{inr(Math.round(o.expenses_rupees * 100))}</td>
                    <td className="num py-1.5 text-right text-ink-soft">{inr(Math.round((o.losses_rupees ?? 0) * 100))}</td>
                    <td className={`num py-1.5 text-right font-medium ${o.profit_rupees < 0 ? "text-bad" : "text-good"}`}>
                      {inr(Math.round(o.profit_rupees * 100))}
                    </td>
                    <td className="num py-1.5 text-right">
                      {inr(Math.round(o.avg_active_day_rupees * 100))}
                      <span className="ml-1 text-xs text-ink-faint">({o.active_days}d)</span>
                    </td>
                    <td className="py-1.5 text-right text-ink-soft">{o.best_weekday ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  );
}

function BeRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-ink-faint">{label}</dt>
      <dd className="num font-medium">{value}</dd>
    </div>
  );
}

const pct = (v: number, all: any[]) =>
  Math.round((v / Math.max(1, Math.max(...all.map((x) => x.net_rupees)))) * 100);

/** Green means "you made money". A month with nothing in it made nothing, and
 *  an exact zero is not a win either - both should read as neutral. */
const profitTone = (profit: number | null | undefined, daysRecorded: number) => {
  if (!daysRecorded) return undefined;
  const v = profit ?? 0;
  return v > 0 ? "good" : v < 0 ? "bad" : undefined;
};

