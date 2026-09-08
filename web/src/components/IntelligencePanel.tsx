import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Database, Eye, Sparkles, TriangleAlert } from "lucide-react";
import { Link } from "react-router-dom";
import { useState } from "react";
import { api } from "../api/client";
import { Button, Card, ErrorNote, SectionLabel } from "./ui";

type Bucket = "act_today" | "watch_this_week" | "improve_data";

type Finding = {
  id: string;
  bucket: Bucket;
  kind: "risk" | "trend" | "opportunity" | "data_quality";
  severity: "critical" | "warning" | "positive" | "information";
  title: string;
  detail: string;
  action: { label: string; href: string };
  confidence: { level: "high" | "medium" | "low"; reason: string };
  coverage?: { observed: number; expected: number; ratio: number; status: string };
  resolution?: { status: string; note: string; updated_at: string | null };
};

type Brief = {
  health: { status: string; overall_score: number | null; eligible_dimensions: number };
  feed: Finding[];
  ai: { configured: boolean };
  scope: { month: string };
  resolved_findings?: Finding[];
};

type AiBrief = {
  text: string;
  model: string;
  selected_finding_indexes: unknown[];
  findings: Finding[];
};

const GROUPS: Array<{ bucket: Bucket; title: string; icon: typeof TriangleAlert }> = [
  { bucket: "act_today", title: "Act today", icon: TriangleAlert },
  { bucket: "watch_this_week", title: "Watch this week", icon: Eye },
  { bucket: "improve_data", title: "Improve the picture", icon: Database },
];

function labelForStatus(status: string) {
  if (status === "ready") return "A broad operating picture is available.";
  if (status === "provisional") return "Use the signals, but fill the gaps before making bigger calls.";
  return "Record a little more before relying on an overall health score.";
}

export default function IntelligencePanel({ outletId, asOf }: {
  outletId: number; asOf: string;
}) {
  const q = useQuery<Brief>({
    queryKey: ["intelligence-brief", outletId, asOf],
    queryFn: () => api.get(`/intelligence/brief?outlet_id=${outletId}&as_of=${asOf}`),
  });
  const ai = useMutation<AiBrief>({
    mutationFn: () => api.post("/intelligence/ai-brief", { outlet_id: outletId, as_of: asOf }),
  });
  const history = useQuery({
    queryKey: ["finding-resolutions", outletId],
    queryFn: () => api.get(`/owner/resolutions?outlet_id=${outletId}`),
  });
  const brief = q.data;
  const aiData = ai.data;
  const aiError = ai.isError
    ? "The AI couldn't write a usable priority brief. Your evidence-backed findings are still available."
    : null;
  const selected: Finding[] = Array.isArray(aiData?.selected_finding_indexes)
    ? aiData.selected_finding_indexes
      .filter((index): index is number => typeof index === "number" &&
        Number.isInteger(index) && index >= 0 && index < aiData.findings.length)
      .map((index) => aiData.findings[index])
    : [];

  return (
    <Card className="p-0">
      <div className="flex flex-wrap items-start justify-between gap-3 px-4 py-4">
        <div>
          <SectionLabel>Owner intelligence</SectionLabel>
          <h2 className="mt-1 text-lg font-semibold tracking-tight">What deserves attention next</h2>
          {brief && <p className="mt-1 max-w-xl text-sm text-ink-soft">
            {labelForStatus(brief.health.status)}
          </p>}
        </div>
        {brief?.health.overall_score != null && (
          <span className="num text-sm font-semibold text-ink-soft">
            Health {brief.health.overall_score}/100
          </span>
        )}
      </div>

      {q.isLoading && <p className="border-t border-rule px-4 py-5 text-sm text-ink-faint">Reading recorded evidence…</p>}
      {q.isError && <div className="border-t border-rule px-4 py-4"><ErrorNote msg="Couldn't prepare the owner intelligence brief." /></div>}

      {brief && GROUPS.map(({ bucket, title, icon: Icon }) => {
        const findings = brief.feed.filter((finding) => finding.bucket === bucket);
        if (!findings.length) return null;
        return (
          <section key={bucket} className="border-t border-rule">
            <div className="flex items-center gap-2 px-4 pt-3 text-sm font-semibold">
              <Icon className="h-4 w-4 text-ink-soft" aria-hidden="true" />
              <h3>{title}</h3>
            </div>
            <ul className="mt-1 divide-y divide-rule">
              {findings.map((finding) => (
                <li key={finding.id} className="px-4 py-3">
                  <Link to={finding.action.href} className="group block hover:bg-paper-3/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-medium">{finding.title}</p>
                        <p className="mt-0.5 text-sm text-ink-soft">{finding.detail}</p>
                      </div>
                      <ArrowRight className="mt-1 h-4 w-4 shrink-0 text-ink-faint transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
                    </div>
                    <p className="mt-1.5 text-xs text-ink-faint">
                      {finding.confidence.level} confidence · {finding.confidence.reason}
                      {finding.coverage?.expected
                        ? ` · ${finding.coverage.observed}/${finding.coverage.expected} days covered`
                        : ""}
                    </p>
                  </Link>
                  <ResolutionControl finding={finding} outletId={outletId}
                                     coveredPeriod={brief.scope?.month ?? asOf.slice(0, 7)} />
                </li>
              ))}
            </ul>
          </section>
        );
      })}

      {brief && brief.feed.length === 0 && (
        <p className="border-t border-rule px-4 py-5 text-sm text-ink-soft">
          The recorded books do not show a priority action right now.
        </p>
      )}
      {brief && (
        <section className="border-t border-rule px-4 py-3">
          <h3 className="text-sm font-semibold">Resolution history</h3>
          {history.isLoading && <p className="mt-1 text-xs text-ink-faint">Loading decisions…</p>}
          {history.isError && <p className="mt-1 text-xs text-bad">Resolution history is unavailable.</p>}
          {!history.isLoading && !history.isError && (history.data?.items ?? []).length === 0 && (
            <p className="mt-1 text-xs text-ink-faint">No owner decisions recorded yet.</p>
          )}
          <ul className="mt-2 space-y-1.5 text-xs">
            {(history.data?.items ?? []).slice(0, 5).map((item: any) => (
              <li key={item.id} className="flex flex-wrap items-baseline gap-x-2 text-ink-soft">
                <span className="font-medium text-ink">{item.status.replace(/_/g, " ")}</span>
                <span className="truncate">{item.finding_id}</span>
                {item.note && <span className="basis-full break-words text-ink-faint">{item.note}</span>}
              </li>
            ))}
          </ul>
          {(brief.resolved_findings ?? []).map((finding) => (
            <div key={finding.id} className="mt-2 border-t border-rule pt-2 text-xs text-ink-soft">
              <span className="font-medium text-ink">{finding.title}</span> — {finding.detail}
              <ResolutionControl finding={finding} outletId={outletId} coveredPeriod={brief.scope.month}
                                 reopenOnly />
            </div>
          ))}
        </section>
      )}

      {brief?.ai.configured && (
        <div className="border-t border-rule px-4 py-4">
          <p className="max-w-2xl text-xs text-ink-faint">
            Optional AI priority brief. It sends only anonymous health bands, coverage bands,
            and finding topics after you click—never names, amounts, dates, documents, or records.
          </p>
          <Button variant="outline" size="sm" className="mt-2"
                  onClick={() => ai.mutate()} disabled={ai.isPending}>
            <Sparkles className="h-4 w-4" />
            {ai.isPending ? "Writing priority brief…" : aiData ? "Write it again" : "Explain priorities"}
          </Button>
          {aiError && <div className="mt-2"><ErrorNote msg={aiError} /></div>}
          {aiData && (
            <div className="mt-3 border-t border-rule pt-3">
              <p className="text-sm leading-relaxed">{aiData.text}</p>
              {selected.length > 0 && (
                <p className="mt-2 text-xs text-ink-faint">
                  Highlights: {selected.map((finding) => finding.title).join(" · ")}
                </p>
              )}
              <p className="mt-2 text-xs text-ink-faint">
                Written by {aiData.model}; deterministic findings remain the source of financial facts.
              </p>
            </div>
          )}
        </div>
      )}
      {brief && !brief.ai.configured && (
        <p className="border-t border-rule px-4 py-3 text-xs text-ink-faint">
          Set up a model under Settings → Scan bills to add an optional, aggregate-only AI priority brief.
        </p>
      )}
    </Card>
  );
}

function ResolutionControl({ finding, outletId, coveredPeriod, reopenOnly = false }: {
  finding: Finding; outletId: number; coveredPeriod: string; reopenOnly?: boolean;
}) {
  const qc = useQueryClient();
  const [state, setState] = useState("resolved");
  const [note, setNote] = useState("");
  const save = useMutation({
    mutationFn: () => api.post(reopenOnly ? "/owner/resolutions/reopen" : "/owner/resolutions", {
      outlet_id: outletId, finding_id: finding.id, covered_period: coveredPeriod,
      status: state, note,
    }),
    onSuccess: () => {
      setNote("");
      qc.invalidateQueries({ queryKey: ["intelligence-brief", outletId] });
      qc.invalidateQueries({ queryKey: ["finding-resolutions", outletId] });
    },
  });
  if (reopenOnly) return (
    <Button size="sm" variant="ghost" className="ml-1" disabled={save.isPending}
            onClick={() => save.mutate()}>{save.isPending ? "Reopening…" : "Reopen"}</Button>
  );
  const needsNote = state !== "resolved";
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      <select aria-label={`Resolution for ${finding.title}`} value={state}
              onChange={(e) => setState(e.target.value)}
              className="rounded border border-rule-strong bg-paper px-1.5 py-1 text-xs">
        <option value="resolved">Resolved</option>
        <option value="deferred">Deferred</option>
        <option value="accepted_not_applicable">Not applicable</option>
      </select>
      {needsNote && <input aria-label={`Note for ${finding.title}`} value={note}
        onChange={(e) => setNote(e.target.value)} placeholder="Required note"
        className="min-w-0 flex-1 rounded border border-rule-strong bg-paper px-2 py-1 text-xs" />}
      <Button size="sm" variant="ghost" disabled={save.isPending || (needsNote && !note.trim())}
              onClick={() => save.mutate()}>{save.isPending ? "Saving…" : "Save decision"}</Button>
      {save.isError && <span className="basis-full text-xs text-bad">{(save.error as any)?.message ?? "Couldn't save decision."}</span>}
    </div>
  );
}
