import { useQuery } from "@tanstack/react-query";
import { Link, useOutletContext } from "react-router-dom";
import { api } from "../api/client";
import { addDaysISO, DOW_LABELS, inr, todayISO } from "../lib/format";
import { Badge, Card, EmptyState, ErrorNote, SectionLabel, Spinner } from "../components/ui";

type Ctx = { outletId: number };

/** Off-day coverage planner — who's off each weekday and who backs them up. */
export default function ShiftsBoard() {
  const { outletId } = useOutletContext<Ctx>();
  const cov = useQuery({
    queryKey: ["coverage", outletId],
    queryFn: () => api.get(`/stats/offday-coverage?outlet_id=${outletId}`),
  });
  const people = useQuery({
    queryKey: ["people", outletId],
    queryFn: () => api.get(`/staff/employees?outlet_id=${outletId}`),
  });
  const productivity = useQuery({
    queryKey: ["labour-productivity", outletId],
    queryFn: () => api.get(`/stats/labour-productivity?outlet_id=${outletId}&start=${addDaysISO(todayISO(), -27)}&end=${todayISO()}`),
  });
  const staffing = useQuery({
    queryKey: ["staffing-plan", outletId],
    queryFn: () => api.get(`/stats/staffing-plan?outlet_id=${outletId}` +
      `&start=${addDaysISO(todayISO(), -55)}&end=${todayISO()}`),
  });
  const nameOf = (id: number | null) =>
    id == null ? null : people.data?.find((p: any) => p.id === id)?.name ?? "?";

  if (cov.isLoading) return <Spinner />;

  return (
    <div className="space-y-4">
      <header>
        <SectionLabel>Staff · Coverage</SectionLabel>
        <h1 className="text-2xl font-semibold tracking-tight">Who's off when</h1>
      </header>

      <Card className="divide-y divide-rule">
        {(cov.data?.days ?? []).map((day: any) => (
          <div key={day.dow} className="flex items-start gap-4 px-4 py-3">
            <span className={`w-10 shrink-0 pt-0.5 font-semibold ${
              day.off_count > 0 ? "" : "text-ink-faint"}`}>{DOW_LABELS[day.dow]}</span>
            {day.off_count === 0 ? (
              <span className="text-sm text-ink-faint">Full team on</span>
            ) : (
              <ul className="min-w-0 flex-1 space-y-1">
                {day.detail.map((d: any, i: number) => (
                  <li key={i} className="text-sm">
                    <span>{d.off}</span>
                    <span className="text-ink-faint">
                      {" "}· backup:{" "}
                      <span className={d.backup ? "font-medium text-ink" : ""}>{d.backup ?? "none set"}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <span className={`num shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${
              day.off_count > 2 ? "bg-bad/10 text-bad" : day.off_count > 0 ? "bg-paper-3" : "text-ink-faint"}`}>
              {day.off_count} off
            </span>
          </div>
        ))}
      </Card>

      {!productivity.isLoading && productivity.data && (
        <Card className="overflow-hidden">
          <div className="border-b border-rule px-4 py-3">
            <h2 className="font-semibold">Recent labour effectiveness</h2>
            <p className="mt-0.5 text-sm text-ink-faint">Observed sales and bills per clocked labour hour over the last 28 days.</p>
          </div>
          <div className="grid grid-cols-2 divide-x divide-rule">
            <div className="px-4 py-3">
              <div className="text-xs text-ink-faint">Sales / labour hour</div>
              <div className="num mt-1 text-xl font-semibold">
                {productivity.data.sales_per_labour_hour_rupees == null ? "—"
                  : inr(Math.round(productivity.data.sales_per_labour_hour_rupees * 100))}
              </div>
            </div>
            <div className="px-4 py-3">
              <div className="text-xs text-ink-faint">Bills / labour hour</div>
              <div className="num mt-1 text-xl font-semibold">
                {productivity.data.bills_per_labour_hour ?? "—"}
              </div>
            </div>
          </div>
          <div className="px-4 py-3 text-sm">
            {productivity.data.peak_hour == null ? (
              <span className="text-ink-faint">No timestamped POS bills yet, so peak service time cannot be measured.</span>
            ) : (
              <>Peak recorded service hour: <strong>{String(productivity.data.peak_hour).padStart(2, "0")}:00</strong>
                <Badge tone="accent">{productivity.data.data_quality.timestamped_bills} bills timed</Badge></>
            )}
            {productivity.data.data_quality.manual_sales_unattributed && (
              <p className="mt-2 text-xs text-ink-faint">Manual daily sales are included in total sales but cannot be attributed to a service hour.</p>
            )}
          </div>
        </Card>
      )}

      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-rule px-4 py-3">
          <div>
            <SectionLabel>Service-period planning</SectionLabel>
            <h2 className="mt-1 font-semibold">Observed demand and clocked coverage</h2>
            <p className="mt-0.5 text-sm text-ink-faint">
              Recommendations are review candidates, never a generated roster or a judgement about a person.
            </p>
          </div>
          <Link to="/sales/bills" className="rounded-md border border-rule-strong px-2.5 py-1.5 text-xs hover:bg-paper-3">
            Review POS timing
          </Link>
        </div>
        {staffing.isLoading ? (
          <div className="grid animate-pulse gap-2 p-4 sm:grid-cols-2">
            <div className="h-16 rounded-md bg-paper-3" />
            <div className="h-16 rounded-md bg-paper-3" />
          </div>
        ) : staffing.isError ? (
          <div className="p-4"><ErrorNote msg="Service-period evidence could not be loaded. Try again shortly." /></div>
        ) : staffing.data?.data_quality?.recommendations_withheld_reason ? (
          <EmptyState title="Staffing recommendations withheld"
                      hint={`${staffing.data.data_quality.recommendations_withheld_reason} Manual daily sales are excluded from hourly recommendations.`} />
        ) : staffing.data?.recommendations?.length ? (
          <>
            <div className="divide-y divide-rule">
              {staffing.data.recommendations.slice(0, 4).map((row: any) => (
                <div key={`${row.weekday}-${row.hour}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-sm">
                  <span className="w-24 font-medium">{DOW_LABELS[row.weekday]} {String(row.hour).padStart(2, "0")}:00</span>
                  <Badge tone={row.kind === "under_coverage" ? "warn" : "accent"}>
                    {row.kind === "under_coverage" ? "review coverage" : "review overlap"}
                  </Badge>
                  <span className="num text-ink-soft">{row.average_bills_per_observed_day} timed bills / observed day</span>
                  <span className="num text-ink-soft">{row.average_clocked_staff_hours_per_service_day} clocked staff-hours / day</span>
                  <span className="text-xs text-ink-faint">{row.observed_service_days} service days · {row.confidence} confidence</span>
                </div>
              ))}
            </div>
            <p className="px-4 py-3 text-xs text-ink-faint">
              Uses timestamped POS bills and actual clocked hours only; manual daily sales are excluded. Check the underlying records before changing coverage.
            </p>
          </>
        ) : (
          <EmptyState title="No repeatable coverage difference found"
                      hint="Enough recorded service periods were checked, but none crossed the evidence threshold for a coverage review." />
        )}
      </Card>

      {(people.data ?? []).length === 0 && (
        <EmptyState title="No staff yet" hint="Add your team from People first." />
      )}
      <p className="px-1 text-xs text-ink-faint">
        Backups are set per person in their profile — the person who covers when they're off.
      </p>
    </div>
  );
}
