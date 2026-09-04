import { useMutation, useQuery } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { api } from "../api/client";
import { Badge, Button, Card, ErrorNote, SectionLabel } from "./ui";

type Finding = {
  severity: "act" | "watch" | "good" | "info";
  title: string;
  detail: string;
};

const TONE = {
  act: "bad", watch: "warn", good: "good", info: "neutral",
} as const;

const WORD = {
  act: "Act on this", watch: "Keep an eye", good: "Going well", info: "For info",
} as const;

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

      <ul className="space-y-2">
        {findings.map((f, i) => (
          <li key={i}
              className="rounded-md border border-rule-strong bg-paper-2 px-3 py-2.5">
            <div className="flex flex-wrap items-start gap-2">
              <Badge tone={TONE[f.severity] ?? "neutral"}>{WORD[f.severity]}</Badge>
              <span className="font-semibold">{f.title}</span>
            </div>
            <p className="mt-1 text-sm text-ink-soft">{f.detail}</p>
          </li>
        ))}
      </ul>

      {notes.length > 0 && (
        <p className="text-xs text-ink-faint">{notes.join(" ")}</p>
      )}

      {/* The written summary. Deliberately behind a tap: it costs a call
          out to whatever model the owner configured, and the numbers above
          already stand on their own without it. */}
      <div className="border-t border-rule pt-3">
        {ai.data?.configured ? (
          <>
            <Button variant="outline" size="sm"
                    onClick={() => advice.mutate()}
                    disabled={advice.isPending || !d}>
              <Sparkles className="h-4 w-4" />
              {advice.isPending ? "Thinking…"
                : advice.data ? "Write it again" : "Explain this in words"}
            </Button>
            {advice.isError && (
              <div className="mt-2">
                <ErrorNote msg={(advice.error as any)?.message
                                ?? "The AI couldn't be reached."} />
              </div>
            )}
            {advice.data && (
              <div className="mt-3 rounded-md border border-accent/30 bg-accent-soft/40 px-3 py-3">
                <p className="whitespace-pre-wrap text-sm leading-relaxed">
                  {advice.data.text}
                </p>
                <p className="mt-2 text-xs text-ink-faint">
                  Written by {advice.data.model} from the figures above. Only
                  category totals are sent — no bills, no names.
                </p>
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
