import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { useOutletContext } from "react-router-dom";
import { useState } from "react";
import { Lock } from "lucide-react";
import { api } from "../api/client";
import { useGuarded } from "../lib/auth";
import { inr, monthName, toPaise } from "../lib/format";
import { Badge, Button, Card, SectionLabel, Spinner } from "../components/ui";

/** The password sheet opens over this page, so it has to say which locked
 * destination it is opening — not just "salary or old records". */
const PAYROLL_STEP_UP = {
  title: "Payroll is owner-only",
  heading: "Enter your password to open Monthly salaries",
  body: "Salary months stay locked until you confirm it's you. Unlocking only lists the months — nothing is computed, changed, or paid.",
};

/** Kicker + title stay on screen while payroll is loading or locked, so the
 * sheet never floats over a bare spinner. */
function PayrollFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-4">
      <header>
        <SectionLabel>Staff · Payroll</SectionLabel>
        <h1 className="text-2xl font-semibold tracking-tight">Monthly salaries</h1>
      </header>
      {children}
    </div>
  );
}

export default function PayrollRuns() {
  const guarded = useGuarded(PAYROLL_STEP_UP);
  const { outletId } = useOutletContext<{ outletId: number }>();
  const q = useQuery({
    queryKey: ["payroll-runs", outletId],
    queryFn: () => guarded(() => api.get(`/payroll/runs?outlet_id=${outletId}`)),
  });
  const now = new Date();
  const thisYear = now.getFullYear();
  const thisMonth = now.getMonth() + 1;
  const [year, setYear] = useState(thisYear);

  if (q.isLoading)
    return (
      <PayrollFrame>
        <Card className="px-4 py-5">
          <p className="flex items-center gap-2 text-sm font-medium">
            <Lock size={15} className="shrink-0 text-ink-faint" /> Owner-only screen
          </p>
          <p className="mt-1 text-sm text-ink-faint">
            Monthly salaries open once your password is confirmed. If a password
            panel is showing, it belongs to this screen.
          </p>
          <Spinner label="Opening monthly salaries…" />
        </Card>
      </PayrollFrame>
    );
  if (q.isError)
    return (
      <PayrollFrame>
        <Card className="p-6 text-center">
          <p className="text-sm text-ink-faint">
            Could not load payroll months. Check the banner above and try again.
          </p>
          <Button variant="outline" size="sm" className="mt-3" onClick={() => q.refetch()}>
            Try again
          </Button>
        </Card>
      </PayrollFrame>
    );
  const runs: any[] = q.data ?? [];
  const byKey = new Map(runs.map((r) => [`${r.year}-${r.month}`, r]));

  // Salaries are paid for months that have happened, so the current year
  // stops at this month rather than listing months nobody can compute yet.
  const newest = year === thisYear ? thisMonth : 12;
  const months: { y: number; m: number }[] = [];
  for (let m = newest; m >= 1; m--) months.push({ y: year, m });

  return (
    <PayrollFrame>
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-ink-faint">Pick a month to compute or review.</p>
        <div className="flex items-center gap-1 text-sm">
          <button aria-label="Previous year"
                  className="min-h-11 min-w-11 rounded border border-rule-strong px-2.5 hover:bg-paper-3"
                  onClick={() => setYear((v) => v - 1)}>‹</button>
          <span className="num min-w-[3.5rem] px-1 py-1.5 text-center font-medium">{year}</span>
          <button aria-label="Next year"
                  className="min-h-11 min-w-11 rounded border border-rule-strong px-2.5 enabled:hover:bg-paper-3 disabled:opacity-30"
                  disabled={year >= thisYear}
                  onClick={() => setYear((v) => Math.min(thisYear, v + 1))}>›</button>
        </div>
      </div>

      <Card className="divide-y divide-rule">
        {months.map(({ y, m }) => {
          const run = byKey.get(`${y}-${m}`);
          return (
            <Link key={`${y}-${m}`} to={`/staff/payroll/${y}-${String(m).padStart(2, "0")}`}
                  className="flex items-center gap-3 px-4 py-3 hover:bg-paper-3/50">
              <div className="min-w-0 flex-1">
                <div className="font-medium">{monthName(y, m)}</div>
                <div className="text-xs text-ink-faint">
                  {run
                    ? `Net payable ${inr(toPaise(run.net_rupees ?? 0))}`
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
        credited days × the per-day amount − advances. Nothing is final until you
        finalize with your password — that locks the month too.
      </p>
    </PayrollFrame>
  );
}
