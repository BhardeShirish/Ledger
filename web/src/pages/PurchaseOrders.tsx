import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { useOutletContext } from "react-router-dom";
import { api } from "../api/client";
import { useAuth } from "../lib/auth";
import { inr, todayISO } from "../lib/format";
import { Badge, Button, Card, EmptyState, ErrorNote, Field, Input, SectionLabel, Select, Sheet, Spinner } from "../components/ui";

type DraftLine = { item_name: string; quantity: string; unit: string; unit_cost_rupees: string };
const blankLine = (): DraftLine => ({ item_name: "", quantity: "", unit: "kg", unit_cost_rupees: "" });

export default function PurchaseOrders() {
  const { outletId } = useOutletContext<{ outletId: number }>();
  const { me } = useAuth();
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [receiving, setReceiving] = useState<any | null>(null);
  const orders = useQuery({ queryKey: ["purchase-orders", outletId], queryFn: () => api.get(`/purchases/orders?outlet_id=${outletId}`) });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["purchase-orders"] });
    qc.invalidateQueries({ queryKey: ["expenses"] });
    qc.invalidateQueries({ queryKey: ["vendors"] });
    qc.invalidateQueries({ queryKey: ["unit-econ"] });
  };
  const approve = useMutation({ mutationFn: (id: number) => api.post(`/purchases/orders/${id}/approve`), onSuccess: refresh });
  const cancel = useMutation({ mutationFn: (id: number) => api.post(`/purchases/orders/${id}/cancel`), onSuccess: refresh });

  if (orders.isLoading) return <Spinner label="Loading purchase orders…" />;
  const rows: any[] = orders.data ?? [];
  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Purchase orders</h1>
          <p className="mt-1 text-sm text-ink-faint">Plan supplier buys first. Books and stock change only when a receipt is finalized.</p>
        </div>
        <Button onClick={() => setCreating(true)}><Plus size={16} /> New order</Button>
      </header>
      {orders.isError && <ErrorNote msg={(orders.error as Error).message} />}
      <Card className="divide-y divide-rule">
        {rows.length === 0 && <EmptyState title="No purchase orders yet" hint="Create a draft, have the owner approve it, then record what actually arrived." />}
        {rows.map((order) => (
          <div key={order.id} className="p-4">
            <div className="flex flex-wrap items-start gap-2">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="font-semibold">{order.vendor_name}</h2>
                  <OrderStatus status={order.status} />
                </div>
                <p className="mt-1 text-xs text-ink-faint">
                  PO #{order.id}{order.expected_date ? ` · expected ${order.expected_date}` : ""} · {order.payment_mode}
                </p>
                {order.approval_policy_warning && (
                  <p className="mt-1 text-xs text-amber-700">
                    Above the owner purchase-warning limit. Owner approval is still required.
                  </p>
                )}
              </div>
              {me?.role === "owner" && order.status === "draft" && (
                <Button size="sm" disabled={approve.isPending} onClick={() => approve.mutate(order.id)}>Approve</Button>
              )}
              {me?.role === "owner" && ["draft", "approved"].includes(order.status) && (
                <Button size="sm" variant="ghost" disabled={cancel.isPending} onClick={() => cancel.mutate(order.id)}>Cancel</Button>
              )}
              {order.status === "approved" && (
                <Button size="sm" variant="outline" onClick={() => setReceiving(order)}>Receive</Button>
              )}
            </div>
            <div className="mt-3 grid gap-1 text-sm">
              {order.lines.map((line: any) => (
                <div key={line.id} className="flex flex-wrap justify-between gap-x-3 text-ink-soft">
                  <span>{line.item_name}</span>
                  <span className="num">{line.quantity} {line.unit} · {inr(line.unit_cost_paise)}/{line.unit}</span>
                </div>
              ))}
            </div>
            {order.receipt && <ReceiptSummary receipt={order.receipt} />}
          </div>
        ))}
      </Card>
      <OrderSheet open={creating} outletId={outletId} onClose={() => setCreating(false)} onSaved={() => { setCreating(false); refresh(); }} />
      <ReceiptSheet order={receiving} onClose={() => setReceiving(null)} onSaved={() => { setReceiving(null); refresh(); }} />
    </div>
  );
}

function OrderStatus({ status }: { status: string }) {
  const tone = status === "received" ? "good" : status === "approved" ? "accent" : status === "cancelled" ? "bad" : "neutral";
  const label = status === "received" ? "Receipt finalized" : status === "approved" ? "Approved — ready to receive" : status === "draft" ? "Planned draft" : "Cancelled";
  return <Badge tone={tone as any}>{label}</Badge>;
}

function ReceiptSummary({ receipt }: { receipt: any }) {
  return (
    <div className="mt-3 border-t border-rule pt-3 text-xs text-ink-faint">
      <div className="font-medium text-ink-soft">
        {receipt.status === "finalized" ? "Finalized receipt" : "Receipt draft — not posted"} · {receipt.business_date}
      </div>
      {receipt.lines.map((line: any) => (
        <div key={line.id} className="mt-1 flex flex-wrap justify-between gap-x-3">
          <span>{line.item_name}: received {line.received_quantity} {line.unit}{line.short_quantity > 0 ? ` · short ${line.short_quantity}` : ""}</span>
          <span className={line.price_variance_paise > 0 ? "text-bad" : ""}>
            {inr(line.unit_price_paise)}/{line.unit}{line.price_variance_paise ? ` (${line.price_variance_paise > 0 ? "+" : ""}${inr(line.price_variance_paise)} vs plan)` : ""}
          </span>
        </div>
      ))}
    </div>
  );
}

function OrderSheet({ open, outletId, onClose, onSaved }: { open: boolean; outletId: number; onClose: () => void; onSaved: () => void }) {
  const [vendorId, setVendorId] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [mode, setMode] = useState("credit");
  const [expectedDate, setExpectedDate] = useState("");
  const [note, setNote] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([blankLine()]);
  const vendors = useQuery({ queryKey: ["vendors"], queryFn: () => api.get("/vendors"), enabled: open });
  const categories = useQuery({ queryKey: ["categories"], queryFn: () => api.get("/lists/categories"), enabled: open });
  const create = useMutation({
    mutationFn: () => api.post("/purchases/orders", {
      outlet_id: outletId, vendor_id: Number(vendorId), category_id: Number(categoryId), payment_mode: mode,
      expected_date: expectedDate || null, note,
      lines: lines.map((line) => ({ ...line, quantity: Number(line.quantity), unit_cost_rupees: Number(line.unit_cost_rupees) })),
    }),
    onSuccess: () => { setLines([blankLine()]); setVendorId(""); setCategoryId(""); setNote(""); onSaved(); },
  });
  const updateLine = (index: number, field: keyof DraftLine, value: string) =>
    setLines((old) => old.map((line, i) => i === index ? { ...line, [field]: value } : line));
  const valid = Boolean(vendorId && categoryId && lines.length && lines.every((line) => line.item_name.trim() && line.unit.trim() && line.quantity !== "" && Number(line.quantity) >= 0 && line.unit_cost_rupees !== "" && Number(line.unit_cost_rupees) >= 0));
  return (
    <Sheet open={open} onClose={onClose} title="Plan purchase order" wide>
      <div className="space-y-4">
        <p className="text-sm text-ink-faint">A draft does not change stock, expenses, or supplier dues. Owner approval is required before receiving.</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Supplier"><Select value={vendorId} onChange={(e) => setVendorId(e.target.value)}><option value="">Choose supplier</option>{(vendors.data ?? []).filter((v: any) => v.is_active).map((v: any) => <option key={v.id} value={v.id}>{v.name}</option>)}</Select></Field>
          <Field label="Expense category"><Select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}><option value="">Choose category</option>{(categories.data ?? []).map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
          <Field label="Payment when received"><Select value={mode} onChange={(e) => setMode(e.target.value)}><option value="credit">Credit — supplier due</option><option value="upi">UPI</option><option value="cash">Cash</option><option value="card">Card</option><option value="bank">Bank transfer</option><option value="other">Other</option></Select></Field>
          <Field label="Expected delivery (optional)"><Input type="date" value={expectedDate} onChange={(e) => setExpectedDate(e.target.value)} /></Field>
        </div>
        <Field label="Note (optional)"><Input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        <div className="space-y-2">
          <h3 className="font-semibold">Planned items</h3>
          {lines.map((line, index) => <div key={index} className="grid grid-cols-[minmax(0,1fr)_5.5rem_4.5rem_5.5rem_auto] gap-2">
            <Input aria-label={`Item ${index + 1}`} placeholder="Item" value={line.item_name} onChange={(e) => updateLine(index, "item_name", e.target.value)} />
            <Input aria-label={`Quantity ${index + 1}`} inputMode="decimal" placeholder="Qty" value={line.quantity} onChange={(e) => updateLine(index, "quantity", e.target.value)} />
            <Input aria-label={`Unit ${index + 1}`} placeholder="kg" value={line.unit} onChange={(e) => updateLine(index, "unit", e.target.value)} />
            <Input aria-label={`Unit cost ${index + 1}`} inputMode="decimal" placeholder="₹/unit" value={line.unit_cost_rupees} onChange={(e) => updateLine(index, "unit_cost_rupees", e.target.value)} />
            <Button aria-label={`Remove item ${index + 1}`} variant="ghost" onClick={() => setLines((old) => old.length > 1 ? old.filter((_, i) => i !== index) : old)}><Trash2 size={16} /></Button>
          </div>)}
          <Button variant="outline" size="sm" onClick={() => setLines((old) => [...old, blankLine()])}><Plus size={15} /> Add item</Button>
        </div>
        <ErrorNote msg={create.error?.message ?? ""} />
        <Button className="w-full" disabled={!valid || create.isPending} onClick={() => create.mutate()}>{create.isPending ? "Saving…" : "Save draft order"}</Button>
      </div>
    </Sheet>
  );
}

function ReceiptSheet({ order, onClose, onSaved }: { order: any | null; onClose: () => void; onSaved: () => void }) {
  const [date, setDate] = useState(todayISO());
  const [lines, setLines] = useState<any[]>([]);
  useEffect(() => {
    if (!order) return;
    setDate(todayISO());
    setLines(order.lines.map((line: any) => ({ order_line_id: line.id, received_quantity: String(line.quantity), unit_price_rupees: String(line.unit_cost_paise / 100), unit: line.unit })));
  }, [order]);
  const receive = useMutation({
    mutationFn: () => api.post(`/purchases/orders/${order.id}/receive`, {
      business_date: date, lines: lines.map((line) => ({ ...line, received_quantity: Number(line.received_quantity), unit_price_rupees: Number(line.unit_price_rupees) })),
      finalize: true, idempotency_key: `receipt-${order.id}-${date}`,
    }),
    onSuccess: onSaved,
  });
  if (!order) return null;
  const change = (index: number, field: string, value: string) => setLines((old) => old.map((line, i) => i === index ? { ...line, [field]: value } : line));
  const valid = lines.length === order.lines.length && lines.every((line) => line.received_quantity !== "" && Number(line.received_quantity) >= 0 && line.unit_price_rupees !== "" && Number(line.unit_price_rupees) >= 0);
  return (
    <Sheet open onClose={onClose} title={`Receive PO #${order.id}`} wide>
      <div className="space-y-4">
        <p className="text-sm text-ink-faint">Enter what arrived. Short quantities and price differences are shown against the approved order. Finalizing posts the expenses and stock once; it cannot be edited.</p>
        <Field label="Receipt date"><Input type="date" max={todayISO()} value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <div className="space-y-2">
          {order.lines.map((planned: any, index: number) => {
            const line = lines[index] ?? {};
            return <div key={planned.id} className="border-b border-rule pb-3 last:border-0">
              <div className="mb-2 flex flex-wrap justify-between gap-x-3 text-sm"><strong>{planned.item_name}</strong><span className="text-ink-faint">Ordered {planned.quantity} {planned.unit} · planned {inr(planned.unit_cost_paise)}/{planned.unit}</span></div>
              <div className="grid grid-cols-2 gap-3">
                <Field label={`Received (${planned.unit})`}><Input inputMode="decimal" value={line.received_quantity ?? ""} onChange={(e) => change(index, "received_quantity", e.target.value)} /></Field>
                <Field label={`Actual ₹/${planned.unit}`}><Input inputMode="decimal" value={line.unit_price_rupees ?? ""} onChange={(e) => change(index, "unit_price_rupees", e.target.value)} /></Field>
              </div>
            </div>;
          })}
        </div>
        <ErrorNote msg={receive.error?.message ?? ""} />
        <Button className="w-full" disabled={!valid || receive.isPending} onClick={() => receive.mutate()}>{receive.isPending ? "Finalizing…" : "Finalize receipt — post books & stock"}</Button>
      </div>
    </Sheet>
  );
}
