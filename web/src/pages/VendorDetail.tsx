import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useOutletContext, useParams } from "react-router-dom";
import { useEffect, useRef, useState } from "react";
import { Camera } from "lucide-react";
import { api } from "../api/client";
import { fmtDateShort, inr, todayISO } from "../lib/format";
import {
  Badge, Button, Card, EmptyState, ErrorNote, Field, Input, SectionLabel,
  Select, Sheet, Spinner,
} from "../components/ui";


const TYPE_LABEL: Record<string, string> = {
  purchase_credit: "Bought on credit",
  payment: "Paid them",
  adjustment: "Adjustment",
};

export default function VendorDetail() {
  const { id } = useParams();
  const { outletId } = useOutletContext<{ outletId: number }>();
  const vid = Number(id);
  const q = useQuery({ queryKey: ["vendor-ledger", vid], queryFn: () => api.get(`/vendors/${vid}/ledger`) });
  const qc = useQueryClient();

  const [openType, setOpenType] = useState<"purchase_credit" | "payment" | null>(null);
  const [amount, setAmount] = useState("");
  const [mode, setMode] = useState("upi");
  const [date, setDate] = useState(todayISO());
  const [note, setNote] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const [receiptPath, setReceiptPath] = useState<string | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    setAmount(""); setMode("upi"); setDate(todayISO());
    setNote(""); setReceiptPath(null); setErr("");
  }, [openType, vid]);

  const add = useMutation({
    mutationFn: () => api.post(`/vendors/${vid}/entries`, {
      outlet_id: outletId,
      date, type: openType, amount_rupees: Number(amount), mode,
      note, receipt_path: receiptPath,
    }),
    onSuccess: () => {
      setOpenType(null); setAmount(""); setNote(""); setReceiptPath(null); setErr("");
      qc.invalidateQueries({ queryKey: ["vendor-ledger", vid] });
      qc.invalidateQueries({ queryKey: ["vendors"] });
      qc.invalidateQueries({ queryKey: ["expenses"] });
    },
    onError: (e: any) => setErr(e.message),
  });

  if (q.isLoading) return <Spinner />;
  const { vendor, rows } = q.data;

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <SectionLabel>Vendor</SectionLabel>
          <h1 className="text-2xl font-semibold tracking-tight">{vendor.name}</h1>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setOpenType("purchase_credit")}>Bought on credit</Button>
          <Button onClick={() => setOpenType("payment")}>Record payment</Button>
        </div>
      </header>

      <Card className="px-4 py-4">
        <SectionLabel>Balance we owe</SectionLabel>
        <div className={`num mt-1 text-4xl font-semibold ${vendor.balance_paise > 0 ? "text-bad" : "text-good"}`}>
          {inr(vendor.balance_paise)}
        </div>
      </Card>

      <Card className="divide-y divide-rule">
        {rows.map((r: any) => (
          <div key={r.id} className="flex items-center gap-3 px-4 py-2.5">
            <div className="min-w-0 flex-1">
              <div className="font-medium">{TYPE_LABEL[r.type]}</div>
              <div className="text-xs text-ink-faint">{fmtDateShort(r.date)}{r.note ? ` · ${r.note}` : ""}</div>
            </div>
            {r.receipt_path && (
              <a href={r.receipt_path} target="_blank"><Camera size={14} className="text-ink-faint" /></a>
            )}
            <div className={`num font-medium ${r.type === "purchase_credit" ? "" : "text-good"}`}>
              {r.type === "purchase_credit" ? "+" : "−"}{inr(r.amount_paise)}
            </div>
          </div>
        ))}
        {rows.length === 0 && (
          <EmptyState title="No entries yet"
                      hint="Credit purchases raise the balance; payments bring it down." />
        )}
      </Card>

      <Sheet open={openType != null} onClose={() => setOpenType(null)}
             title={openType === "payment" ? `Payment to ${vendor.name}` : `Credit purchase from ${vendor.name}`}>
        <div className="space-y-3.5">
          <Field label="Amount">
            <Input autoFocus inputMode="decimal" placeholder="₹" value={amount}
                   onChange={(e) => setAmount(e.target.value)} className="text-right text-xl" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Date">
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>
            {openType === "payment" && (
              <Field label="Paid by">
                <Select value={mode} onChange={(e) => setMode(e.target.value)}>
                  <option value="upi">UPI</option><option value="cash">Cash</option>
                  <option value="bank">Bank</option><option value="other">Other</option>
                </Select>
              </Field>
            )}
          </div>
          {openType === "payment" && (
            <p className="text-xs text-ink-faint">
              This settles an existing liability and does not create a second expense.
            </p>
          )}
          <Field label="Note (optional)">
            <Input value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <input ref={fileRef} type="file" accept="image/*,.pdf" hidden
                 onChange={async (e) => {
                   const f = e.target.files?.[0];
                   if (!f) return;
                   const fd = new FormData(); fd.append("file", f);
                   const r = await api.post("/uploads", fd);
                   setReceiptPath(r.path);
                 }} />
          <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
            <Camera size={14} /> Attach receipt
          </Button>
          {receiptPath && <Badge tone="good">receipt attached</Badge>}
          <ErrorNote msg={err} />
          <Button size="lg" className="w-full" disabled={!Number(amount) || add.isPending}
                  onClick={() => add.mutate()}>
            Save entry
          </Button>
        </div>
      </Sheet>
    </div>
  );
}
