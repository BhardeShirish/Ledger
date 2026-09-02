import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { useOutletContext } from "react-router-dom";
import { useState } from "react";
import { api } from "../api/client";
import { useGuarded } from "../lib/auth";
import { inr, monthName } from "../lib/format";
import { Badge, Card, SectionLabel, Spinner } from "../components/ui";

export default function PayrollRuns() {
  const guarded = useGuarded();
  const { outletId } = useOutletContext<{ outletId: number }>();
  const q = useQuery({
    queryKey: ["payroll-runs", outletId],
    queryFn: () => guarded(() => api.get(`/payroll/runs?outlet_id=${outletId}`)),
  });
  const now = new Date();
  const thisYear = now.getFullYear();
  const thisMonth = now.getMonth() + 1;
  const [year, setYear] = useState(thisYear);

  if (q.isLoading) return <Spinner />;
  if (q.isError)
    return (
      <Card className="p-6 text-center">
        <p className="text-sm text-ink-faint">
          Could not load payroll months. Check the banner above and try again.
        </p>
        <button className="mt-3 rounded border border-rule-strong px-3 py-1.5 text-sm"
                onClick={() => q.refetch()}>
          Try again
        </button>
      </Card>
    );
  const runs: any[] = q.data ?? [];
  const byKey = new Map(runs.map((r) => [`${r.year}-${r.month}`, r]));

  // Salaries are paid for months that have happened, so the current year
  // stops at this month rather than listing months nobody can compute yet.
  const newest = year === thisYear ? thisMonth : 12;
  const months: { y: number; m: number }[] = [];
  for (let m = newest; m >= 1; m--) months.push({ y: year, m });

  return (
    <div className="space-y-4">
      <header className="flex items-end justify-between">
        <div>
          <SectionLabel>Money · Payroll</SectionLabel>
          <h1 className="text-2xl font-semibold tracking-tight">Monthly salaries</h1>
        </div>
        <div className="flex items-center gap-1 text-sm">
          <button aria-label="Previous year"
                  className="rounded border border-rule-strong px-2.5 py-1 hover:bg-paper-3"
                  onClick={() => setYear((v) => v - 1)}>‹</button>
          <span className="num min-w-[3.5rem] px-1 py-1.5 text-center font-medium">{year}</span>
          <button aria-label="Next year"
                  className="rounded border border-rule-strong px-2.5 py-1 enabled:hover:bg-paper-3 disabled:opacity-30"
                  disabled={year >= thisYear}
                  onClick={() => setYear((v) => Math.min(thisYear, v + 1))}>›</button>
        </div>
      </header>

      <Card className="divide-y divide-rule">
        {months.map(({ y, m }) => {
          const run = byKey.get(`${y}-${m}`);
          return (
            <Link key={`${y}-${m}`} to={`/money/payroll/${y}-${String(m).padStart(2, "0")}`}
                  className="flex items-center gap-3 px-4 py-3 hover:bg-paper-3/50">
              <div className="min-w-0 flex-1">
                <div className="font-medium">{monthName(y, m)}</div>
                <div className="text-xs text-ink-faint">
                  {run
                    ? `Net payable ${inr(run.net_rupees ?? 0)}`
                    : "Tap to compute"}
                </div>
              </div>
              {run && (
                <Badge tone={run.status === "finalized" ? "good" : "accent"}>
                  {run.status === "finalized" ? "finalized & locked" : "draft"}
                </Badge>
              )}
            </Link>
          );
        })}
      </Card>

      <p className="px-1 text-xs leading-relaxed text-ink-faint">
        Opening a month computes salaries straight from attendance:
        credited days × per-day rate − advances. Nothing is final until you
        finalize with your password — that locks the month too.
      </p>
    </div>
  );
}
