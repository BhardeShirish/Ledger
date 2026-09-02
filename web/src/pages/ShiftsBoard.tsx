import { useQuery } from "@tanstack/react-query";
import { useOutletContext } from "react-router-dom";
import { api } from "../api/client";
import { DOW_LABELS } from "../lib/format";
import { Card, EmptyState, SectionLabel, Spinner } from "../components/ui";

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

      {(people.data ?? []).length === 0 && (
        <EmptyState title="No staff yet" hint="Add your team from People first." />
      )}
      <p className="px-1 text-xs text-ink-faint">
        Backups are set per person in their profile — the person who covers when they're off.
      </p>
    </div>
  );
}
