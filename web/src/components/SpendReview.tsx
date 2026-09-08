import { useMutation, useQuery } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { api } from "../api/client";
import { Button, Card, ErrorNote, SectionLabel } from "./ui";
import { FindingList, type Finding } from "./Findings";

function monthName(ym: string) {
  const [y, m] = ym.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-IN",
    { month: "long", year: "numeric" });
}

/**
 * The plain-English read on a month's spending.
 *
 * The numbers are computed on the server from the books and are the same
 * every time you open the page. The written summary is optional and only
 * appears once a model is configured under Settings.
 */
export default function SpendReview({ month, outletId }: {
  month: string; outletId: number | null;
}) {
  const qs = `?month=${month}` + (outletId ? `&outlet_id=${outletId}` : "");
  const q = useQuery({
    queryKey: ["advisor-review", month, outletId],
    queryFn: () => api.get(`/advisor/review${qs}`),
  });
  const ai = useQuery({
    queryKey: ["ocr-status"],
    queryFn: () => api.get("/ocr/status"),
  });
  const advice = useMutation({
    mutationFn: () => api.post("/advisor/advice", { month, outlet_id: outletId }),
  });

  const d = q.data;
  const findings: Finding[] = d?.findings ?? [];
  const notes: string[] = d?.data_quality?.notes ?? [];
  const coverage = d?.recording_coverage;
  const selectedFindings: Finding[] = (() => {
    if (!advice.data?.findings || !Array.isArray(advice.data.selected_finding_indexes)) {
      return [];
    }
    return advice.data.selected_finding_indexes
      .filter((index: unknown) => typeof index === "number" &&
        Number.isInteger(index) && index >= 0 && index < advice.data.findings.length)
      .map((index: number) => advice.data.findings[index]);
  })();
  const adviceError = advice.isError
    ? (() => {
      const message = (advice.error as any)?.message ?? "";
      if (/reply didn't look|empty answer|malformed/i.test(message)) {
        return "The AI returned an unusable reply. Your book findings above are still available; try again later.";
      }
      if (/couldn't reach|network|offline|fetch/i.test(message)) {
        return "The AI service could not be reached. Check its connection or try again later.";
      }
      if (/isn't set up|provider|compatible/i.test(message)) {
        return "The configured AI provider cannot write this review. Check Settings → AI.";
      }
      return message || "The AI couldn't be reached. Your book findings above are still available.";
    })()
    : null;

  return (
    <Card className="space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SectionLabel>Spend review · {monthName(month)}</SectionLabel>
        {d && (
          <span className="text-xs text-ink-faint">
            vs {monthName(d.prev_month)}
            {d.period?.partial && " · same days, month to date"}
          </span>
        )}
      </div>

      {q.isLoading && <div className="py-6 text-sm text-ink-faint">Reading the books…</div>}
      {q.isError && <ErrorNote msg="Couldn't work out this month's review." />}

      {d && findings.length === 0 && (
        <p className="py-4 text-sm text-ink-faint">
          Nothing to report for {monthName(month)} — no expenses logged yet.
        </p>
      )}

      {findings.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
            Deterministic findings from your books
          </p>
          <FindingList findings={findings} />
        </div>
      )}

      {notes.length > 0 && (
        <p className="text-xs text-ink-faint">{notes.join(" ")}</p>
      )}

      {coverage && (
        <div className="border-t border-rule pt-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
            Recording coverage
          </p>
          <div className="mt-1 grid gap-1 text-sm sm:grid-cols-3">
            <span>{coverage.sales_days ?? 0} sales days recorded</span>
            <span>{coverage.expense_days ?? 0} expense days recorded</span>
            <span className={(coverage.cash_open_among_sales_days ?? 0) > 0
              ? "font-medium text-bad" : "text-good"}>
              {(coverage.cash_open_among_sales_days ?? 0) > 0
                ? `${coverage.cash_open_among_sales_days} sales days need a cash close`
                : `${coverage.cash_closed_among_sales_days ?? 0} sales days cash-closed`}
            </span>
          </div>
        </div>
      )}

      {/* The written summary. Deliberately behind a tap: it costs a call
          out to whatever model the owner configured, and the numbers above
          already stand on their own without it. */}
      <div className="border-t border-rule pt-3">
        {ai.data?.configured ? (
          <>
            <p className="mb-2 text-xs text-ink-faint">
              Optional AI priority brief. It sends aggregate totals, recording coverage, and
              non-identifying operational themes only when you click; no bills, transaction rows,
              names, vendors, or item details are sent.
            </p>
            <Button variant="outline" size="sm"
                    onClick={() => advice.mutate()}
                    disabled={advice.isPending || !d}>
              <Sparkles className="h-4 w-4" />
              {advice.isPending ? "Thinking…"
                : advice.data ? "Write it again" : "Explain this in words"}
            </Button>
            {adviceError && (
              <div className="mt-2">
                <ErrorNote msg={adviceError} />
              </div>
            )}
            {advice.data && (
              <div className="mt-3 rounded-md border border-accent/30 bg-accent-soft/40 px-3 py-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
                  AI priority brief
                </p>
                <p className="whitespace-pre-wrap text-sm leading-relaxed">
                  {advice.data.text}
                </p>
                <p className="mt-2 text-xs text-ink-faint">
                  Written by {advice.data.model} from aggregate figures. The deterministic
                  findings above remain the server-generated source for counts and amounts.
                </p>
              </div>
            )}
            {selectedFindings.length > 0 && (
              <div className="mt-3 space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
                  Highlighted deterministic findings
                </p>
                <FindingList findings={selectedFindings} />
              </div>
            )}
          </>
        ) : (
          <p className="text-xs text-ink-faint">
            Want this explained in a paragraph? Set up a model under
            Settings → Scan bills, and a “Explain this in words” button
            appears here.
          </p>
        )}
      </div>
    </Card>
  );
}
