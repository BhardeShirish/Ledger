import { useQuery } from "@tanstack/react-query";
import { Link, useOutletContext } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import { api } from "../api/client";
import { useAuth } from "../lib/auth";
import { fmtDate, inr, todayISO } from "../lib/format";
import { Badge, Card, SectionLabel, Spinner, StatTile } from "../components/ui";

type Ctx = { outletId: number };

export default function DailyBrief() {
  const { outletId } = useOutletContext<{ outletId: number }>();
  const { me } = useAuth();
  const today = todayISO();

  const home = useQuery({
    queryKey: ["brief-home", outletId, today],
    queryFn: () => api.get(`/stats/home?date=${today}&outlet_id=${outletId}`),
  });
  const cash = useQuery({
    queryKey: ["brief-cash", outletId, today],
    queryFn: () => api.get(`/cash/day?outlet_id=${outletId}&date=${today}`),
  });
  const fc = useQuery({
    queryKey: ["brief-forecast", outletId],
    queryFn: () => api.get(`/insights/forecast?month=${today.slice(0, 7)}&outlet_id=${outletId}`),
  });
  const an = useQuery({
    queryKey: ["brief-anomalies", outletId],
    queryFn: () => api.get(`/insights/anomalies?month=${today.slice(0, 7)}&outlet_id=${outletId}`),
  });
  const inv = useQuery({
    queryKey: ["brief-inv", outletId],
    queryFn: () => api.get(`/inventory/overview?outlet_id=${outletId}`),
  });
  const closures = useQuery({
    queryKey: ["brief-closures", outletId, today.slice(0, 7)],
    queryFn: () => api.get(`/cash/closures?outlet_id=${outletId}&limit=31`),
  });

  if (home.isLoading) return <Spinner />;
  const mine = home.data?.outlets?.[0];

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <header>
        <SectionLabel>Daily Brief · {fmtDate(today)}</SectionLabel>
        <h1 className="text-2xl font-semibold tracking-tight">
          {mine?.closed ? "Day closed ✓" : "How today looks"}
        </h1>
      </header>

      {/* Ritual */}
      {mine && (
        <Card className="divide-y divide-rule">
          <Row label="Attendance" done={mine.attendance.done}
               state={mine.attendance.done ? "done"
                      : `${mine.attendance.marked}/${mine.attendance.total}`}
               to="/staff/attendance" />
          <Row label="Sales" done={mine.sales.done}
               state={mine.sales.done ? `₹${Math.round(mine.sales.rupees_paise / 100).toLocaleString("en-IN")}` : "not entered"}
               to="/sales" />
          <Row label="Expenses" done={(mine.expenses.count ?? 0) > 0}
               state={`${mine.expenses.count} logged`}
               to="/money/expenses" />
          <Row label="Cash drawer" done={!!mine.closed}
               state={mine.closed ? "closed" : "not counted yet"}
               to="/money/cash" />
        </Card>
      )}

      {/* Numbers */}
      <div className="grid grid-cols-2 gap-3">
        <StatTile label="Sales today"
                  value={inr(mine?.sales?.rupees_paise ?? 0)} />
        {fc.data && (
          <StatTile label="Month projection"
                    value={inr(Math.round((fc.data.projected_rupees ?? 0) * 100))}
                    sub={fc.data.target_rupees
                         ? `${fc.data.percent_of_target}% of target`
                         : "no target set"} />
        )}
        <StatTile label="Expected drawer"
                  value={inr(cash.data?.expected_paise ?? 0)}
                  sub={cash.data?.closure ? "closed" : "before closing"} />
        <StatTile label="Cash variance (month)"
                  value={inr(
                    (closures.data?.rows ?? [])
                      .filter((row: any) =>
                        row.date.startsWith(today.slice(0, 7)) && !row.reopened)
                      .reduce((sum: number, row: any) =>
                        sum + row.variance_paise, 0),
                    { sign: true },
                  )}
                  sub="see cash register" />
      </div>

      {/* Stock alerts */}
      {inv.data && inv.data.below_min_count > 0 && (
        <Card className="bg-bad/5 p-4">
          <SectionLabel>Stock running low</SectionLabel>
          <ul className="mt-1.5 space-y-1 text-sm">
            {(inv.data.items ?? [])
              .filter((i: any) => i.below_min)
              .slice(0, 6)
              .map((i: any) => (
                <li key={i.id} className="flex justify-between">
                  <span>{i.name}</span>
                  <span className="num text-ink-soft">
                    {i.current_qty} {i.base_unit} left
                    {i.suggested_order > 0 && ` · order ${i.suggested_order}`}
                  </span>
                </li>
              ))}
          </ul>
          <Link to="/inventory/order" className="mt-2 inline-block text-sm text-accent underline">
            Full order list →
          </Link>
        </Card>
      )}

      {/* Anomalies */}
      {!an.isLoading && (an.data ?? []).length > 0 && me?.role === "owner" && (
        <Card className="bg-amber-50 p-4">
          <SectionLabel>Needs your eye</SectionLabel>
          <ul className="mt-1.5 space-y-1 text-sm">
            {an.data.slice(0, 5).map((a: any, i: number) => (
              <li key={i} className="flex justify-between gap-2">
                <span className="text-ink-soft">{fmtDate(a.date)}</span>
                <span className="truncate">{a.detail}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <p className="text-center text-xs text-ink-faint">
        Tap any row above to go straight to it.
      </p>
    </div>
  );
}

function Row({ label, done, state, to }: {
  label: string; done: boolean; state: string; to: string;
}) {
  return (
    <Link to={to}
          className="group flex items-center justify-between px-4 py-3 hover:bg-paper-3/50">
      <span className="font-medium">{label}</span>
      <span className="flex items-center gap-2">
        {/* Pending work is what this screen exists to surface, so it must not
            look the same as work already done. */}
        <Badge tone={done ? "good" : "accent"}>{state}</Badge>
        <ChevronRight size={15}
                      className="text-ink-faint transition-transform group-hover:translate-x-0.5" />
      </span>
    </Link>
  );
}
