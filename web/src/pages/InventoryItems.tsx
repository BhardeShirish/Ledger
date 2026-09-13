import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useOutletContext } from "react-router-dom";
import { useMemo, useState } from "react";
import { Pencil } from "lucide-react";
import { api } from "../api/client";
import { useAuth, useGuarded } from "../lib/auth";
import { inr } from "../lib/format";
import { useDirtyDraft } from "../lib/useDirtyDraft";
import {
  Badge, Button, Card, EmptyState, ErrorNote, Field, Input, SectionLabel, Sheet, Spinner,
} from "../components/ui";

const BLANK_ITEM = {
  name: "", base_unit: "kg", par_qty: "", min_qty: "", yield_percent: "100", opening_qty: "",
};

export default function InventoryItems() {
  const { outletId } = useOutletContext<{ outletId: number }>();
  const { me } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["inv-items", outletId],
    queryFn: () => api.get(`/inventory/items?outlet_id=${outletId}`),
  });
  const [editing, setEditing] = useState<any>(null);
  const [adding, setAdding] = useState(false);

  if (q.isLoading) return <Spinner />;
  const rows = q.data ?? [];

  return (
    <div className="space-y-4">
      {me?.role === "owner" && rows.length > 0 && (
        <Button size="sm" onClick={() => setAdding(true)}>+ Add stock item</Button>
      )}
      {rows.length === 0 ? (
        <Card className="overflow-hidden">
          <EmptyState
            title="No stock items yet"
            hint={me?.role === "owner"
              ? "Stock items are the ingredients you count, price and reorder. Add the first one to start a stock ledger."
              : "Stock items are the ingredients you count, price and reorder. An owner adds them before anything appears here."}
            action={me?.role === "owner"
              ? <Button className="mt-2" onClick={() => setAdding(true)}>Add stock item</Button>
              : undefined}
          />
        </Card>
      ) : (
      <Card className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-rule text-left text-xs text-ink-faint">
              <th className="px-3 py-2 font-medium">Item</th>
              <th className="px-2 py-2 text-right font-medium">Stock</th>
              <th className="px-2 py-2 text-right font-medium">Min</th>
              <th className="px-2 py-2 text-right font-medium">Par</th>
              <th className="px-2 py-2 text-right font-medium">Yield</th>
              <th className="px-2 py-2 text-right font-medium">Last price</th>
              <th className="px-2 py-2 text-right font-medium">Value</th>
              {me?.role === "owner" && <th />}
            </tr>
          </thead>
          <tbody>
            {rows.map((r: any) => (
              <tr key={r.id} className="border-b border-rule/50 last:border-0">
                <td className="px-3 py-2 font-medium">{r.name}
                  <span className="ml-1 text-xs text-ink-faint">{r.base_unit}</span></td>
                <td className="num px-2 py-2 text-right">{r.current_qty}</td>
                <td className="num px-2 py-2 text-right text-ink-faint">{r.min_qty || "—"}</td>
                <td className="num px-2 py-2 text-right text-ink-faint">{r.par_qty || "—"}</td>
                <td className="num px-2 py-2 text-right text-ink-faint">{r.yield_percent}%</td>
                <td className="num px-2 py-2 text-right">{inr(Math.round(r.last_unit_price_rupees * 100))}</td>
                <td className="num px-2 py-2 text-right">{inr(Math.round(r.value_rupees * 100))}</td>
                {me?.role === "owner" && (
                  <td className="px-2 py-2 text-right">
                    <button type="button" aria-label={`Edit ${r.name}`} onClick={() => setEditing(r)}
                            className="p-1 text-ink-faint hover:text-accent"><Pencil size={14} /></button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      )}

      <EditItem key={editing?.id ?? "none"} item={editing} onClose={() => setEditing(null)} outletId={outletId}
                onDone={() => { setEditing(null); qc.invalidateQueries({ queryKey: ["inv-items"] }); }} />
      <AddItem open={adding} onClose={() => setAdding(false)} outletId={outletId}
               onDone={() => { setAdding(false); qc.invalidateQueries({ queryKey: ["inv-items"] }); }} />
    </div>
  );
}

function EditItem({ item, onClose, outletId, onDone }: any) {
  const guarded = useGuarded();
  const saved = useMemo(() => ({
    name: item?.name ?? "", base_unit: item?.base_unit ?? "kg",
    par_qty: String(item?.par_qty ?? ""), min_qty: String(item?.min_qty ?? ""),
    yield_percent: String(item?.yield_percent ?? 100),
  }), [item]);
  const [f, setF] = useState(() => saved);
  const set = (k: string) => (e: any) => setF((x: any) => ({ ...x, [k]: e.target.value }));
  const save = useMutation({
    mutationFn: () => guarded(() => api.patch(`/inventory/items/${item.id}`, {
      name: f.name, base_unit: f.base_unit,
      par_qty: Number(f.par_qty) || 0, min_qty: Number(f.min_qty) || 0,
      yield_percent: Number(f.yield_percent) || 100,
    })),
    onSuccess: onDone,
  });
  const draft = useDirtyDraft({
    open: Boolean(item), label: `edit of ${item?.name ?? "this stock item"}`,
    values: f, pristine: saved,
    discard: () => { setF(saved); onClose(); },
  });
  if (!item) return null;
  return (
    <Sheet open onClose={draft.close} title={`Edit ${item.name}`}>
      <div className="space-y-3">
        <Field label="Name"><Input value={f.name} onChange={set("name")} /></Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Unit"><Input value={f.base_unit} onChange={set("base_unit")} /></Field>
          <Field label="Reorder at"><Input inputMode="decimal" value={f.min_qty} onChange={set("min_qty")} className="text-right" /></Field>
          <Field label="Par (order to)"><Input inputMode="decimal" value={f.par_qty} onChange={set("par_qty")} className="text-right" /></Field>
        </div>
        <Field label="Yield %" hint="10kg onion → 8.5kg usable = 85%">
          <Input inputMode="decimal" value={f.yield_percent} onChange={set("yield_percent")} className="text-right" />
        </Field>
        <Button className="w-full" disabled={save.isPending} onClick={() => save.mutate()}>Save</Button>
      </div>
    </Sheet>
  );
}

function AddItem({ open, onClose, outletId, onDone }: any) {
  const guarded = useGuarded();
  const [f, setF] = useState(BLANK_ITEM);
  const [err, setErr] = useState("");
  const set = (k: string) => (e: any) => setF((x: any) => ({ ...x, [k]: e.target.value }));
  const save = useMutation({
    mutationFn: () => guarded(() => api.post(`/inventory/items?outlet_id=${outletId}`, {
      name: f.name, base_unit: f.base_unit,
      par_qty: Number(f.par_qty) || 0, min_qty: Number(f.min_qty) || 0,
      yield_percent: Number(f.yield_percent) || 100,
      opening_qty: Number(f.opening_qty) || undefined,
    })),
    onSuccess: () => { setF(BLANK_ITEM); setErr(""); onDone(); },
    onError: (e: any) => setErr(e.message),
  });
  const draft = useDirtyDraft({
    open, label: "new stock item",
    values: f, pristine: BLANK_ITEM,
    discard: () => { setF(BLANK_ITEM); setErr(""); onClose(); },
  });
  return (
    <Sheet open={open} onClose={draft.close} title="Add stock item">
      <div className="space-y-3">
        <Field label="Name"><Input autoFocus value={f.name} onChange={set("name")} /></Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Unit"><Input value={f.base_unit} onChange={set("base_unit")} /></Field>
          <Field label="Reorder at"><Input inputMode="decimal" value={f.min_qty} onChange={set("min_qty")} className="text-right" /></Field>
          <Field label="Par"><Input inputMode="decimal" value={f.par_qty} onChange={set("par_qty")} className="text-right" /></Field>
        </div>
        <Field label="Opening stock (optional)">
          <Input inputMode="decimal" value={f.opening_qty} onChange={set("opening_qty")} className="text-right" />
        </Field>
        <ErrorNote msg={err} />
        <Button className="w-full" disabled={!f.name.trim() || save.isPending} onClick={() => save.mutate()}>
          Create item
        </Button>
      </div>
    </Sheet>
  );
}
