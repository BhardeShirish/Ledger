import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { CheckCircle2, FileUp } from "lucide-react";
import { api } from "../api/client";
import { useGuarded } from "../lib/auth";
import { fmtDateShort, inr } from "../lib/format";
import {
  Badge, Button, Card, ErrorNote, SectionLabel, Spinner,
} from "../components/ui";

export default function ImportWizard() {
  const { outletId } = useOutletContext<{ outletId: number }>();
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [result, setResult] = useState<any>(null);
  const [err, setErr] = useState("");
  const guarded = useGuarded();

  const history = useQuery({
    queryKey: ["imports"],
    queryFn: () => api.get("/imports"),
  });

  const upload = useMutation({
    mutationFn: async (f: File) => {
      const fd = new FormData();
      fd.append("file", f);
      return api.post(`/imports/upload?outlet_id=${outletId}`, fd);
    },
    onSuccess: setResult,
    onError: (e: any) => setErr(e.message),
  });

  const commit = useMutation({
    mutationFn: () => guarded(() => api.post(`/imports/${result.batch_id}/commit`)),
    onSuccess: () => {
      setResult(null);
      if (fileRef.current) fileRef.current.value = "";
      qc.invalidateQueries({ queryKey: ["imports"] });
      qc.invalidateQueries({ queryKey: ["sales-sheet"] });
      qc.invalidateQueries({ queryKey: ["home"] });
    },
    onError: (e: any) => setErr(e.message),
  });

  return (
    <div className="space-y-5">
      <header>
        <SectionLabel>Insights · Petpooja import</SectionLabel>
        <h1 className="text-2xl font-semibold tracking-tight">Bring in the POS report</h1>
        <p className="mt-1 max-w-xl text-sm text-ink-faint">
          Export the <b>Orders: Master Report</b> (Excel) from Petpooja and drop it here.
          Nothing changes until you review the preview and commit.
        </p>
      </header>

      {!result && (
        <Card
          className="flex cursor-pointer flex-col items-center justify-center gap-2 border-dashed py-12 hover:bg-paper-3/40"
          onDragOver={(e: any) => e.preventDefault()}
          onDrop={(e: any) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) upload.mutate(f); }}
          onClick={() => fileRef.current?.click()}>
          <input ref={fileRef} type="file" hidden accept=".xlsx,.xls"
                 onChange={(e) => { const f = e.target.files?.[0]; if (f) upload.mutate(f); }} />
          <FileUp size={28} className="text-accent" />
          <div className="font-medium">Drop the Excel report here</div>
          <div className="text-sm text-ink-faint">or tap to choose — .xlsx files only</div>
          {upload.isPending && <Spinner label="Reading the report…" />}
          <ErrorNote msg={err} />
        </Card>
      )}

      {result && (
        <>
          <Card className="space-y-3 p-5">
            <h2 className="font-semibold">
              <CheckCircle2 className="mr-1 inline text-good" size={16} />
              Read successfully — check before committing
            </h2>
            <div className="grid grid-cols-3 gap-3 text-center">
              <Box label="Bills" value={String(result.rows_ok)} tone="good" />
              <Box label="Skipped" value={String(result.rows_skipped)}
                   tone={result.rows_skipped ? "warn" : undefined}
                   hint={result.rows_skipped ? "cancelled bills" : undefined} />
              <Box label="Split bills" value={String(result.part_payments_unresolved)}
                   tone={result.part_payments_unresolved ? "accent" : undefined}
                   hint="need one-tap allocation later" />
            </div>
            <p className="text-xs text-ink-faint">
              Range: {fmtDateShort(result.date_from)} → {fmtDateShort(result.date_to)} ·
              {" "}{result.meta["restaurant name"] ?? ""}
            </p>

            <SectionLabel>Daily totals preview</SectionLabel>
            <div className="max-h-64 overflow-y-auto rounded-md border border-rule">
              {(result.preview ?? []).map((p: any, i: number) => (
                <div key={i} className="flex items-center gap-3 border-b border-rule px-3 py-1.5 text-sm last:border-0">
                  <span className="w-20 text-ink-soft">{fmtDateShort(p.date)}</span>
                  <span className="w-16"><Badge>{p.channel_kind}</Badge></span>
                  <span className="num w-14 text-right text-xs text-ink-faint">{p.bills} bills</span>
                  <span className="num ml-auto font-medium">{inr(Math.round(p.total_rupees * 100))}</span>
                </div>
              ))}
            </div>

            <ErrorNote msg={err} />
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" onClick={() => setResult(null)}>Discard</Button>
              <Button onClick={() => commit.mutate()} disabled={commit.isPending}>
                {commit.isPending ? "Importing…" : `Commit ${result.rows_ok} bills`}
              </Button>
            </div>
          </Card>
        </>
      )}

      <Card>
        <div className="border-b border-rule px-4 py-2.5"><SectionLabel>Past imports</SectionLabel></div>
        <div className="divide-y divide-rule">
          {(history.data ?? []).map((b: any) => {
            // Committing an old batch replays every bill in it. If the same
            // file already went in, that is a silent double-count.
            const alreadyCommitted = (history.data ?? []).some(
              (o: any) => o.id !== b.id && o.filename === b.filename
                          && o.status === "committed");
            return (
            <div key={b.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
              <span className="min-w-0 flex-1 truncate">
                {b.filename}
                {b.uploaded_at && (
                  <span className="ml-2 text-xs text-ink-faint">
                    {fmtDateShort(b.uploaded_at.slice(0, 10))}
                  </span>
                )}
                {b.status === "validated" && alreadyCommitted && (
                  <span className="ml-2 text-xs text-bad">
                    · this file was already committed
                  </span>
                )}
              </span>
              <Badge tone={b.status === "committed" ? "good" : b.status === "discarded" ? "neutral" : "warn"}>
                {b.status}
              </Badge>
              <span className="num text-xs text-ink-faint">{b.rows_ok} bills</span>
              {b.status === "validated" && (
                <CommitRowButton batch={b} duplicate={alreadyCommitted} onDone={() => {
                  qc.invalidateQueries({ queryKey: ["imports"] });
                }} />
              )}
            </div>
            );
          })}
          {(history.data ?? []).length === 0 && (
            <div className="px-4 py-6 text-center text-sm text-ink-faint">Nothing imported yet.</div>
          )}
        </div>
      </Card>
    </div>
  );
}

function CommitRowButton({ batch, duplicate, onDone }: {
  batch: any; duplicate: boolean; onDone: () => void;
}) {
  const guarded = useGuarded();
  const [err, setErr] = useState("");
  const c = useMutation({
    mutationFn: () => guarded(() => api.post(`/imports/${batch.id}/commit`)),
    onSuccess: onDone,
    onError: (e: any) => setErr(e.message),
  });
  const ask = () => {
    const warn = duplicate
      ? `\n\nA file with this name was ALREADY committed. Doing this again will count those bills twice.`
      : "";
    if (confirm(`Import ${batch.rows_ok} bills from "${batch.filename}"?${warn}`)) {
      c.mutate();
    }
  };
  return (
    <span className="inline-flex items-center gap-2">
      {err && <span className="text-xs text-bad">{err}</span>}
      <button className={`underline ${duplicate ? "text-bad" : "text-accent"}`}
              onClick={ask} disabled={c.isPending}>
        {c.isPending ? "committing…" : "commit now"}
      </button>
    </span>
  );
}

function Box({ label, value, tone, hint }: {
  label: string; value: string; tone?: string; hint?: string;
}) {
  return (
    <div className="rounded-md border border-rule bg-paper-2 px-3 py-2.5">
      <div className={`num text-2xl font-semibold ${tone === "good" ? "text-good"
        : tone === "warn" ? "text-bad" : tone === "accent" ? "text-accent" : ""}`}>
        {value}
      </div>
      <div className="text-[11px] uppercase tracking-wide text-ink-faint">{label}</div>
      {hint && <div className="mt-0.5 text-[11px] text-ink-faint">{hint}</div>}
    </div>
  );
}
