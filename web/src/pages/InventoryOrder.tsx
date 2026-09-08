import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useOutletContext } from "react-router-dom";
import { useState } from "react";
import { api } from "../api/client";
import { useAuth } from "../lib/auth";
import { addDaysISO, todayISO } from "../lib/format";
import { Badge, Button, Card, EmptyState, ErrorNote, Field, Input, Select, Spinner } from "../components/ui";

type IntelligenceRow = {
  stock_item_id: number; item: string; base_unit: string; current_qty: number;
  min_qty: number; par_qty: number; expected_consumption_qty: number | null;
  velocity_per_day: number | null; days_of_cover: number | null;
  reorder_recommendation_qty: number | null; reorder_eligible: boolean;
  risk: string | null; confidence: string; caveats: string[];
  coverage: Record<string, { status?: string; observed?: number; required?: number }>;
  last_purchase_unit_cost_rupees: number | null;
};

const riskTone = (risk: string | null) =>
  risk === "at_or_below_minimum" || risk === "stockout_risk" ? "bad"
    : risk === "below_par" ? "warn" : "neutral";

const riskLabel = (risk: string | null) => ({
  at_or_below_minimum: "At minimum", stockout_risk: "≤3 days cover",
  below_par: "Below par", no_reorder_needed: "At target",
}[risk ?? ""] ?? "Withheld");

export default function InventoryOrder() {
  const { outletId } = useOutletContext<{ outletId: number }>();
  const { me } = useAuth();
  const navigate = useNavigate();
  const [start, setStart] = useState(() => addDaysISO(todayISO(), -29));
  const [end, setEnd] = useState(todayISO);
  const [selected, setSelected] = useState<number[]>([]);
  const [vendorId, setVendorId] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [paymentMode, setPaymentMode] = useState("credit");
  const q = useQuery({
    queryKey: ["inventory-intelligence", outletId, start, end],
    queryFn: () => api.get(`/inventory/intelligence?outlet_id=${outletId}&start=${start}&end=${end}`),
  });
  const vendors = useQuery({
    queryKey: ["vendors"], queryFn: () => api.get("/vendors"),
    enabled: me?.role === "owner",
  });
  const categories = useQuery({
    queryKey: ["categories"], queryFn: () => api.get("/lists/categories"),
    enabled: me?.role === "owner",
  });
  const rows: IntelligenceRow[] = q.data?.items ?? [];
  const recommendations = rows.filter((row) =>
    row.reorder_eligible && (row.reorder_recommendation_qty ?? 0) > 0);
  const coaching = rows.filter((row) => !row.reorder_eligible);
  const createDraft = useMutation({
    mutationFn: () => api.post("/purchases/orders/from-inventory-intelligence", {
      outlet_id: outletId, vendor_id: Number(vendorId), category_id: Number(categoryId),
      payment_mode: paymentMode, stock_item_ids: selected, start, end,
      note: `Inventory evidence window ${start} to ${end}`,
    }),
    onSuccess: () => navigate("/money/purchase-orders"),
  });

  const toggle = (id: number) => setSelected((old) =>
    old.includes(id) ? old.filter((selectedId) => selectedId !== id) : [...old, id]);
  const canCreate = me?.role === "owner" && selected.length > 0 && vendorId && categoryId;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Evidence-backed reorder</h1>
          <p className="mt-1 max-w-2xl text-sm text-ink-faint">
            Confirmed recipes estimate planned consumption only. They never change stock; receiving a finalized purchase does.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Field label="From"><Input type="date" max={end} value={start}
            onChange={(event) => setStart(event.target.value)} /></Field>
          <Field label="To"><Input type="date" min={start} max={todayISO()} value={end}
            onChange={(event) => setEnd(event.target.value)} /></Field>
        </div>
      </header>

      {q.isLoading && <Spinner label="Checking recorded inventory evidence…" />}
      {q.isError && <ErrorNote msg={(q.error as Error).message} />}
      {!q.isLoading && !q.isError && (
        <>
          <Card className="overflow-hidden">
            <div className="border-b border-rule px-4 py-3">
              <h2 className="font-semibold">Confirmed recommendations</h2>
              <p className="mt-0.5 text-sm text-ink-faint">
                These have confirmed recipes plus sufficient sales, purchase, and frozen count evidence.
              </p>
            </div>
            {recommendations.length === 0 ? (
              <EmptyState title="No supported reorder recommendation"
                hint="This is not a healthy-stock result. Complete the evidence shown below before relying on a reorder quantity." />
            ) : (
              <div className="divide-y divide-rule">
                {recommendations.map((row) => (
                  <RecommendationRow key={row.stock_item_id} row={row}
                    checked={selected.includes(row.stock_item_id)}
                    onToggle={() => toggle(row.stock_item_id)} />
                ))}
              </div>
            )}
          </Card>

          {recommendations.length > 0 && me?.role === "owner" && (
            <Card className="p-4">
              <h2 className="font-semibold">Create selected purchase draft</h2>
              <p className="mt-1 text-sm text-ink-faint">
                The draft carries the selected quantities and any last recorded unit price for review. It is not approved, received, or posted.
              </p>
              <div className="mt-4 grid gap-3 sm:grid-cols-3">
                <Field label="Supplier"><Select value={vendorId} onChange={(event) => setVendorId(event.target.value)}>
                  <option value="">Choose supplier</option>
                  {(vendors.data ?? []).filter((vendor: any) => vendor.is_active).map((vendor: any) =>
                    <option key={vendor.id} value={vendor.id}>{vendor.name}</option>)}
                </Select></Field>
                <Field label="Expense category"><Select value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>
                  <option value="">Choose category</option>
                  {(categories.data ?? []).map((category: any) =>
                    <option key={category.id} value={category.id}>{category.name}</option>)}
                </Select></Field>
                <Field label="Payment when received"><Select value={paymentMode} onChange={(event) => setPaymentMode(event.target.value)}>
                  <option value="credit">Credit — supplier due</option><option value="upi">UPI</option>
                  <option value="cash">Cash</option><option value="card">Card</option>
                  <option value="bank">Bank transfer</option><option value="other">Other</option>
                </Select></Field>
              </div>
              <ErrorNote msg={createDraft.error?.message ?? ""} />
              <Button className="mt-4 w-full sm:w-auto" disabled={!canCreate || createDraft.isPending}
                onClick={() => createDraft.mutate()}>
                {createDraft.isPending ? "Creating draft…" : `Create draft for ${selected.length} item${selected.length === 1 ? "" : "s"}`}
              </Button>
            </Card>
          )}
          {recommendations.length > 0 && me?.role !== "owner" && (
            <Card className="p-4 text-sm text-ink-faint">
              An owner can select these evidence-backed quantities and create a purchase draft.
            </Card>
          )}

          <Card className="overflow-hidden">
            <div className="border-b border-rule px-4 py-3">
              <h2 className="font-semibold">Incomplete-data coaching</h2>
              <p className="mt-0.5 text-sm text-ink-faint">
                These quantities are deliberately withheld—not treated as zero consumption or safe stock.
              </p>
            </div>
            {coaching.length === 0 ? (
              <p className="px-4 py-5 text-sm text-good">All tracked items have enough evidence for a reorder decision.</p>
            ) : (
              <div className="divide-y divide-rule">
                {coaching.map((row) => <CoachingRow key={row.stock_item_id} row={row} />)}
              </div>
            )}
          </Card>
          <p className="text-xs text-ink-faint">
            Need to improve recipe evidence? <Link className="font-medium text-accent underline underline-offset-2" to="/inventory/links">Review confirmed recipes</Link>.
            {" "}Frozen count variances are available under <Link className="font-medium text-accent underline underline-offset-2" to="/inventory/counts">Counts</Link>.
          </p>
        </>
      )}
    </div>
  );
}

function RecommendationRow({ row, checked, onToggle }: {
  row: IntelligenceRow; checked: boolean; onToggle: () => void;
}) {
  return (
    <label className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 text-sm hover:bg-paper-3/50">
      <input aria-label={`Select ${row.item} for draft`} type="checkbox" checked={checked}
        onChange={onToggle} className="h-4 w-4 accent-accent" />
      <span className="min-w-32 flex-1 font-medium">{row.item}</span>
      <span className="num text-xs text-ink-faint">have {row.current_qty} · par {row.par_qty} {row.base_unit}</span>
      {row.days_of_cover !== null && <Badge tone={riskTone(row.risk) as any}>{row.days_of_cover}d cover</Badge>}
      <Badge tone={riskTone(row.risk) as any}>{riskLabel(row.risk)}</Badge>
      <span className="num w-28 text-right text-base font-semibold">
        {row.reorder_recommendation_qty} {row.base_unit}
      </span>
      <details className="w-full text-xs text-ink-faint">
        <summary className="mt-1 cursor-pointer font-medium text-ink-soft">Evidence and caveats</summary>
        <p className="mt-1">Expected recipe consumption: {row.expected_consumption_qty} {row.base_unit} · velocity: {row.velocity_per_day} {row.base_unit}/day.</p>
        <p className="mt-1">Last recorded unit price: {row.last_purchase_unit_cost_rupees == null ? "not recorded" : `₹${row.last_purchase_unit_cost_rupees}`}.</p>
        <ul className="mt-1 list-disc pl-5">{row.caveats.map((caveat) => <li key={caveat}>{caveat}</li>)}</ul>
      </details>
    </label>
  );
}

function CoachingRow({ row }: { row: IntelligenceRow }) {
  const missing = Object.entries(row.coverage)
    .filter(([, value]) => value && typeof value === "object" && value.status === "insufficient")
    .map(([key]) => key.replace(/^\w/, (letter) => letter.toUpperCase()));
  return (
    <div className="px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <strong className="min-w-32 flex-1">{row.item}</strong>
        <span className="num text-xs text-ink-faint">have {row.current_qty} {row.base_unit}</span>
        <Badge tone="neutral">Recommendation withheld</Badge>
      </div>
      <p className="mt-1 text-ink-faint">
        {missing.length ? `Needs: ${missing.join(", ")} evidence.` : "Needs a supported consumption forecast and a par level."}
      </p>
      <details className="mt-1 text-xs text-ink-faint">
        <summary className="cursor-pointer font-medium text-ink-soft">Why this is withheld</summary>
        <ul className="mt-1 list-disc pl-5">{row.caveats.map((caveat) => <li key={caveat}>{caveat}</li>)}</ul>
      </details>
    </div>
  );
}
