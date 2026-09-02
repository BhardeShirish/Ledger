import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useOutletContext } from "react-router-dom";
import { useState } from "react";
import { api } from "../api/client";
import { useGuarded } from "../lib/auth";
import { fmtDateShort, inr, todayISO } from "../lib/format";
import {
  Badge, Button, Card, EmptyState, ErrorNote, Field, Input, SectionLabel, Select, Sheet,
  Spinner,
} from "../components/ui";

export default function InventoryWastage() {
  const { outletId } = useOutletContext<{ outletId: number }>();
  const guarded = useGuarded();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ stock_item_id: "", qty: "", reason: "spoiled", business_date: todayISO() });
  const [err, setErr] = useState("");

  const list = useQuery({
    queryKey: ["inv-wastage", outletId],
    queryFn: () => api.get(`/inventory/wastage?outlet_id=${outletId}` +
                           `&start=${todayISO().slice(0, 8)}01&end=${todayISO()}`),
  });
  const items = useQuery({
    queryKey: ["inv-items", outletId],
    queryFn: () => api.get(`/inventory/overview?outlet_id=${outletId}`),
  });

  const add = useMutation({
    mutationFn: () => guarded(() => api.post("/inventory/wastage", {
      outlet_id: outletId, business_date: f.business_date,
      stock_item_id: Number(f.stock_item_id), qty: Number(f.qty),
      reason: f.reason,
    })),
    onSuccess: () => {
      setOpen(false); setF((x) => ({ ...x, stock_item_id: "", qty: "", reason: "spoiled" }));
      qc.invalidateQueries({ queryKey: ["inv-wastage"] });
      qc.invalidateQueries({ queryKey: ["inv-items"] });
    },
    onError: (e: any) => setErr(e.message),
  });

  const totalCost = (list.data ?? []).reduce((s: number, r: any) => s + r.cost_rupees, 0);

  return (
    <div className="space-y-4">
      <header className="flex items-end justify-between">
        <div>
          <SectionLabel>Wastage · this month</SectionLabel>
          <h1 className="text-2xl font-semibold tracking-tight">
            ₹{totalCost.toLocaleString("en-IN")}
            <span className="text-sm font-normal text-ink-faint"> thrown away</span>
          </h1>
        </div>
        <Button size="sm" onClick={() => setOpen(true)}>+ Log wastage</Button>
      </header>

      <Card className="divide-y divide-rule">
        {(list.data ?? []).length === 0 && (
          <EmptyState title="No wastage logged"
                      hint="Spoiled, burnt, expired — log it here so food cost tells the truth." />
        )}
        {(list.data ?? []).map((r: any) => (
          <div key={r.date + r.item} className="flex items-center gap-3 px-4 py-2.5 text-sm">
            <span className="w-20 shrink-0 text-ink-soft">{fmtDateShort(r.date)}</span>
            <span className="min-w-0 flex-1 truncate font-medium">{r.item}</span>
            <Badge tone="warn">{r.qty}</Badge>
            <span className="num w-24 text-right font-medium">{inr(Math.round(r.cost_rupees * 100))}</span>
            <span className="hidden w-40 truncate text-xs text-ink-faint sm:block">{r.reason}</span>
          </div>
        ))}
      </Card>

      <Sheet open={open} onClose={() => setOpen(false)} title="Log wastage">
        <div className="space-y-3.5">
          <Field label="Item">
            <Select value={f.stock_item_id}
                    onChange={(e) => setF((x) => ({ ...x, stock_item_id: e.target.value }))}>
              <option value="">Choose…</option>
              {(items.data?.items ?? []).map((i: any) => (
                <option key={i.id} value={i.id}>{i.name}</option>
              ))}
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Quantity"><Input inputMode="decimal" value={f.qty}
                     onChange={(e) => setF((x) => ({ ...x, qty: e.target.value }))} className="text-right" /></Field>
            <Field label="Date"><Input type="date" value={f.business_date}
                     onChange={(e) => setF((x) => ({ ...x, business_date: e.target.value }))} /></Field>
          </div>
          <Field label="Reason">
            <Select value={f.reason} onChange={(e) => setF((x) => ({ ...x, reason: e.target.value }))}>
              <option value="spoiled">Spoiled</option>
              <option value="burnt">Burnt / cooking error</option>
              <option value="expired">Expired</option>
              <option value="dropped">Dropped / damaged</option>
              <option value="other">Other</option>
            </Select>
          </Field>
          <ErrorNote msg={err} />
          <Button size="lg" className="w-full" disabled={!f.stock_item_id || !Number(f.qty) || add.isPending}
                  onClick={() => add.mutate()}>Log wastage</Button>
        </div>
      </Sheet>
    </div>
  );
}


