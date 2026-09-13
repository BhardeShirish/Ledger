import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams, Link, useOutletContext } from "react-router-dom";
import { useEffect, useState } from "react";
import { Download, Lock, Plus, Trash2 } from "lucide-react";
import { api, downloadFile } from "../api/client";
import { ExportButton } from "../components/DataButtons";
import { useGuarded } from "../lib/auth";
import { monthName, todayISO } from "../lib/format";
import { useDirtyDraft } from "../lib/useDirtyDraft";
import {
  Badge, Button, Card, ConfirmSheet, ErrorNote, Field, Input, SectionLabel, Select,
  Sheet, Spinner,
} from "../components/ui";

const BLANK_ADJUSTMENT = { kind: "bonus_days", days: "", amount: "", reason: "" };

/** "2026-07" → "July 2026"; a numeric run id has no month in the URL. */
function runMonthTitle(id: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(id);
  return m ? monthName(Number(m[1]), Number(m[2])) : "this payroll month";
}

/** Breadcrumb + month title stay on screen while the run is opening or
 * locked, so the password sheet never floats over a bare spinner. */
function RunFrame({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-4">
      <header>
        <Link to="/staff/payroll" className="text-sm text-ink-faint hover:text-ink">Payroll</Link>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      </header>
      {children}
    </div>
  );
}

function RunLocked({ title, label }: { title: string; label: string }) {
  return (
    <RunFrame title={title}>
      <Card className="px-4 py-5">
        <p className="flex items-center gap-2 text-sm font-medium">
          <Lock size={15} className="shrink-0 text-ink-faint" /> Owner-only month
        </p>
        <p className="mt-1 text-sm text-ink-faint">
          This month's payslips open once your password is confirmed. If a
          password panel is showing, it belongs to this month.
        </p>
        <Spinner label={label} />
      </Card>
    </RunFrame>
  );
}

export default function PayrollRunDetail() {
  const { id = "" } = useParams();          // "2026-07" or numeric run id
  const qc = useQueryClient();
  const monthTitle = runMonthTitle(id);
  const guarded = useGuarded({
    title: "This payroll month is owner-only",
    heading: `Enter your password to open ${monthTitle}`,
    body: "Salary months stay locked until you confirm it's you. Opening only computes a draft from attendance and advances — nothing is finalized or paid.",
  });
  const { outletId } = useOutletContext<{ outletId: number }>();
  const [adjustFor, setAdjustFor] = useState<number | null>(null);
  const [removingAdjustment, setRemovingAdjustment] = useState<{
    id: number; label: string; reason: string;
  } | null>(null);
  const [err, setErr] = useState("");

  // For "YYYY-MM" ids we POST to open/create the run first.
  const [runId, setRunId] = useState<number | null>(/^\d+$/.test(id) ? Number(id) : null);

  const autoOpen = useMutation({
    mutationFn: async () => {
      const [y, m] = id.split("-").map(Number);
      const r = await guarded(() => api.post(
        "/payroll/runs", { outlet_id: outletId, year: y, month: m },
      ));
      setRunId(r.id);
      return r;
    },
    onError: (e: any) => setErr(e.message),
  });
  const openMonth = autoOpen.mutate;
  const autoOpenIdle = autoOpen.isIdle;

  const q = useQuery({
    queryKey: ["payroll-run", runId],
    queryFn: () => guarded(() => api.get(`/payroll/runs/${runId}`)),
    enabled: runId != null,
  });
  const removeAdjustment = useMutation({
    mutationFn: (adjustmentId: number) =>
      guarded(() => api.del(`/payroll/adjustments/${adjustmentId}`)),
    onSuccess: () => {
      setRemovingAdjustment(null);
      qc.invalidateQueries({ queryKey: ["payroll-run", runId] });
    },
    onError: (e: any) => setErr(e.message),
  });

  useEffect(() => {
    if (!/^\d+$/.test(id) && runId == null && autoOpenIdle) {
      openMonth();
    }
  }, [id, runId, autoOpenIdle, openMonth]);

  if (/^\d+$/.test(id) === false && runId == null) {
    if (autoOpen.isError) {
      return (
        <RunFrame title={monthTitle}>
          <ErrorNote msg={autoOpen.error?.message ?? "Could not open the payroll month."} />
          <Button variant="outline" disabled={autoOpen.isPending}
                  onClick={() => { autoOpen.reset(); autoOpen.mutate(); }}>
            {autoOpen.isPending ? "Retrying payroll month…" : "Retry payroll month"}
          </Button>
        </RunFrame>
      );
    }
    return <RunLocked title={monthTitle} label={`Opening ${monthTitle} salaries…`} />;
  }
  if (!q || q.isLoading || runId == null)
    return <RunLocked title={monthTitle} label={`Opening ${monthTitle} salaries…`} />;
  if (q.isError || !q.data) {
    return (
      <RunFrame title={monthTitle}>
        <ErrorNote msg="Couldn't load this payroll run. Check your connection and retry." />
        <Button variant="outline" disabled={q.isFetching} onClick={() => void q.refetch()}>
          {q.isFetching ? "Retrying payroll run…" : "Retry payroll run"}
        </Button>
      </RunFrame>
    );
  }
  const run = q.data;

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <Link to="/staff/payroll" className="text-sm text-ink-faint hover:text-ink">Payroll</Link>
          </div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            {monthName(run.year, run.month)}
            <Badge tone={run.status === "finalized" ? "good" : "accent"}>
              {run.status === "finalized" ? "finalized & locked" : "draft"}
            </Badge>
          </h1>
        </div>
        <div className="flex items-center gap-2">
          {run.status === "draft" ? (
            <>
              <Button variant="outline" size="sm"
                      onClick={async () => {
                        await guarded(() => api.post(`/payroll/runs/${run.id}/rebuild`));
                        qc.invalidateQueries({ queryKey: ["payroll-run", runId] });
                      }}>
                Recalculate
              </Button>
              <FinalizeButton runId={run.id} onDone={() => qc.invalidateQueries({ queryKey: ["payroll-run", runId] })} />
            </>
          ) : (
            <>
              <a href={`/api/reports/ca-pack?outlet_id=${outletId}&month=${run.year}-${String(run.month).padStart(2, "0")}`}
                 className="inline-flex items-center gap-2 rounded-md border border-rule-strong px-3 py-1.5 text-sm font-semibold hover:bg-paper-3">
                <Download size={14} /> CA pack
              </a>
              <ExportButton entity="payroll_run" params={{ run_id: run.id }} label="Payslips xlsx" />
            </>
          )}
        </div>
      </header>

      <ErrorNote msg={err || autoOpen.error?.message || ""} />

      {/* Summary strip */}
      <Card className="grid grid-cols-3 divide-x divide-rule px-0 py-3.5 text-center">
        <Sum label="Gross" value={`₹${sum(run.payslips, "gross_rupees").toLocaleString("en-IN")}`} />
        <Sum label="Advances recovered" value={`₹${sum(run.payslips, "advance_recovery_rupees").toLocaleString("en-IN")}`} />
        <Sum label="Net payable" value={`₹${sum(run.payslips, "net_rupees").toLocaleString("en-IN")}`} strong />
      </Card>

      <Card className="divide-y divide-rule">
        {run.payslips.map((s: any) => (
          <div key={s.id} className="px-4 py-3">
            <div className="flex items-center gap-3">
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{s.name}</span>
                <span className="block text-xs text-ink-faint">{s.designation}</span>
              </span>
              <span className="num text-lg font-semibold">{inr(Math.round(s.net_rupees * 100))}</span>
            </div>

            {/* the transparent math line — mirrors their Excel */}
            <div className="num mt-1.5 overflow-x-auto whitespace-nowrap rounded-md bg-paper-3/60 px-3 py-1.5 text-xs text-ink-soft">
              {s.credited_days} days
              ({s.presents}P{s.doubles ? ` + ${s.doubles}×2` : ""}{s.halves ? ` + ${s.halves}H` : ""})
              × ₹{s.per_day_rupees}/day
              {" "}− adv ₹{s.advance_recovery_rupees.toLocaleString("en-IN")}
              {s.bonus_rupees ? ` + bonus ₹${s.bonus_rupees.toLocaleString("en-IN")}` : ""}
              {s.deduction_rupees ? ` − ded ₹${s.deduction_rupees.toLocaleString("en-IN")}` : ""}
              {" "}= <b>{inr(Math.round(s.net_rupees * 100))}</b>
              {s.lates_count > 0 && <span className="ml-2 text-bad">{s.lates_count} late</span>}
            </div>

            <div className="mt-2 flex items-center gap-2">
              {run.status === "finalized" ? (
                s.paid_rupees >= s.net_rupees && s.net_rupees > 0 ? (
                  <Badge tone="good">paid · {s.mode}</Badge>
                ) : (
                  <MarkPaid slip={s} onDone={() => qc.invalidateQueries({ queryKey: ["payroll-run", runId] })} />
                )
              ) : (
                <>
                  <Button size="sm" variant="outline"
                          onClick={() => setAdjustFor(s.id)}><Plus size={13} /> Bonus / deduction</Button>
                  {s.adjustments?.map((a: any) => {
                    const label = a.kind === "bonus_days" ? `${a.days}d bonus` :
                      a.kind === "bonus_amt" ? `+₹${a.amount_rupees}` : `−₹${a.amount_rupees}`;
                    return (
                      <span key={a.id} className="inline-flex items-center gap-1 rounded-full bg-paper-3 px-2 py-0.5 text-xs">
                        {label} ({a.reason})
                        <button aria-label="Remove this adjustment"
                                disabled={removeAdjustment.isPending}
                                onClick={() => setRemovingAdjustment({ id: a.id, label, reason: a.reason })}>
                          <Trash2 size={11} />
                        </button>
                      </span>
                    );
                  })}
                </>
              )}
            </div>
          </div>
        ))}
        {run.payslips.length === 0 && (
          <div className="px-4 py-8 text-center text-sm text-ink-faint">
            No active staff for this outlet/month.
          </div>
        )}
      </Card>

      <AdjustSheet
        payslipId={adjustFor} onClose={() => setAdjustFor(null)}
        onDone={() => { setAdjustFor(null); qc.invalidateQueries({ queryKey: ["payroll-run", runId] }); }} />
      <ConfirmSheet
        open={removingAdjustment != null}
        onClose={() => setRemovingAdjustment(null)}
        onConfirm={() => {
          if (removingAdjustment) removeAdjustment.mutate(removingAdjustment.id);
        }}
        title="Remove adjustment?"
        description={removingAdjustment
          ? `Remove ${removingAdjustment.label} (${removingAdjustment.reason}) from this payslip?`
          : ""}
        confirmLabel="Remove adjustment"
        pending={removeAdjustment.isPending}
        pendingLabel="Removing…"
      />

      <p className="px-1 text-xs leading-relaxed text-ink-faint">
        Credited days come straight from the attendance grid — presents, half-days at half rate,
        and each ×2 double shift as a full extra day. Each credited day is paid at the person's
        amount per day, which is their monthly salary ÷ {run.payslips[0]?.divisor ?? 26} paid days.
      </p>
    </div>
  );
}

const sum = (rows: any[], k: string) => rows.reduce((s, r) => s + (r[k] ?? 0), 0);
const inr = (rupees: number) =>
  rupees.toLocaleString("en-IN", { maximumFractionDigits: 0 });

function Sum({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="px-2">
      <SectionLabel>{label}</SectionLabel>
      <div className={`num mt-0.5 ${strong ? "text-xl font-semibold" : "text-base"}`}>{value}</div>
    </div>
  );
}

function FinalizeButton({ runId, onDone }: { runId: number; onDone: () => void }) {
  const guarded = useGuarded({
    title: "Finalizing locks this month",
    heading: "Enter your password to finalize this month",
    body: "Finalizing recovers advances, produces payslips and locks the month against further edits.",
  });
  const [confirming, setConfirming] = useState(false);
  const fin = useMutation({
    mutationFn: () => guarded(() => api.post(`/payroll/runs/${runId}/finalize`)),
    onSuccess: onDone,
    onError: () => setConfirming(false),
  });
  if (!confirming)
    return <Button size="sm" onClick={() => setConfirming(true)}>Finalize month</Button>;
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-ink-faint">Lock this month?</span>
      <Button size="sm" onClick={() => fin.mutate()} disabled={fin.isPending}>
        <Lock size={13} /> Yes, finalize
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>No</Button>
    </div>
  );
}

function MarkPaid({ slip, onDone }: { slip: any; onDone: () => void }) {
  const guarded = useGuarded();
  const [mode, setMode] = useState("upi");
  const pay = useMutation({
    mutationFn: () => guarded(() => api.post(`/payroll/payslips/${slip.id}/paid`, {
      mode, paid_on: todayISO(),
    })),
    onSuccess: onDone,
  });
  return (
    <span className="inline-flex items-center gap-1.5">
      <Select size="compact" value={mode} onChange={(e) => setMode(e.target.value)}
              className="!w-auto">
        <option value="upi">UPI</option><option value="cash">cash</option><option value="bank">bank</option>
      </Select>
      <Button size="sm" variant="outline" onClick={() => pay.mutate()} disabled={pay.isPending}>
        Mark paid ₹{slip.net_rupees.toLocaleString("en-IN")}
      </Button>
    </span>
  );
}

function AdjustSheet({ payslipId, onClose, onDone }: {
  payslipId: number | null; onClose: () => void; onDone: () => void;
}) {
  const guarded = useGuarded();
  const [kind, setKind] = useState(BLANK_ADJUSTMENT.kind);
  const [days, setDays] = useState(BLANK_ADJUSTMENT.days);
  const [amount, setAmount] = useState(BLANK_ADJUSTMENT.amount);
  const [reason, setReason] = useState(BLANK_ADJUSTMENT.reason);
  const reset = () => {
    setKind(BLANK_ADJUSTMENT.kind); setDays(BLANK_ADJUSTMENT.days);
    setAmount(BLANK_ADJUSTMENT.amount); setReason(BLANK_ADJUSTMENT.reason);
  };
  useEffect(() => {
    reset();
  }, [payslipId]);
  const valueText = kind === "bonus_days" ? days : amount;
  const value = Number(valueText);
  const valueValid = valueText.trim() !== "" && Number.isFinite(value) && value > 0;
  const reasonValid = Boolean(reason.trim());
  const valueError = valueText.trim() !== "" && !valueValid
    ? `${kind === "bonus_days" ? "Days" : "Amount"} must be a finite value greater than 0.`
    : "";
  const reasonError = !reasonValid && reason !== "" ? "Reason is required." : "";
  const adj = useMutation({
    mutationFn: () => guarded(() => api.post(`/payroll/payslips/${payslipId}/adjust`, {
      kind,
      days: kind === "bonus_days" ? value : undefined,
      amount_rupees: kind !== "bonus_days" ? value : undefined,
      reason: reason.trim(),
    })),
    onSuccess: onDone,
  });
  const draft = useDirtyDraft({
    open: payslipId != null, label: "salary adjustment",
    values: { kind, days, amount, reason }, pristine: BLANK_ADJUSTMENT,
    discard: () => { reset(); onClose(); },
  });
  return (
    <Sheet open={payslipId != null} onClose={draft.close} title="Bonus or deduction">
      <div className="space-y-3.5">
        <Field label="Type">
          <Select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="bonus_days">Extra credited days</option>
            <option value="bonus_amt">Bonus amount</option>
            <option value="deduction">Deduction</option>
          </Select>
        </Field>
        {kind === "bonus_days" ? (
          <Field label="Days" hint="e.g., covered a double shift → 1 day">
            <Input inputMode="decimal" value={days} onChange={(e) => setDays(e.target.value)} className="text-right" />
          </Field>
        ) : (
          <Field label="Amount (₹)">
            <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className="text-right" />
          </Field>
        )}
        <Field label="Reason" hint='Required — e.g., "Diwali cover", "damage"'>
          <Input value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <ErrorNote msg={(adj.error?.message ?? valueError) || reasonError} />
        <Button size="lg" className="w-full" disabled={!valueValid || !reasonValid || adj.isPending} onClick={() => adj.mutate()}>
          Apply to salary
        </Button>
      </div>
    </Sheet>
  );
}
