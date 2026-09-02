import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { api } from "../api/client";
import { fmtDateShort, inr, minToHHMM, todayISO } from "../lib/format";
import { ExportButton } from "../components/DataButtons";
import {
  Badge, Button, Card, EmptyState, ErrorNote, Field, Input, SectionLabel,
  Sheet, Spinner,
} from "../components/ui";

const KIND_LABEL: Record<string, string> = {
  cash: "Cash", upi: "UPI", card: "Card", split: "Split bill",
  due: "Credit due", wallet: "Wallet", aggregator: "Delivery app", other: "Other",
};
const ALLOC_CHANNELS = ["cash", "upi", "card"];

export default function Bills() {
  const { outletId } = useOutletContext<{ outletId: number }>();
  const [date, setDate] = useState("");
  const [kind, setKind] = useState("");
  const [qText, setQText] = useState("");
  const [allocating, setAllocating] = useState<any>(null);

  const q = useQuery({
    queryKey: ["bills", outletId, date],
    queryFn: () => api.get(`/sales/bills?outlet_id=${outletId}${date ? `&business_date=${date}` : ""}`),
    placeholderData: (prev) => prev,
  });
  const splits = useQuery({
    queryKey: ["splits", outletId],
    queryFn: () => api.get(`/sales/unresolved-splits?outlet_id=${outletId}`),
  });

  if (q.isLoading) return <Spinner />;
  let rows: any[] = q.data ?? [];
  if (kind) rows = rows.filter((b) => b.channel_kind === kind);
  if (qText) {
    const t = qText.toLowerCase();
    rows = rows.filter((b) =>
      String(b.invoice_no).includes(t) || b.area?.toLowerCase().includes(t));
  }

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <SectionLabel>Sales · Bills</SectionLabel>
          <h1 className="text-2xl font-semibold tracking-tight">Every bill, searchable</h1>
        </div>
        <div className="flex flex-wrap gap-2">
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
                 className="rounded-md border border-rule-strong bg-paper px-2.5 py-1.5 num text-sm" />
          <select value={kind} onChange={(e) => setKind(e.target.value)}
                  className="rounded-md border border-rule-strong bg-paper px-2 py-1.5 text-sm">
            <option value="">All modes</option>
            {Object.entries(KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <ExportButton entity="bills" params={{ outlet_id: outletId, date }} />
      </div>

      {(splits.data ?? []).length > 0 && (
        <Card className="border-accent/40 bg-accent-soft/40 px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm">
              <b>{splits.data.length}</b> part-payment bills need their split decided.
            </div>
            <Button size="sm" onClick={() => setAllocating(splits.data[0])}>
              Resolve splits
            </Button>
          </div>
        </Card>
      )}

      <Input placeholder="Search invoice no…" value={qText}
             onChange={(e) => setQText(e.target.value)} />

      <Card className="divide-y divide-rule">
        {rows.length === 0 && (
          <EmptyState title="No bills found"
                      hint="Import a Petpooja Orders Master Report to fill history — every bill lands here." />
        )}
        {rows.slice(0, 300).map((b) => (
          <button key={b.id}
                  onClick={() => b.channel_kind === "split" && setAllocating(b)}
                  className={`flex w-full items-center gap-3 px-4 py-2 text-left text-sm ${
                    b.channel_kind === "split" ? "hover:bg-accent-soft/50" : ""}`}>
            <span className="num w-16 shrink-0 text-ink-faint">#{b.invoice_no}</span>
            <span className="w-20 shrink-0 text-ink-soft">{fmtDateShort(b.business_date)}</span>
            <span className="w-12 shrink-0 num text-xs text-ink-faint">{minToHHMM(Number(b.bill_ts.slice(11, 13)) * 60 + Number(b.bill_ts.slice(14, 16)))}</span>
            <Badge tone={b.channel_kind === "split" ? "warn" : "neutral"}>
              {KIND_LABEL[b.channel_kind] ?? b.channel_kind}
            </Badge>
            <span className="min-w-0 flex-1 truncate text-xs text-ink-faint">{b.order_type}{b.persons ? ` · ${b.persons} pax` : ""}</span>
            {!!b.discount_paise && (
              <span className="num text-xs text-accent">−{inr(b.discount_paise)}</span>
            )}
            <span className="num font-medium">{inr(b.total_paise)}</span>
          </button>
        ))}
      </Card>
      {rows.length > 300 && (
        <p className="text-center text-xs text-ink-faint">Showing the first 300 — narrow by date or mode.</p>
      )}

      <SplitAllocator bill={allocating} outletId={outletId}
                      onClose={() => setAllocating(null)} />
    </div>
  );
}

function SplitAllocator({ bill, onClose, outletId }: any) {
  const qc = useQueryClient();
  const [amounts, setAmounts] = useState<Record<string, string>>({
    cash: "", upi: "", card: "",
  });
  useEffect(() => {
    setAmounts({ cash: "", upi: "", card: "" });
  }, [bill?.id]);
  const total = Object.values(amounts).reduce((s, v) => s + (Number(v) || 0), 0);
  const target = Number(bill?.total_rupees ?? 0);
  const balanced = Math.abs(total - target) < 0.005;

  const save = useMutation({
    mutationFn: () => api.post(`/sales/bills/${bill.id}/allocate-split`, {
      allocations: Object.entries(amounts)
        .filter(([, v]) => Number(v) > 0)
        .map(([k, v]) => ({ channel_kind: k, amount_rupees: Number(v) })),
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["bills"] });
      qc.invalidateQueries({ queryKey: ["splits"] });
      qc.invalidateQueries({ queryKey: ["sales-sheet"] });
      onClose();
    },
  });

  return (
    <Sheet open={!!bill} onClose={onClose}
           title={`Split · #${bill?.invoice_no ?? ""} · ${fmtDateShort(bill?.business_date ?? "")}`}>
      <div className="space-y-3.5">
        <Card className="bg-paper-3/50 px-4 py-2.5 text-center">
          <SectionLabel>Bill total to distribute</SectionLabel>
          <div className="num text-2xl font-semibold">{inr(Math.round(target * 100))}</div>
        </Card>
        {ALLOC_CHANNELS.map((k) => (
          <Field key={k} label={KIND_LABEL[k]}>
            <Input inputMode="decimal" placeholder="₹"
                   value={amounts[k]}
                   onChange={(e) => setAmounts((x) => ({ ...x, [k]: e.target.value }))}
                   className="text-right" />
          </Field>
        ))}
        <Card className={`px-4 py-2.5 text-sm ${balanced ? "bg-good/10" : "bg-paper-3/60"}`}>
          <div className="flex justify-between">
            <span>Distributed</span>
            <span className="num font-semibold">{inr(Math.round(total * 100))}</span>
          </div>
          {!balanced && (
            <div className="mt-0.5 flex justify-between text-bad">
              <span>Remaining</span>
              <span className="num font-semibold">{inr(Math.round((target - total) * 100))}</span>
            </div>
          )}
        </Card>
        <ErrorNote msg={save.error?.message ?? ""} />
        <Button size="lg" className="w-full" disabled={!balanced || save.isPending}
                onClick={() => save.mutate()}>
          Allocate &amp; resolve
        </Button>
      </div>
    </Sheet>
  );
}
