import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useGuarded } from "../lib/auth";
import { fmtDateShort, inr, todayISO } from "../lib/format";
import { ExportButton } from "../components/DataButtons";
import {
  Badge, Button, Card, EmptyState, ErrorNote, Field, Input, SectionLabel,
  Select, Sheet, Spinner,
} from "../components/ui";

export default function Advances() {
  const qc = useQueryClient();
  const guarded = useGuarded();
  const q = useQuery({
    queryKey: ["advances"],
    queryFn: () => guarded(() => api.get("/advances")),
  });
  const people = useQuery({ queryKey: ["people-all"], queryFn: () => api.get("/staff/employees?include_inactive=true") });
  const [open, setOpen] = useState(false);
  const [empId, setEmpId] = useState<number | "">("");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(todayISO());
  const [note, setNote] = useState("");
  const give = useMutation({
    mutationFn: () => guarded(() => api.post("/advances", {
      employee_id: empId, date,
      amount_rupees: Number(amount), note,
    })),
    onSuccess: () => {
      setOpen(false); setAmount(""); setNote("");
      qc.invalidateQueries({ queryKey: ["advances"] });
    },
  });

  if (q.isLoading) return <Spinner />;
  const rows: any[] = q.data ?? [];
  const openTotal = rows.filter((r) => r.status === "open")
                        .reduce((s, r) => s + r.remaining_paise, 0);

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <SectionLabel>Money · Advances</SectionLabel>
          <h1 className="text-2xl font-semibold tracking-tight">
            {inr(openTotal)} <span className="text-sm font-normal text-ink-faint">outstanding</span>
          </h1>
        </div>
        <div className="flex gap-2">
          <ExportButton entity="advances" />
          <Button size="sm" onClick={() => setOpen(true)}>+ Give advance</Button>
        </div>
      </header>

      <Card className="divide-y divide-rule">
        {rows.length === 0 && (
          <EmptyState title="No advances given" hint="Money given ahead of salary shows here and auto-deducts from that month's payroll." />
        )}
        {rows.map((a) => (
          <div key={a.id} className="flex items-center gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="font-medium">{a.employee_name}</div>
              <div className="text-xs text-ink-faint">
                {fmtDateShort(a.date)}{a.note ? ` · ${a.note}` : ""}
              </div>
            </div>
            {a.status === "open" ? (
              <Badge tone="warn">{inr(a.remaining_paise)} left</Badge>
            ) : (
              <Badge tone="good">cleared</Badge>
            )}
            <div className="num w-24 text-right font-medium">{inr(a.amount_paise)}</div>
            {a.status === "open" && (
              <RepayButton a={a} onDone={() => qc.invalidateQueries({ queryKey: ["advances"] })} />
            )}
          </div>
        ))}
      </Card>

      <Sheet open={open} onClose={() => setOpen(false)} title="Give salary advance">
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
    </div>
  );
}

function RepayButton({ a, onDone }: any) {
  const guarded = useGuarded();
  const [open, setOpen] = useState(false);
  const [amt, setAmt] = useState(String(a.remaining_rupees));
  useEffect(() => {
    if (open) setAmt(String(a.remaining_rupees));
  }, [open, a.id, a.remaining_rupees]);
  const repay = useMutation({
    mutationFn: () => guarded(() => api.post(`/advances/${a.id}/repay`, {
      date: todayISO(), amount_rupees: Number(amt), via: "cash", note: "cash repayment",
    })),
    onSuccess: () => { setOpen(false); onDone(); },
  });
  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>repay</Button>
      <Sheet open={open} onClose={() => setOpen(false)} title={`Repay ${a.employee_name}`}>
        <div className="space-y-3">
          <Field label="Amount received now">
            <Input autoFocus inputMode="decimal" value={amt}
                   onChange={(e) => setAmt(e.target.value)} className="text-right text-xl" />
          </Field>
          <Button className="w-full" disabled={!Number(amt) || repay.isPending} onClick={() => repay.mutate()}>
            Record cash repayment
          </Button>
        </div>
      </Sheet>
    </>
  );
}
