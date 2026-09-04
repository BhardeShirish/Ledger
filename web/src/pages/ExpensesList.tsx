import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useOutletContext } from "react-router-dom";
import { useEffect, useMemo, useRef, useState } from "react";
import { Camera, ScanText, Pencil, Plus, Trash2, X } from "lucide-react";
import { api } from "../api/client";
import { moneyCfg } from "../lib/format";
import { ExportButton, ImportButtons } from "../components/DataButtons";
import { useGuarded } from "../lib/auth";
import { fmtDateShort, inr, monthLabelShort, todayISO } from "../lib/format";
import {
  Badge, Button, Card, EmptyState, ErrorNote, Field, Input, SectionLabel,
  Select, Sheet, Spinner,
} from "../components/ui";
import { EmptyMonthHint } from "../components/EmptyMonthHint";

type Ctx = { outletId: number };

export default function ExpensesList() {
  const { outletId } = useOutletContext<Ctx>();
  const qc = useQueryClient();
  const guarded = useGuarded();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<any | null>(null);
  const [monthOffset, setMonthOffset] = useState(0);

  const period = useMemo(() => {
    const d = new Date();
    // Anchor to the 1st first: on the 31st, stepping back a month from a
    // 31-day month lands in the *next* month (Feb 31 -> Mar 3).
    d.setDate(1);
    d.setMonth(d.getMonth() + monthOffset);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  }, [monthOffset]);

  const cats = useQuery({ queryKey: ["categories"], queryFn: () => api.get("/lists/categories") });
  const vendors = useQuery({ queryKey: ["vendors"], queryFn: () => api.get("/vendors") });
  const list = useQuery({
    queryKey: ["expenses", outletId, period],
    queryFn: () => api.get(`/expenses?outlet_id=${outletId}&start=${period}-01&end=${period}-31`),
  });

  const create = useMutation({
    mutationFn: (body: any) => guarded(() => api.post("/expenses", body)),
    onSuccess: () => {
      setOpen(false);
      qc.invalidateQueries({ queryKey: ["expenses"] });
      qc.invalidateQueries({ queryKey: ["home"] });
      qc.invalidateQueries({ queryKey: ["vendors"] });
    },
  });

  const createBulk = useMutation({
    mutationFn: (body: any) => guarded(() => api.post("/expenses/bulk", body)),
    onSuccess: () => {
      setOpen(false);
      qc.invalidateQueries({ queryKey: ["expenses"] });
      qc.invalidateQueries({ queryKey: ["home"] });
      qc.invalidateQueries({ queryKey: ["vendors"] });
      qc.invalidateQueries({ queryKey: ["unit-econ"] });
    },
  });

  const totalPaise = (list.data?.rows ?? []).reduce((s: number, r: any) => s + r.amount_paise, 0);

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <SectionLabel>Money · Expenses</SectionLabel>
          <h1 className="text-2xl font-semibold tracking-tight">
            {inr(totalPaise)}{" "}
            <span className="text-sm font-normal text-ink-faint">
              {monthOffset === 0 ? "this month" : `in ${monthLabelShort(period)}`}
            </span>
          </h1>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" aria-label="Previous month"
                  onClick={() => setMonthOffset(monthOffset - 1)}>‹</Button>
          <span className="min-w-[5.5rem] px-1 py-1.5 text-center text-sm font-medium text-ink-soft">{monthLabelShort(period)}</span>
          <Button variant="outline" size="sm" disabled={monthOffset >= 0}
                  aria-label="Next month"
                  onClick={() => setMonthOffset(monthOffset + 1)}>›</Button>
        </div>
      </header>

      <div className="flex flex-wrap gap-2">
        <Button onClick={() => setOpen(true)} size="lg" className="flex-1 md:flex-none">
          <Plus size={16} /> Add expense
        </Button>
        <ExportButton entity="expenses" params={{ outlet_id: outletId, start: `${period}-01`, end: `${period}-31` }} />
        <ImportButtons entity="expenses" outletId={outletId}
                       onDone={() => {
                         qc.invalidateQueries({ queryKey: ["expenses"] });
                         qc.invalidateQueries({ queryKey: ["home"] });
                         qc.invalidateQueries({ queryKey: ["vendors"] });
                       }} />
      </div>

      {(list.data?.rows ?? []).length === 0 && !list.isLoading && (
        <EmptyMonthHint
          month={period}
          outletId={outletId}
          what="logged"
          onJump={(target) => {
            const now = new Date();
            const [ty, tm] = target.split("-").map(Number);
            setMonthOffset((ty! - now.getFullYear()) * 12 + (tm! - (now.getMonth() + 1)));
          }}
        />
      )}

      <Card className="divide-y divide-rule">
        {(list.data?.rows ?? []).length === 0 && !list.isLoading && (
          <EmptyState title={`No expenses in ${monthLabelShort(period)}`}
                      hint="Gas cylinder, vegetables, repairs — log them as they happen." />
        )}
        {(list.data?.rows ?? []).map((e: any) => (
          <ExpenseRow key={e.id} e={e} cats={cats.data ?? []}
                      onEdit={() => setEditing(e)} />
        ))}
      </Card>

      <EditExpenseSheet
        expense={editing}
        cats={cats.data ?? []}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          qc.invalidateQueries({ queryKey: ["expenses"] });
          qc.invalidateQueries({ queryKey: ["home"] });
          qc.invalidateQueries({ queryKey: ["unit-econ"] });
        }}
      />

      <AddExpenseSheet
        open={open} onClose={() => setOpen(false)}
        outletId={outletId}
        cats={cats.data ?? []}
        vendors={vendors.data ?? []}
        busy={create.isPending || createBulk.isPending}
        err={create.error?.message ?? createBulk.error?.message ?? ""}
        onSubmit={(body) => create.mutate(body)}
        onSubmitBulk={(body) => createBulk.mutate(body)}
      />
    </div>
  );
}

function ExpenseRow({ e, cats, onEdit }: { e: any; cats: any[]; onEdit: () => void }) {
  const catName = cats.find((c) => c.id === e.category_id)?.name ?? "?";
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <button onClick={onEdit}
              aria-label={`Edit ${e.description || catName}`}
              className="flex min-w-0 flex-1 items-center gap-3 text-left">
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{e.description || catName}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-ink-faint">
            <span>{fmtDateShort(e.business_date)}</span>·<span>{catName}</span>
            {e.mode === "cash" && <Badge tone="warn">cash</Badge>}
            {e.mode !== "cash" && <Badge>{e.mode}</Badge>}
          </div>
        </div>
        <div className="num font-medium">{inr(e.amount_paise)}</div>
        <Pencil size={14} className="shrink-0 text-ink-faint" />
      </button>
      {e.receipt_path && (
        <a href={e.receipt_path} target="_blank" rel="noreferrer" title="View receipt">
          <Camera size={15} className="text-ink-faint hover:text-accent" />
        </a>
      )}
    </div>
  );
}

function EditExpenseSheet({ expense, cats, onClose, onSaved }: {
  expense: any | null; cats: any[]; onClose: () => void; onSaved: () => void;
}) {
  const guarded = useGuarded();
  const [date, setDate] = useState("");
  const [amount, setAmount] = useState("");
  const [catId, setCatId] = useState<number | null>(null);
  const [mode, setMode] = useState("upi");
  const [desc, setDesc] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // Load the row being corrected, not whatever the last one left behind.
  useEffect(() => {
    if (!expense) return;
    setDate(expense.business_date);
    setAmount(String(expense.amount_rupees ?? expense.amount_paise / 100));
    setCatId(expense.category_id);
    setMode(expense.mode);
    setDesc(expense.description ?? "");
    setConfirmingDelete(false);
  }, [expense]);

  const save = useMutation({
    mutationFn: (body: any) =>
      guarded(() => api.patch(`/expenses/${expense.id}`, body)),
    onSuccess: onSaved,
  });

  const remove = useMutation({
    mutationFn: () => guarded(() => api.del(`/expenses/${expense.id}`)),
    onSuccess: onSaved,
  });

  if (!expense) return null;

  return (
    <Sheet open onClose={onClose} title="Edit expense">
      <div className="space-y-3.5">
        <Field label="Amount">
          <Input inputMode="decimal" autoFocus value={amount}
                 onChange={(e) => setAmount(e.target.value)}
                 className="text-right text-xl" />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Paid by">
            <Select value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="upi">UPI</option>
              <option value="cash">Cash</option>
              <option value="card">Card</option>
              <option value="bank">Bank transfer</option>
              <option value="other">Other</option>
            </Select>
          </Field>
          <Field label="Date">
            <Input type="date" value={date} max={todayISO()}
                   onChange={(e) => setDate(e.target.value)} />
          </Field>
        </div>

        <Field label="Category">
          <Select value={catId ?? ""}
                  onChange={(e) => setCatId(Number(e.target.value))}>
            {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>

        <Field label="Note">
          <Input value={desc} placeholder="What was this for?"
                 onChange={(e) => setDesc(e.target.value)} />
        </Field>

        {expense.quantity > 0 && (
          <p className="text-xs text-ink-faint">
            {expense.quantity} {expense.unit || "unit"} of {expense.item_name}.
            Changing the amount re-prices this purchase in stock too.
          </p>
        )}

        {(save.error || remove.error) && (
          <ErrorNote msg={((save.error ?? remove.error) as Error).message} />
        )}

        <div className="flex gap-2">
          <Button variant="outline" className="flex-1" onClick={onClose}>Cancel</Button>
          <Button className="flex-1" disabled={save.isPending || !amount || !catId}
                  onClick={() => save.mutate({
                    business_date: date, amount_rupees: Number(amount),
                    category_id: catId, mode, description: desc,
                  })}>
            {save.isPending ? <Spinner /> : "Save changes"}
          </Button>
        </div>

        {/* Deleting is the one action that cannot be undone, so it asks twice
            and never sits under the thumb that just tapped "Save". */}
        <div className="border-t border-rule pt-3">
          {!confirmingDelete ? (
            <button onClick={() => setConfirmingDelete(true)}
                    className="inline-flex items-center gap-1.5 text-sm text-ink-faint hover:text-bad">
              <Trash2 size={14} /> Delete this expense
            </button>
          ) : (
            <div className="space-y-2">
              <p className="text-sm text-ink-soft">
                Delete {inr(Math.round(Number(amount) * 100))} permanently?
                {expense.quantity > 0 &&
                  " The stock it added will come back off the shelf too."}
              </p>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" className="flex-1"
                        onClick={() => setConfirmingDelete(false)}>Keep it</Button>
                <Button variant="danger" size="sm" className="flex-1"
                        disabled={remove.isPending}
                        onClick={() => remove.mutate()}>
                  {remove.isPending ? <Spinner /> : "Yes, delete"}
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </Sheet>
  );
}

export function AddExpenseSheet(props: {
  open: boolean; onClose: () => void; outletId: number;
  cats: any[]; vendors: any[]; busy: boolean; err: string;
  onSubmit: (body: any) => void;
  onSubmitBulk?: (body: any) => void;
}) {
  const [date, setDate] = useState(todayISO());
  const [amount, setAmount] = useState("");
  const [catId, setCatId] = useState<number | null>(null);
  const [mode, setMode] = useState("upi");
  const [desc, setDesc] = useState("");
  const [vendorQ, setVendorQ] = useState("");
  const [vendorId, setVendorId] = useState<number | null>(null);
  const [newCatOpen, setNewCatOpen] = useState(false);
  const [newCatName, setNewCatName] = useState("");
  const [newCatErr, setNewCatErr] = useState("");
  const [savingCat, setSavingCat] = useState(false);
  const [itemName, setItemName] = useState("");
  const [quantity, setQuantity] = useState("");
  const [unit, setUnit] = useState("");
  const [multi, setMulti] = useState(false);
  const [lines, setLines] = useState<{ item: string; qty: string; unit: string;
                                       amount: string }[]>([]);
  const [billTotal, setBillTotal] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const [receiptPath, setReceiptPath] = useState<string | null>(null);
  const qc = useQueryClient();
  const [uploading, setUploading] = useState(false);
  const [catFilter, setCatFilter] = useState("");
  const [ocrState, setOcrState] = useState<{ configured: boolean; reading: boolean;
                                             note: string }>(
    { configured: false, reading: false, note: "" });

  useEffect(() => {
    if (props.open) {
      api.get("/ocr/status").then((s) =>
        setOcrState((x) => ({ ...x, configured: !!s.configured }))).catch(() => {});
    }
  }, [props.open]);
  useEffect(() => {
    if (!props.open) {
      setAmount(""); setCatId(null); setMode("upi"); setDesc("");
      setVendorQ(""); setVendorId(null); setReceiptPath(null);
      setItemName(""); setQuantity(""); setUnit("");
      setMulti(false); setLines([]); setBillTotal("");
    }
  }, [props.open]);

  const readBill = async () => {
    if (!receiptPath) return;
    setOcrState((x) => ({ ...x, reading: true, note: "" }));
    try {
      // receiptPath is /api/files/<name>; fetch the bytes we already stored
      const res = await fetch(receiptPath, { credentials: "include" });
      const blob = await res.blob();
      const dot = receiptPath.lastIndexOf(".");
      const fd = new FormData();
      fd.append("file", blob, `bill${dot >= 0 ? receiptPath.slice(dot) : ".jpg"}`);
      const r = await api.post("/ocr/extract", fd);
      setAmount(String(r.total_rupees ?? ""));
      if (r.vendor_name) setVendorQ(r.vendor_name);
      if (!r.date_is_today_default && r.bill_date) setDate(r.bill_date);

      const ocrItems = (r.items ?? []).filter((i: any) => i.name);
      if (ocrItems.length > 0) {
        setMulti(true);
        setLines(ocrItems.map((i: any) => ({
          item: i.name,
          qty: i.qty != null ? String(i.qty) : "",
          unit: "kg",
          amount: i.amount != null ? String(i.amount) : "",
        })));
        setBillTotal(r.total_rupees != null ? String(r.total_rupees) : "");
      }

      const itemLine = ocrItems.slice(0, 4).map((i: any) => i.name).join(", ");
      setDesc(r.raw_summary || itemLine || "read from bill");
      setOcrState((x) => ({ ...x,
        note: `${r.confidence}-confidence read — check lines before saving` }));
    } catch (e: any) {
      setOcrState((x) => ({ ...x, note: e.message || "couldn't read the bill" }));
    } finally {
      setOcrState((x) => ({ ...x, reading: false }));
    }
  };

  if (!props.open) return null;

  const matches = props.vendors.filter((v) =>
    v.is_active && v.name.toLowerCase().includes(vendorQ.trim().toLowerCase()));
  const showAddVendor = vendorQ.trim().length > 0 &&
    !props.vendors.some((v) => v.name.toLowerCase() === vendorQ.trim().toLowerCase());

  const cleanLines = lines
    .map((l) => ({ ...l }))
    .filter((l) => l.item.trim() && Number(l.amount) > 0);

  const submit = () => {
    if (!catId) return;
    if (multi) {
      if (!cleanLines.length) return;
      const anyQty = cleanLines.some((l) => Number(l.qty) > 0);
      if (anyQty && !vendorId) return;             // server enforces too
      props.onSubmitBulk?.({
        outlet_id: props.outletId, business_date: date,
        category_id: catId, vendor_id: vendorId, mode,
        receipt_path: receiptPath,
        note: desc,
        bill_total_rupees: billTotal ? Number(billTotal) : undefined,
        lines: cleanLines.map((l) => ({
          item_name: l.item, quantity: Number(l.qty) || null,
          unit: l.unit, amount_rupees: Number(l.amount),
        })),
      });
      return;
    }
    if (!amount) return;
    if (Number(quantity) > 0 && !vendorId) return;   // server enforces too
    props.onSubmit({
      outlet_id: props.outletId, business_date: date,
      category_id: catId, vendor_id: vendorId,
      amount_rupees: Number(amount), mode,
      description: desc, receipt_path: receiptPath,
      item_name: itemName, quantity: Number(quantity) || undefined,
      unit: unit,
    });
  };

  const quickAddVendor = async () => {
    const r = await api.post("/vendors", { name: vendorQ.trim() });
    await qc.invalidateQueries({ queryKey: ["vendors"] });
    setVendorId(r.id);
    setVendorQ(r.name);
  };

  const quickAddCat = async () => {
    const name = newCatName.trim();
    if (!name || savingCat) return;
    setSavingCat(true);
    setNewCatErr("");
    try {
      const r = await api.post("/lists/categories", { name });
      await qc.invalidateQueries({ queryKey: ["categories"] });
      setCatId(r.id);
      setNewCatName("");
      setNewCatOpen(false);
    } catch (e: any) {
      setNewCatErr(e?.message || "Could not add that category.");
    } finally {
      setSavingCat(false);
    }
  };


  return (
    <Sheet open={props.open} onClose={props.onClose} title="Add expense">
      <div className="space-y-3.5">
        <div className="flex items-center justify-between gap-2">
          <Field label="Amount">
            {!multi ? (
              <Input inputMode="decimal" autoFocus placeholder="₹ 0" value={amount}
                     onChange={(e) => setAmount(e.target.value)}
                     className="text-right text-xl" />
            ) : (
              <div className="num rounded-md border border-rule bg-paper-2 px-3 py-2 text-right text-xl font-semibold">
                {moneyCfg.symbol}{lines.reduce((s, l) => s + (Number(l.amount) || 0), 0).toFixed(2)}
              </div>
            )}
          </Field>
          <button
            onClick={() => { setMulti(!multi);
              if (!multi && !lines.length) setLines([{ item: "", qty: "", unit: "kg", amount: "" }]);
              if (!multi) setAmount(""); }}
            className={`mt-6 shrink-0 rounded-full border px-3 py-1.5 text-xs font-semibold ${
              multi ? "border-accent bg-accent-soft text-accent"
                    : "border-rule-strong text-ink-soft hover:bg-paper-3"}`}>
            {multi ? "← single amount" : "Multiple items from a bill"}
          </button>
        </div>

        {multi && (
          <div className="rounded-md border border-rule p-2.5">
            <div className="mb-1.5 flex items-center justify-between">
              <span className="label-caps">Item lines</span>
              <button onClick={() => setLines((x) => [...x,
                      { item: "", qty: "", unit: "kg", amount: "" }])}
                      className="text-xs font-semibold text-accent hover:underline">
                ＋ add line
              </button>
            </div>
            <div className="space-y-1.5">
              {lines.map((l, i) => (
                <div key={i} className="grid grid-cols-[1fr_58px_54px_78px_22px] items-center gap-1.5">
                  <Input placeholder="Item" value={l.item}
                         onChange={(e) => setLines((x) => x.map((y, j) =>
                           j === i ? { ...y, item: e.target.value } : y))}
                         className="!py-1.5 text-sm" />
                  <Input inputMode="decimal" placeholder="qty" value={l.qty}
                         onChange={(e) => setLines((x) => x.map((y, j) =>
                           j === i ? { ...y, qty: e.target.value } : y))}
                         className="!py-1.5 text-right num text-sm" />
                  <Input placeholder="kg" value={l.unit}
                         onChange={(e) => setLines((x) => x.map((y, j) =>
                           j === i ? { ...y, unit: e.target.value } : y))}
                         className="!py-1.5 text-sm" />
                  <Input inputMode="decimal" placeholder="₹" value={l.amount}
                         onChange={(e) => setLines((x) => x.map((y, j) =>
                           j === i ? { ...y, amount: e.target.value } : y))}
                         className="!py-1.5 text-right num text-sm" />
                  <button onClick={() => setLines((x) => x.filter((_, j) => j !== i))}
                          className="p-1 text-ink-faint hover:text-bad"><X size={13} /></button>
                </div>
              ))}
            </div>
            <div className="mt-2 flex items-center gap-2 border-t border-rule pt-2">
              <span className="text-xs text-ink-faint">Printed bill total (optional — difference booked as other charges)</span>
              <Input inputMode="decimal" placeholder="₹ bill total" value={billTotal}
                     onChange={(e) => setBillTotal(e.target.value)} className="ml-auto !w-32 !py-1.5 text-right num text-sm" />
            </div>
          </div>
        )}

        <Field label="Category">
          <div className="flex flex-wrap gap-1.5">
            {(props.cats.length > 10) && (
              <Input placeholder="Filter categories…" value={catFilter}
                     onChange={(e) => setCatFilter(e.target.value)} className="!py-1.5 mb-1 text-sm" />
            )}
            {props.cats.filter((c) => c.is_active)
              .filter((c) => !catFilter || c.name.toLowerCase().includes(catFilter.toLowerCase()))
              .map((c) => (
              <button key={c.id} onClick={() => setCatId(c.id)}
                className={`rounded-full border px-3 py-1.5 text-sm ${
                  catId === c.id ? "border-accent bg-accent-soft font-semibold text-accent"
                                 : "border-rule-strong hover:bg-paper-3"}`}>
                {c.name}
              </button>
            ))}
            <button onClick={() => setNewCatOpen(true)}
                    className="rounded-full border border-dashed border-rule-strong px-3 py-1.5 text-sm text-ink-faint hover:bg-paper-3">
              + New category
            </button>
          </div>
          {newCatOpen && (
            <div className="mt-2">
              <div className="flex gap-2">
                <Input autoFocus value={newCatName} placeholder="Category name"
                       onChange={(e) => setNewCatName(e.target.value)}
                       onKeyDown={(e) => {
                         if (e.key === "Enter") { e.preventDefault(); void quickAddCat(); }
                         if (e.key === "Escape") { setNewCatOpen(false); setNewCatErr(""); }
                       }} />
                <Button size="sm" disabled={!newCatName.trim() || savingCat}
                        onClick={() => void quickAddCat()}>
                  {savingCat ? <Spinner /> : "Add"}
                </Button>
                <Button size="sm" variant="ghost" aria-label="Cancel new category"
                        onClick={() => { setNewCatOpen(false); setNewCatErr(""); }}>
                  <X size={14} />
                </Button>
              </div>
              <ErrorNote msg={newCatErr} />
            </div>
          )}
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Paid by">
            <Select value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="upi">UPI</option>
              <option value="cash">Cash</option>
              <option value="card">Card</option>
              <option value="bank">Bank transfer</option>
              <option value="other">Other</option>
            </Select>
          </Field>
          <Field label="Date">
            <Input type="date" value={date} max={todayISO()}
                   onChange={(e) => setDate(e.target.value)} />
          </Field>
        </div>

        <Field label="Vendor (optional)">
          <Input placeholder="Search or type a new name…" value={vendorQ}
                 onChange={(e) => { setVendorQ(e.target.value); setVendorId(null); }} />
          {vendorQ && (
            <div className="mt-1 rounded-md border border-rule bg-paper shadow-sm">
              {matches.slice(0, 5).map((v) => (
                <button key={v.id} onClick={() => { setVendorId(v.id); setVendorQ(v.name); }}
                        className="block w-full px-3 py-2 text-left text-sm hover:bg-paper-3">
                  {v.name}{v.balance_rupees ? ` · owes ₹${Math.abs(v.balance_rupees)}` : ""}
                </button>
              ))}
              {showAddVendor && (
                <button onClick={quickAddVendor}
                        className="block w-full border-t border-rule px-3 py-2 text-left text-sm font-medium text-accent hover:bg-accent-soft">
                  ＋ Add "{vendorQ.trim()}" as a new vendor
                </button>
              )}
            </div>
          )}
        </Field>

        <Field label="Note (optional)">
          <Input value={desc} placeholder="What was this for?"
                 onChange={(e) => setDesc(e.target.value)} />
        </Field>

        {/* Unit economics — raw materials bought by weight/volume */}
        <div className="rounded-md border border-rule bg-paper-2 px-3 py-2.5">
          <div className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.12em] text-ink-faint">
            Bought by weight/quantity? (optional)
          </div>
          <div className="grid grid-cols-3 gap-2">
            <Input placeholder="Item (Rice…)" value={itemName}
                   onChange={(e) => setItemName(e.target.value)} />
            <Input inputMode="decimal" placeholder="Qty" value={quantity}
                   onChange={(e) => setQuantity(e.target.value)} className="text-right" />
            <Input placeholder="kg / L / pcs" value={unit}
                   onChange={(e) => setUnit(e.target.value)} />
          </div>
          {Number(quantity) > 0 && Number(amount) > 0 && (
            <p className="num mt-1 text-xs text-good">
              {moneyCfg.symbol}{(Number(amount) / Number(quantity)).toFixed(2)} per {unit || "unit"}
              {!vendorId && <span className="text-bad"> · pick a vendor to track prices</span>}
            </p>
          )}
        </div>

        <div className="flex items-center gap-3">
          <input ref={fileRef} type="file" accept="image/*,.pdf" hidden
                 onChange={async (e) => {
                   const f = e.target.files?.[0];
                   if (!f) return;
                   setUploading(true);
                   try {
                     const fd = new FormData();
                     fd.append("file", f);
                     const r = await api.post("/uploads", fd);
                     setReceiptPath(r.path);
                     void readBill();          // auto-read right after attach
                   } finally {
                     setUploading(false);
                   }
                 }} />
          <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
            <Camera size={14} /> Receipt photo
          </Button>
          {ocrState.configured && (
            <Button variant="ghost" size="sm" disabled={!receiptPath || ocrState.reading}
                    onClick={() => readBill()} title="Read vendor/date/total from the photo">
              <ScanText size={14} /> {ocrState.reading ? "Reading…" : "Auto-read bill"}
            </Button>
          )}
          {uploading && <span className="text-xs text-ink-faint">Uploading…</span>}
          {receiptPath && <a href={receiptPath} target="_blank" className="text-xs text-good">attached ✓</a>}
        </div>
        {ocrState.note && (
          <p className={`text-xs ${ocrState.note.includes("confidence") || ocrState.note.includes("✓") ? "text-good" : "text-bad"}`}>
            {ocrState.note}
          </p>
        )}

        <ErrorNote msg={props.err} />
        <Button size="lg" className="w-full"
                disabled={!catId || props.busy ||
                          (multi ? !cleanLines.length : !amount)}
                onClick={submit}>
          {props.busy ? "Saving…" : multi
            ? `Save bill · ${lines.reduce((s, l) => s + (Number(l.amount) || 0), 0).toFixed(2)}`
            : "Save expense"}
        </Button>
      </div>
    </Sheet>
  );
}


