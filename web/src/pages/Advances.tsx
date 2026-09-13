import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Lock } from "lucide-react";
import { api } from "../api/client";
import { useGuarded } from "../lib/auth";
import { fmtDateShort, inr, todayISO } from "../lib/format";
import { useDirtyDraft } from "../lib/useDirtyDraft";
import { ExportButton } from "../components/DataButtons";
import {
  Badge, Button, Card, EmptyState, ErrorNote, Field, Input, SectionLabel,
  Select, Sheet, Spinner,
} from "../components/ui";

/** Route-specific wording for the owner password sheet that opens over this
 * page — a generic prompt gave no clue which screen was being unlocked. */
const ADVANCES_STEP_UP = {
  title: "Advances are owner-only",
  heading: "Enter your password to open Salary advances",
  body: "Advances given and repaid stay locked until you confirm it's you. Unlocking only shows the list — no money moves.",
};

/** Kicker + title stay on screen while the list is locked or loading. */
function AdvancesFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-4">
      <header>
        <SectionLabel>Staff · Advances</SectionLabel>
        <h1 className="text-2xl font-semibold tracking-tight">Salary advances</h1>
      </header>
      {children}
    </div>
  );
}

export default function Advances() {
  const qc = useQueryClient();
  const guarded = useGuarded(ADVANCES_STEP_UP);
  const q = useQuery({
    queryKey: ["advances"],
    queryFn: () => guarded(() => api.get("/advances")),
  });
  const people = useQuery({ queryKey: ["people-all"], queryFn: () => api.get("/staff/employees?include_inactive=true") });
  const [open, setOpen] = useState(false);
  const blank = useMemo(
    () => ({ empId: "" as number | "", amount: "", date: todayISO(), note: "" }),
    [],
  );
  const [empId, setEmpId] = useState<number | "">(blank.empId);
  const [amount, setAmount] = useState(blank.amount);
  const [date, setDate] = useState(blank.date);
  const [note, setNote] = useState(blank.note);
  const reset = () => {
    setEmpId(blank.empId); setAmount(blank.amount);
    setDate(blank.date); setNote(blank.note);
  };
  const give = useMutation({
    mutationFn: () => guarded(() => api.post("/advances", {
      employee_id: empId, date,
      amount_rupees: Number(amount), note,
    })),
    onSuccess: () => {
      setOpen(false); reset();
      qc.invalidateQueries({ queryKey: ["advances"] });
    },
  });
  const draft = useDirtyDraft({
    open, label: "salary advance",
    values: { empId, amount, date, note }, pristine: blank,
    discard: () => { reset(); setOpen(false); },
  });

  if (q.isLoading)
    return (
      <AdvancesFrame>
        <Card className="px-4 py-5">
          <p className="flex items-center gap-2 text-sm font-medium">
            <Lock size={15} className="shrink-0 text-ink-faint" /> Owner-only screen
          </p>
          <p className="mt-1 text-sm text-ink-faint">
            Salary advances open once your password is confirmed. If a password
            panel is showing, it belongs to this screen.
          </p>
          <Spinner label="Opening salary advances…" />
        </Card>
      </AdvancesFrame>
    );
  const rows: any[] = q.data ?? [];
  const openTotal = rows.filter((r) => r.status === "open")
                        .reduce((s, r) => s + r.remaining_paise, 0);

  return (
    <AdvancesFrame>
      <div className="flex flex-wrap items-end justify-between gap-2">
        <p className="num text-lg font-semibold">
          {inr(openTotal)} <span className="text-sm font-normal text-ink-faint">outstanding</span>
        </p>
        <div className="flex flex-wrap gap-2">
          <ExportButton entity="advances" />
          <Button size="sm" onClick={() => setOpen(true)}>+ Give advance</Button>
        </div>
      </div>

      <Card className="divide-y divide-rule">
        {rows.length === 0 && (
          <EmptyState title="No advances given" hint="Money given ahead of salary shows here and auto-deducts from that month's payroll." />
        )}
        {rows.map((a) => (
          <div key={a.id} className="px-4 py-3">
            <div className="flex items-baseline gap-3">
              <span className="min-w-0 flex-1 truncate font-medium">{a.employee_name}</span>
              <span className="num shrink-0 font-medium">{inr(a.amount_paise)}</span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-xs text-ink-faint">
                {fmtDateShort(a.date)}{a.note ? ` · ${a.note}` : ""}
              </span>
              {a.status === "open" ? (
                <Badge tone="warn">{inr(a.remaining_paise)} left</Badge>
              ) : (
                <Badge tone="good">cleared</Badge>
              )}
              {a.status === "open" && (
                <RepayButton a={a} onDone={() => qc.invalidateQueries({ queryKey: ["advances"] })} />
              )}
            </div>
          </div>
        ))}
      </Card>

      <Sheet open={open} onClose={draft.close} title="Give salary advance">
        <div className="space-y-3.5">
          <Field label="Staff member">
            <Select value={empId} onChange={(e) => setEmpId(Number(e.target.value))}>
              <option value="">Choose…</option>
              {(people.data ?? []).map((p: any) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </Select>
          </Field>
          <Field label="Amount">
            <Input inputMode="decimal" placeholder="₹" value={amount}
                   onChange={(e) => setAmount(e.target.value)} className="text-right text-xl" />
          </Field>
          <Field label="Date">
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Note (optional)">
            <Input value={note} onChange={(e) => setNote(e.target.value)}
                   placeholder="medical, festival…" />
          </Field>
          <ErrorNote msg={give.error?.message ?? ""} />
          <Button size="lg" className="w-full" disabled={!empId || !Number(amount) || give.isPending}
                  onClick={() => give.mutate()}>
            Record advance
          </Button>
          <p className="text-xs text-ink-faint">
            Advances given this month deduct automatically when you finalize that month's payroll.
          </p>
        </div>
      </Sheet>
    </AdvancesFrame>
  );
}

function RepayButton({ a, onDone }: any) {
  const guarded = useGuarded();
  const [open, setOpen] = useState(false);
  const suggested = useMemo(
    () => ({ amt: String(a.remaining_rupees), via: "upi" }),
    [a.remaining_rupees],
  );
  const [amt, setAmt] = useState(suggested.amt);
  const [via, setVia] = useState(suggested.via);
  useEffect(() => {
    if (open) { setAmt(String(a.remaining_rupees)); setVia("upi"); }
  }, [open, a.id, a.remaining_rupees]);
  const repay = useMutation({
    mutationFn: () => guarded(() => api.post(`/advances/${a.id}/repay`, {
      date: todayISO(), amount_rupees: Number(amt), via, note: `${via} repayment`,
    })),
    onSuccess: () => { setOpen(false); onDone(); },
  });
  const draft = useDirtyDraft({
    open, label: `repayment from ${a.employee_name}`,
    values: { amt, via }, pristine: suggested,
    discard: () => { setAmt(suggested.amt); setVia(suggested.via); setOpen(false); },
  });
  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>repay</Button>
      <Sheet open={open} onClose={draft.close} title={`Repay ${a.employee_name}`}>
        <div className="space-y-3">
          <Field label="Amount received now">
            <Input autoFocus inputMode="decimal" value={amt}
                   onChange={(e) => setAmt(e.target.value)} className="text-right text-xl" />
          </Field>
          <Field label="Received by">
            <Select value={via} onChange={(e) => setVia(e.target.value)}>
              <option value="upi">UPI</option>
              <option value="cash">Cash</option>
              <option value="bank">Bank transfer</option>
              <option value="other">Other</option>
            </Select>
          </Field>
          <Button className="w-full" disabled={!Number(amt) || repay.isPending} onClick={() => repay.mutate()}>
            Record repayment
          </Button>
        </div>
      </Sheet>
    </>
  );
}
