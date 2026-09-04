import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api/client";
import { Card, ErrorNote, SectionLabel } from "./ui";
import { FindingList, type Finding } from "./Findings";

const money = (n: number) => "₹" + Math.round(n).toLocaleString("en-IN");

/**
 * Kitchen tickets that never became a bill.
 *
 * The honest answer is a range, and this screen shows the cautious end of
 * it. Bills that arrived with no ticket number leave their numbers looking
 * unused, so they are credited against the gap before anyone is accused.
 * The missing numbers themselves are what make this worth reading — the
 * owner can look those tickets up in the POS and see what was ordered.
 */
export function KotGaps({ start, end, outletId }: {
  start: string; end: string; outletId: number | null;
}) {
  const [open, setOpen] = useState(false);
  const q = useQuery({
    queryKey: ["kot-gaps", start, end, outletId],
    queryFn: () => api.get(
      `/patterns/kot-gaps?start=${start}&end=${end}` +
      (outletId ? `&outlet_id=${outletId}` : "")),
  });
  const d = q.data;
  const findings: Finding[] = d?.findings ?? [];
  const t = d?.totals;
  const worst = d?.worst_days ?? [];

  return (
    <Card className="space-y-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SectionLabel>Kitchen tickets without a bill</SectionLabel>
        {t && t.days_measurable > 0 && (
          <span className="text-xs text-ink-faint">
            {t.tickets_seen.toLocaleString("en-IN")} tickets over{" "}
            {t.days_measurable} days
          </span>
        )}
      </div>

      {q.isLoading && (
        <div className="py-6 text-sm text-ink-faint">Reading the books…</div>
      )}
      {q.isError && <ErrorNote msg="Couldn't read your kitchen tickets." />}

      {t && t.days_measurable === 0 ? (
        <p className="py-4 text-sm text-ink-faint">
          Your sales import didn't carry kitchen ticket numbers for these
          days, so there's nothing to check either way.
        </p>
      ) : d && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Figure label="Unaccounted for" value={t.missing_at_least.toLocaleString("en-IN")}
                    note="at least" strong={t.missing_at_least > 0} />
            <Figure label="Could be as high as" value={t.missing_at_most.toLocaleString("en-IN")}
                    note="if no bill lost its number" />
            <Figure label="Typical day" value={String(t.typical_per_day)}
                    note="tickets" />
            <Figure label="Worth at least" value={money(t.value_at_least_rupees)}
                    note="at your own average bill" />
          </div>

          <FindingList findings={findings} />

          {worst.length > 0 && worst[0].missing_at_least > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
                Days worth looking into
              </p>
              <div className="space-y-2">
                {worst.slice(0, open ? worst.length : 5).map((w: any) => (
                  <div key={w.date}
                       className="rounded-lg border border-line bg-paper-2 p-3">
                    <div className="flex items-baseline justify-between gap-3 text-sm">
                      <span className="font-medium">{w.date}</span>
                      <span className="shrink-0 tabular-nums text-ink-soft">
                        {w.missing_at_least} of {w.tickets_seen} raised
                      </span>
                    </div>
                    <p className="mt-1 break-words font-mono text-xs text-ink-faint">
                      {w.missing_numbers.join(", ")}
                    </p>
                  </div>
                ))}
              </div>
              {worst.length > 5 && (
                <button type="button" onClick={() => setOpen(!open)}
                        className="text-xs font-medium text-accent hover:underline">
                  {open ? "Show fewer days" : `Show all ${worst.length} days`}
                </button>
              )}
            </div>
          )}

          <p className="text-xs leading-relaxed text-ink-faint">{d.how}</p>
        </>
      )}
    </Card>
  );
}

function Figure({ label, value, note, strong }: {
  label: string; value: string; note: string; strong?: boolean;
}) {
  return (
    <div className="rounded-lg border border-line bg-paper-2 p-3">
      <p className="text-xs text-ink-faint">{label}</p>
      <p className={"mt-0.5 text-lg font-semibold tabular-nums " +
                    (strong ? "text-accent" : "")}>{value}</p>
      <p className="text-xs text-ink-faint">{note}</p>
    </div>
  );
}
