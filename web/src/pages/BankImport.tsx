import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { Landmark, CheckCircle2, Trash2 } from "lucide-react";
import { api } from "../api/client";
import { useGuarded } from "../lib/auth";
import { addDaysISO, fmtDateShort, inr, todayISO } from "../lib/format";
import {
  Badge, Button, Card, ErrorNote, Input, SectionLabel, Select, Spinner,
} from "../components/ui";

type Payee = {
  match_key: string; label: string; channel: string; mode: string;
  count: number; new_count: number; total_paise: number; total_rupees: number;
  date_from: string; date_to: string;
  category_id: number | null; vendor_id: number | null;
  skip: boolean; known: boolean;
};

type Decision = {
  category_id: number | null; vendor_id: number | null; vendor_name: string;
  mode: string; skip: boolean; remember: boolean;
};

const MODES = ["upi", "bank", "card", "cash", "credit", "other"];

const CHANNEL_HINT: Record<string, string> = {
  atm: "Cash withdrawal — this moves money to your drawer, it is not spend",
  charge: "Bank's own fees",
  upi: "UPI payment",
  card: "Card / POS payment",
  bank: "NEFT / IMPS / auto-debit",
  other: "",
};

export default function BankImport() {
  const { outletId } = useOutletContext<{ outletId: number }>();
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const guarded = useGuarded();

  const [preview, setPreview] = useState<any>(null);
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [err, setErr] = useState("");
  const [done, setDone] = useState<any>(null);

  const cats = useQuery({ queryKey: ["categories"], queryFn: () => api.get("/lists/categories") });
  const vendors = useQuery({ queryKey: ["vendors"], queryFn: () => api.get("/vendors") });
  const rules = useQuery({ queryKey: ["bank-rules"], queryFn: () => api.get("/bank/rules") });
  const recon = useQuery({
    queryKey: ["cash-reconciliation", outletId],
    queryFn: () => api.get(`/bank/cash-reconciliation?outlet_id=${outletId}&start=${addDaysISO(todayISO(), -90)}&end=${todayISO()}`),
  });

  // Seed the form from what the server already knows about each payee.
  useEffect(() => {
    if (!preview) return;
    const seeded: Record<string, Decision> = {};
    for (const p of preview.payees as Payee[]) {
      seeded[p.match_key] = {
        category_id: p.category_id, vendor_id: p.vendor_id, vendor_name: "",
        mode: p.mode, skip: p.skip, remember: true,
      };
    }
    setDecisions(seeded);
  }, [preview]);

  const upload = useMutation({
    mutationFn: async (f: File) => {
      const fd = new FormData();
      fd.append("file", f);
      return api.post(`/bank/upload?outlet_id=${outletId}`, fd);
    },
    onSuccess: (r) => { setErr(""); setDone(null); setPreview(r); },
    onError: (e: any) => setErr(e.message),
  });

  const commit = useMutation({
    mutationFn: () => guarded(() => api.post(`/bank/${preview.batch_id}/commit`, {
      decisions: (preview.payees as Payee[]).map((p) => ({
        match_key: p.match_key, ...decisions[p.match_key],
      })),
    })),
    onSuccess: (r) => {
      setDone(r);
      setPreview(null);
      if (fileRef.current) fileRef.current.value = "";
      qc.invalidateQueries({ queryKey: ["expenses"] });
      qc.invalidateQueries({ queryKey: ["vendors"] });
      qc.invalidateQueries({ queryKey: ["bank-rules"] });
      qc.invalidateQueries({ queryKey: ["home"] });
      qc.invalidateQueries({ queryKey: ["cash-reconciliation"] });
    },
    onError: (e: any) => setErr(e.message),
  });

  const discard = useMutation({
    mutationFn: () => api.del(`/bank/${preview.batch_id}`),
    onSuccess: () => { setPreview(null); if (fileRef.current) fileRef.current.value = ""; },
    onError: (e: any) => setErr(e.message),
  });

  const set = (key: string, patch: Partial<Decision>) =>
    setDecisions((d) => ({ ...d, [key]: { ...d[key], ...patch } }));

  const ready = useMemo(() => {
    if (!preview) return { count: 0, total: 0, unmapped: 0 };
    const bookable = new Set<string>();
    let unmapped = 0;
    for (const p of preview.payees as Payee[]) {
      const d = decisions[p.match_key];
      if (!d || d.skip) continue;
      if (d.category_id == null) { unmapped += 1; continue; }
      bookable.add(p.match_key);
    }
    // Sum the actual rows, not an average - this number is shown as money.
    let count = 0, total = 0;
    for (const t of preview.transactions as any[]) {
      if (t.already_imported || !bookable.has(t.match_key)) continue;
      count += 1;
      total += t.amount_paise;
    }
    return { count, total, unmapped };
  }, [preview, decisions]);

  return (
    <div className="space-y-5">
      <header>
        <SectionLabel>Money · Bank statement</SectionLabel>
        <h1 className="text-2xl font-semibold tracking-tight">Import from your bank</h1>
        <p className="mt-1 max-w-2xl text-sm text-ink-faint">
          Download the account statement from net banking and drop it here.
          Ledger groups money that went <b>out</b> by who you paid and asks you
          to name each one only the first time. Statement credits are retained
          separately so cash deposits can be reconciled; they never become sales.
        </p>
      </header>

      {done && (
        <Card className="space-y-1 p-5">
          <h2 className="font-semibold">
            <CheckCircle2 className="mr-1 inline text-good" size={16} /> Imported
          </h2>
          <p className="text-sm text-ink-soft">
            {done.created} expense{done.created === 1 ? "" : "s"} added
            {done.duplicates ? ` · ${done.duplicates} were already in Ledger` : ""}
            {done.skipped ? ` · ${done.skipped} skipped` : ""}
            {done.rules_saved ? ` · ${done.rules_saved} payee${done.rules_saved === 1 ? "" : "s"} remembered` : ""}.
          </p>
        </Card>
      )}

      {!preview && (
        <Card
          className="flex cursor-pointer flex-col items-center justify-center gap-2 border-dashed py-12 hover:bg-paper-3/40"
          onDragOver={(e: any) => e.preventDefault()}
          onDrop={(e: any) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) upload.mutate(f); }}
          onClick={() => fileRef.current?.click()}>
          <input ref={fileRef} type="file" hidden accept=".csv,.xls,.xlsx,.txt"
                 onChange={(e) => { const f = e.target.files?.[0]; if (f) upload.mutate(f); }} />
          <Landmark size={28} className="text-accent" />
          <div className="font-medium">Drop your statement here</div>
          <div className="text-sm text-ink-faint">
            or tap to choose — CSV, Excel (.xlsx) or .xls
          </div>
          <div className="text-xs text-ink-faint">
            Account details at the top of the file are ignored automatically.
          </div>
          {upload.isPending && <Spinner label="Reading the statement…" />}
          <ErrorNote msg={err} />
        </Card>
      )}

      {preview && (
        <Card className="space-y-4 p-5">
          <div className="grid grid-cols-2 gap-3 text-center sm:grid-cols-4">
            <Box label="Payments out" value={String(preview.debits)} />
            <Box label="New to Ledger" value={String(preview.new_rows)} tone="good" />
            <Box label="Already imported" value={String(preview.already_imported)}
                 hint={preview.already_imported ? "won't be added twice" : undefined} />
            <Box label="Money in retained" value={String(preview.credits ?? 0)}
                 hint="for cash-deposit matching" />
          </div>
          <p className="text-xs text-ink-faint">
            {preview.filename} · {fmtDateShort(preview.date_from)} → {fmtDateShort(preview.date_to)}
            {preview.unreadable_rows ? ` · ${preview.unreadable_rows} rows skipped (headers, totals)` : ""}
          </p>

          <SectionLabel>Who you paid</SectionLabel>
          <div className="space-y-2">
            {(preview.payees as Payee[]).map((p) => {
              const d = decisions[p.match_key];
              if (!d) return null;
              const needs = !d.skip && d.category_id == null;
              return (
                <div key={p.match_key}
                     className={`rounded-md border px-3 py-2.5 ${needs ? "border-accent/60 bg-accent/5" : "border-rule bg-paper-2"}`}>
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <span className="font-medium">{p.label || p.match_key}</span>
                    {p.known && <Badge tone="good">remembered</Badge>}
                    {p.channel !== "other" && <Badge>{p.channel}</Badge>}
                    <span className="num ml-auto font-semibold">{inr(p.total_paise)}</span>
                  </div>
                  <div className="mt-0.5 text-[11px] text-ink-faint">
                    {p.count} payment{p.count === 1 ? "" : "s"}
                    {p.new_count !== p.count ? ` (${p.new_count} new)` : ""} ·
                    {" "}{fmtDateShort(p.date_from)} → {fmtDateShort(p.date_to)}
                    {CHANNEL_HINT[p.channel] ? ` · ${CHANNEL_HINT[p.channel]}` : ""}
                  </div>

                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <label className="flex items-center gap-1.5 text-xs text-ink-soft">
                      <input type="checkbox" checked={d.skip}
                             onChange={(e) => set(p.match_key, { skip: e.target.checked })} />
                      Not an expense
                    </label>

                    {!d.skip && (
                      <>
                        <Select className="min-w-[10rem]" value={d.category_id ?? ""}
                                aria-label={`Category for ${p.label}`}
                                onChange={(e) => set(p.match_key, {
                                  category_id: e.target.value ? Number(e.target.value) : null,
                                })}>
                          <option value="">Choose category…</option>
                          {(cats.data ?? []).map((c: any) => (
                            <option key={c.id} value={c.id}>{c.name}</option>
                          ))}
                        </Select>

                        <Select className="min-w-[9rem]" value={d.vendor_id ?? (d.vendor_name ? "new" : "")}
                                aria-label={`Vendor for ${p.label}`}
                                onChange={(e) => {
                                  const v = e.target.value;
                                  if (v === "new") set(p.match_key, { vendor_id: null, vendor_name: p.label });
                                  else set(p.match_key, { vendor_id: v ? Number(v) : null, vendor_name: "" });
                                }}>
                          <option value="">No vendor</option>
                          <option value="new">＋ Add "{p.label}"</option>
                          {(vendors.data ?? []).map((v: any) => (
                            <option key={v.id} value={v.id}>{v.name}</option>
                          ))}
                        </Select>

                        {d.vendor_name && (
                          <Input className="w-40" value={d.vendor_name}
                                 aria-label="New vendor name"
                                 onChange={(e) => set(p.match_key, { vendor_name: e.target.value })} />
                        )}

                        <Select className="w-24" value={d.mode}
                                aria-label={`Payment mode for ${p.label}`}
                                onChange={(e) => set(p.match_key, { mode: e.target.value })}>
                          {MODES.map((m) => <option key={m} value={m}>{m}</option>)}
                        </Select>
                      </>
                    )}

                    <label className="ml-auto flex items-center gap-1.5 text-xs text-ink-soft">
                      <input type="checkbox" checked={d.remember}
                             onChange={(e) => set(p.match_key, { remember: e.target.checked })} />
                      Remember
                    </label>
                  </div>
                </div>
              );
            })}
          </div>

          {ready.unmapped > 0 && (
            <p className="text-xs text-accent">
              {ready.unmapped} payee{ready.unmapped === 1 ? "" : "s"} still need a category.
              They will be left out until you choose one.
            </p>
          )}
          <ErrorNote msg={err} />
          <div className="flex items-center justify-end gap-2 pt-1">
            <Button variant="ghost"
                    onClick={() => confirm(
                      "Discard this statement? The rows you have classified here will be thrown away.",
                    ) && discard.mutate()}
                    disabled={discard.isPending}>Discard</Button>
            <Button onClick={() => commit.mutate()}
                    disabled={commit.isPending || ready.count === 0}>
              {commit.isPending ? "Adding…"
                : `Add ${ready.count} expense${ready.count === 1 ? "" : "s"} · ${inr(ready.total)}`}
            </Button>
          </div>
        </Card>
      )}

      <Card>
        <div className="border-b border-rule px-4 py-2.5">
          <SectionLabel>Remembered payees</SectionLabel>
        </div>
        <div className="divide-y divide-rule">
          {(rules.data ?? []).map((r: any) => (
            <RuleRow key={r.id} rule={r} cats={cats.data ?? []} vendors={vendors.data ?? []} />
          ))}
          {(rules.data ?? []).length === 0 && (
            <div className="px-4 py-6 text-center text-sm text-ink-faint">
              Nothing remembered yet. Classify a payee once and it will be
              filled in automatically next month.
            </div>
          )}
        </div>
      </Card>

      {!preview && (
        <CashDepositReconciliation outletId={outletId} data={recon.data}
                                   loading={recon.isLoading} />
      )}
    </div>
  );
}

function CashDepositReconciliation({ outletId, data, loading }: {
  outletId: number; data: any; loading: boolean;
}) {
  const guarded = useGuarded();
  const qc = useQueryClient();
  const match = useMutation({
    mutationFn: ({ closure, credit }: { closure: any; credit: any }) =>
      guarded(() => api.post("/bank/cash-reconciliation/matches", {
        closure_id: closure.id, bank_credit_id: credit.id,
        amount_rupees: Math.min(closure.remaining_paise, credit.remaining_paise) / 100,
      })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["cash-reconciliation", outletId] }),
  });
  const closures = (data?.closures ?? []).filter((row: any) => row.remaining_paise > 0);
  const credits = (data?.credits ?? []).filter((row: any) => row.remaining_paise > 0);
  if (loading) return null;
  return (
    <Card className="overflow-hidden">
      <div className="border-b border-rule px-4 py-3">
        <h2 className="font-semibold">Cash deposits to reconcile</h2>
        <p className="mt-0.5 text-sm text-ink-faint">
          Match cash removed from a closed drawer to a bank statement credit. Ledger never confirms a match on its own.
        </p>
      </div>
      {closures.length === 0 ? (
        <p className="px-4 py-5 text-sm text-good">All recent cash removals are reconciled.</p>
      ) : (
        <div className="divide-y divide-rule">
          {closures.map((closure: any) => {
            const suggested = credits.find((credit: any) => credit.id === closure.suggested_credit_id);
            return (
              <div key={closure.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
                <span className="w-20 text-ink-soft">{fmtDateShort(closure.date)}</span>
                <span className="num font-medium">{inr(closure.remaining_paise)}</span>
                {suggested ? (
                  <>
                    <span className="min-w-0 flex-1 truncate text-ink-faint">
                      Suggested bank credit {fmtDateShort(suggested.date)} · {suggested.narration || suggested.reference || "no narration"}
                    </span>
                    <Button size="sm" variant="outline" disabled={match.isPending}
                            onClick={() => match.mutate({ closure, credit: suggested })}>
                      Confirm match
                    </Button>
                  </>
                ) : (
                  <span className="text-ink-faint">No exact recent bank credit found.</span>
                )}
              </div>
            );
          })}
        </div>
      )}
      <ErrorNote msg={match.error?.message ?? ""} />
    </Card>
  );
}

function RuleRow({ rule, cats, vendors }: { rule: any; cats: any[]; vendors: any[] }) {
  const qc = useQueryClient();
  const [err, setErr] = useState("");
  const remove = useMutation({
    mutationFn: () => api.del(`/bank/rules/${rule.id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["bank-rules"] }),
    onError: (e: any) => setErr(e.message),
  });
  const cat = cats.find((c) => c.id === rule.category_id);
  const vendor = vendors.find((v) => v.id === rule.vendor_id);
  return (
    <div className="flex items-center gap-3 px-4 py-2.5 text-sm">
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{rule.label || rule.match_key}</span>
        <span className="block truncate text-[11px] text-ink-faint">{rule.match_key}</span>
      </span>
      {rule.skip
        ? <Badge>not an expense</Badge>
        : <>
            <Badge tone="good">{cat?.name ?? "no category"}</Badge>
            {vendor && <span className="hidden text-xs text-ink-faint sm:inline">{vendor.name}</span>}
          </>}
      <span className="num w-16 text-right text-xs text-ink-faint">{rule.hits}×</span>
      {err && <span className="text-xs text-bad">{err}</span>}
      <button className="text-ink-faint hover:text-bad disabled:opacity-40"
              disabled={remove.isPending}
              aria-label={`Forget ${rule.label || rule.match_key}`}
              onClick={() => {
                if (confirm(`Forget "${rule.label || rule.match_key}"? Future statements will ask you to classify it again.`))
                  remove.mutate();
              }}>
        <Trash2 size={15} />
      </button>
    </div>
  );
}

function Box({ label, value, tone, hint }: {
  label: string; value: string; tone?: string; hint?: string;
}) {
  return (
    <div className="rounded-md border border-rule bg-paper-2 px-3 py-2.5">
      <div className={`num text-2xl font-semibold ${tone === "good" ? "text-good" : ""}`}>
        {value}
      </div>
      <div className="text-[11px] uppercase tracking-wide text-ink-faint">{label}</div>
      {hint && <div className="mt-0.5 text-[11px] text-ink-faint">{hint}</div>}
    </div>
  );
}
