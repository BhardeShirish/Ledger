import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { Landmark, CheckCircle2, FileUp, Trash2 } from "lucide-react";
import { api } from "../api/client";
import { useGuarded } from "../lib/auth";
import { addDaysISO, fmtDateShort, inr, todayISO } from "../lib/format";
import {
  Badge, Button, Card, ConfirmSheet, ErrorNote, Field, Input, SectionLabel, Select, Sheet, Spinner,
} from "../components/ui";

type Payee = {
  match_key: string; label: string; channel: string; mode: string;
  count: number; new_count: number; total_paise: number; total_rupees: number;
  date_from: string; date_to: string;
  category_id: number | null; vendor_id: number | null;
  skip: boolean; known: boolean;
  possible_duplicate_count: number;
  possible_duplicates: PotentialDuplicate[];
  previous_count: number;
  previous_matches: HistoricalMatch[];
  suggested_category_id: number | null;
  suggested_vendor_id: number | null;
  suggested_mode: string | null;
  suggested_from_count: number;
  detected_modes: string[];
};

type PotentialDuplicate = {
  id: number; business_date: string; amount_paise: number; description: string;
};

type HistoricalMatch = PotentialDuplicate & {
  category_id: number; vendor_id: number | null; mode: string;
};

type StatementTransaction = {
  hash: string; match_key: string; amount_paise: number; date: string;
  mode: string; already_imported: boolean; possible_duplicates: PotentialDuplicate[];
};

type Decision = {
  category_id: number | null; vendor_id: number | null; vendor_name: string;
  mode: string; skip: boolean; remember: boolean;
  include_possible_duplicates: boolean; include_possible_duplicate_hashes: string[];
  use_detected_mode: boolean;
  update_previous: boolean;
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

type ReviewState = "ready" | "recommended" | "needs-review" | "possible-duplicate";

function reviewState(payee: Payee, decision: Decision): ReviewState {
  if (!decision.skip && decision.category_id == null) return "needs-review";
  if (!decision.skip && payee.possible_duplicate_count > 0) return "possible-duplicate";
  if (!payee.known && !decision.skip
      && payee.suggested_category_id === decision.category_id) return "recommended";
  return "ready";
}

export default function BankImport() {
  const { outletId } = useOutletContext<{ outletId: number }>();
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const guarded = useGuarded();

  const [preview, setPreview] = useState<any>(null);
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [activePayee, setActivePayee] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState<any>(null);
  const accountStorageKey = `ledger_phonepe_account_${outletId}`;
  const [phonePeAccountEnding, setPhonePeAccountEnding] = useState(
    () => localStorage.getItem(accountStorageKey) ?? "",
  );
  const [statementSource, setStatementSource] = useState<"auto" | "bank" | "phonepe">("auto");

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
        category_id: p.category_id ?? p.suggested_category_id,
        vendor_id: p.vendor_id ?? p.suggested_vendor_id, vendor_name: "",
        mode: p.mode,
        skip: p.skip, remember: true, include_possible_duplicates: false,
        include_possible_duplicate_hashes: [],
        use_detected_mode: true,
        update_previous: false,
      };
    }
    setDecisions(seeded);
    setActivePayee(null);
  }, [preview]);

  const upload = useMutation({
    mutationFn: async (f: File) => {
      const fd = new FormData();
      fd.append("file", f);
      const query = new URLSearchParams({ outlet_id: String(outletId) });
      query.set("statement_source", statementSource);
      if (phonePeAccountEnding.trim()) query.set("account_ending", phonePeAccountEnding.trim());
      return api.post(`/bank/upload?${query}`, fd);
    },
    onSuccess: (r) => {
      if (r.source === "phonepe" && r.account_ending) {
        localStorage.setItem(accountStorageKey, r.account_ending);
        setPhonePeAccountEnding(r.account_ending);
      }
      setErr(""); setDone(null); setPreview(r);
    },
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
    onSuccess: () => {
      setConfirmDiscard(false);
      setPreview(null);
      if (fileRef.current) fileRef.current.value = "";
    },
    onError: (e: any) => setErr(e.message),
  });

  const set = (key: string, patch: Partial<Decision>) =>
    setDecisions((d) => ({ ...d, [key]: { ...d[key], ...patch } }));
  const togglePossibleDuplicate = (key: string, hash: string, checked: boolean) => {
    setDecisions((decisions) => {
      const decision = decisions[key];
      if (!decision) return decisions;
      const selected = decision.include_possible_duplicate_hashes;
      return {
        ...decisions,
        [key]: {
          ...decision,
          include_possible_duplicate_hashes: checked
            ? [...selected, hash]
            : selected.filter((value) => value !== hash),
        },
      };
    });
  };
  const setPossibleDuplicates = (key: string, selected: boolean) => {
    const hashes = ((preview?.transactions ?? []) as StatementTransaction[])
      .filter((txn) => txn.match_key === key && !txn.already_imported
        && txn.possible_duplicates.length > 0)
      .map((txn) => txn.hash);
    set(key, { include_possible_duplicate_hashes: selected ? hashes : [] });
  };

  const ready = useMemo(() => {
    if (!preview) return { count: 0, total: 0, unmapped: 0, updates: 0 };
    const bookable = new Set<string>();
    let unmapped = 0, updates = 0;
    for (const p of preview.payees as Payee[]) {
      const d = decisions[p.match_key];
      if (!d || d.skip) continue;
      if (d.category_id == null) { unmapped += 1; continue; }
      bookable.add(p.match_key);
      if (d.update_previous) updates += p.previous_count;
    }
    // Sum the actual rows, not an average - this number is shown as money.
    let count = 0, total = 0;
    for (const t of preview.transactions as StatementTransaction[]) {
      const d = decisions[t.match_key];
      if (t.already_imported || !bookable.has(t.match_key)
          || (t.possible_duplicates?.length
              && !d?.include_possible_duplicates
              && !d?.include_possible_duplicate_hashes.includes(t.hash))) continue;
      count += 1;
      total += t.amount_paise;
    }
    return { count, total, unmapped, updates };
  }, [preview, decisions]);
  const payees = (preview?.payees ?? []) as Payee[];
  const reviewQueue = payees.filter((payee) => {
    const decision = decisions[payee.match_key];
    return decision && reviewState(payee, decision) !== "ready";
  });
  const active = payees.find((payee) => payee.match_key === activePayee) ?? null;
  const activeQueueIndex = active ? reviewQueue.findIndex((payee) => payee.match_key === active.match_key) : -1;

  return (
    <div className="space-y-5">
      <header>
        <SectionLabel>Money · Bank statement</SectionLabel>
        <h1 className="text-2xl font-semibold tracking-tight">Import from your bank</h1>
        <p className="mt-1 max-w-2xl text-sm text-ink-faint">
          Download the account statement from net banking and drop it here.
          Ledger also reads PhonePe exports. It groups money that went <b>out</b>{" "}
          by who you paid, remembers your decisions, and never adds an overlapping
          UTR twice. Statement credits are retained separately for cash-deposit
          matching; they never become sales.
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
            {done.updated_previous
              ? ` · ${done.updated_previous} earlier payment${done.updated_previous === 1 ? "" : "s"} updated`
              : ""}
            {done.rules_saved ? ` · ${done.rules_saved} payee${done.rules_saved === 1 ? "" : "s"} remembered` : ""}.
          </p>
        </Card>
      )}

      {!preview && (
        <Card
          className="flex cursor-pointer flex-col items-center justify-center gap-2 border-dashed py-12 hover:bg-paper-3/40"
          onDragOver={(e: any) => e.preventDefault()}
          onDrop={(e: any) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) upload.mutate(f); }}
          onClick={(e) => {
            if (e.target !== fileRef.current
                && !(e.target as HTMLElement).closest("[data-upload-control]")) {
              fileRef.current?.click();
            }
          }}>
          <input ref={fileRef} type="file" hidden accept=".csv,.xls,.xlsx,.txt"
                 onChange={(e) => { const f = e.target.files?.[0]; if (f) upload.mutate(f); }} />
          <Landmark size={28} className="text-accent" />
          <div className="font-medium">Drop your statement here</div>
          <div className="text-sm text-ink-faint">
            or choose a file — CSV, Excel (.xlsx) or .xls
          </div>
          <Button type="button" data-upload-control variant="outline"
                  disabled={upload.isPending}
                  onClick={(e) => { e.stopPropagation(); fileRef.current?.click(); }}>
            <FileUp size={15} /> Choose statement file
          </Button>
          <div className="text-xs text-ink-faint">
            Account details at the top of the file are ignored automatically.
          </div>
          <div data-upload-control className="mt-2 w-full max-w-xs text-left text-xs font-medium text-ink-soft">
            Statement type
            <Select className="mt-1 w-full" value={statementSource}
                    aria-label="Statement type"
                    onChange={(e) => setStatementSource(e.target.value as typeof statementSource)}>
              <option value="auto">Auto-detect (recommended)</option>
              <option value="bank">Bank statement</option>
              <option value="phonepe">PhonePe export</option>
            </Select>
          </div>
          <div data-upload-control className="mt-2 w-full max-w-xs text-left text-xs font-medium text-ink-soft">
            PhonePe only: business account last 4 digits
            <Input className="mt-1 w-full" inputMode="numeric" maxLength={4}
                   aria-label="PhonePe business account last 4 digits"
                   placeholder="For example, 1270"
                   value={phonePeAccountEnding}
                   onChange={(e) => setPhonePeAccountEnding(e.target.value.replace(/\D/g, ""))} />
          </div>
          <div className="max-w-xs text-xs text-ink-faint">
            Required only if the export contains more than one account. Ledger remembers it on this device.
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
            {preview.source === "phonepe" && preview.account_ending
              ? ` · PhonePe account ending ${preview.account_ending}` : ""}
            {preview.unreadable_rows ? ` · ${preview.unreadable_rows} rows skipped (headers, totals)` : ""}
          </p>

          <div>
            <div className="mb-2 flex items-baseline justify-between gap-2">
              <SectionLabel>Who you paid</SectionLabel>
              <span className="text-xs text-ink-faint">
                {reviewQueue.length ? `${reviewQueue.length} to check` : "all ready"}
              </span>
            </div>
            <div className="space-y-1.5">
              {payees.map((payee) => {
                const decision = decisions[payee.match_key];
                if (!decision) return null;
                const state = reviewState(payee, decision);
                const badge = state === "ready" ? "ready"
                  : state === "recommended" ? "recommended"
                    : state === "possible-duplicate" ? "check duplicate" : "needs category";
                const tone = state === "ready" ? "good"
                  : state === "needs-review" ? "bad" : "warn";
                return (
                  <div key={payee.match_key} className="flex items-center gap-3 rounded-md border border-rule px-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{payee.label || payee.match_key}</span>
                      <span className="mt-1 flex items-center gap-1.5">
                        <Badge tone={tone}>{badge}</Badge>
                        {payee.channel !== "other" && <span className="text-xs text-ink-faint">{payee.channel}</span>}
                      </span>
                    </div>
                    <span className="num text-sm font-semibold">{inr(payee.total_paise)}</span>
                    <Button size="sm" variant="outline" onClick={() => setActivePayee(payee.match_key)}>
                      {state === "ready" ? "Edit" : "Review"}
                    </Button>
                  </div>
                );
              })}
            </div>
          </div>
          <PayeeReviewSheet
            payee={active}
            decision={active ? decisions[active.match_key] ?? null : null}
            transactions={preview.transactions as StatementTransaction[]}
            categories={cats.data ?? []}
            vendors={vendors.data ?? []}
            hasPrevious={activeQueueIndex > 0}
            hasNext={activeQueueIndex >= 0 && activeQueueIndex < reviewQueue.length - 1}
            onClose={() => setActivePayee(null)}
            onPrevious={() => setActivePayee(reviewQueue[activeQueueIndex - 1]?.match_key ?? null)}
            onNext={() => setActivePayee(reviewQueue[activeQueueIndex + 1]?.match_key ?? null)}
            onDecision={(patch) => active && set(active.match_key, patch)}
            onPossibleDuplicate={(hash, checked) =>
              active && togglePossibleDuplicate(active.match_key, hash, checked)}
            onSetPossibleDuplicates={(selected) =>
              active && setPossibleDuplicates(active.match_key, selected)}
          />
          <ConfirmSheet
            open={confirmDiscard}
            onClose={() => setConfirmDiscard(false)}
            onConfirm={() => discard.mutate()}
            title="Cancel preview?"
            description="Cancel this preview? Nothing has been added. Your choices on this screen will be lost."
            confirmLabel="Cancel preview"
            pending={discard.isPending}
            pendingLabel="Cancelling…"
          />

          <ErrorNote msg={err} />
          <div className="sticky bottom-0 z-10 -mx-5 flex flex-col-reverse gap-3 border-t border-rule bg-paper px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs text-ink-faint">
              {ready.count === 0 && ready.updates === 0
                ? "No payments are ready yet. Review a red or amber merchant to choose how it should be handled."
                : ready.unmapped > 0
                  ? `${ready.unmapped} merchant${ready.unmapped === 1 ? "" : "s"} still need a decision and will be left out.`
                  : "Nothing is saved until you add these expenses."}
            </p>
            <div className="flex items-center justify-end gap-2">
            <Button variant="outline"
                    onClick={() => setConfirmDiscard(true)}
                    disabled={discard.isPending}>Cancel preview</Button>
            <Button onClick={() => commit.mutate()}
                    disabled={commit.isPending || (ready.count === 0 && ready.updates === 0)}>
              {commit.isPending ? "Adding…"
                : <>
                    {ready.count > 0 && `Add ${ready.count} expense${ready.count === 1 ? "" : "s"} · ${inr(ready.total)}`}
                    {ready.count > 0 && ready.updates > 0 && " · "}
                    {ready.updates > 0 && `Update ${ready.updates} earlier payment${ready.updates === 1 ? "" : "s"}`}
                    {ready.count === 0 && ready.updates === 0 && "Review merchants to continue"}
                  </>}
            </Button>
            </div>
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

function PayeeReviewSheet({ payee, decision, transactions, categories, vendors,
  hasPrevious, hasNext, onClose, onPrevious, onNext, onDecision, onPossibleDuplicate,
  onSetPossibleDuplicates }: {
  payee: Payee | null; decision: Decision | null;
  transactions: StatementTransaction[]; categories: any[]; vendors: any[];
  hasPrevious: boolean; hasNext: boolean; onClose: () => void;
  onPrevious: () => void; onNext: () => void;
  onDecision: (patch: Partial<Decision>) => void;
  onPossibleDuplicate: (hash: string, checked: boolean) => void;
  onSetPossibleDuplicates: (selected: boolean) => void;
}) {
  if (!payee || !decision) return null;
  const isNew = !payee.known && !decision.skip;
  const isSuggested = isNew && payee.suggested_category_id != null;
  const duplicatePayments = transactions.filter((txn) =>
    txn.match_key === payee.match_key && !txn.already_imported
    && txn.possible_duplicates.length > 0,
  );
  return (
    <Sheet open onClose={onClose} title={`Review ${payee.label || payee.match_key}`} side>
      <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">{payee.label || payee.match_key}</h2>
          <p className="mt-0.5 text-sm text-ink-soft">
            {payee.count} payment{payee.count === 1 ? "" : "s"} · {fmtDateShort(payee.date_from)} → {fmtDateShort(payee.date_to)}
          </p>
          <p className="num mt-1 text-xl font-semibold">{inr(payee.total_paise)}</p>
        </div>
        <div className="flex gap-1">
          <Button size="sm" variant="outline" disabled={!hasPrevious} onClick={onPrevious}>Previous</Button>
          <Button size="sm" variant="outline" disabled={!hasNext} onClick={onNext}>Next</Button>
        </div>
      </div>

      {isSuggested && (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          Recommended from {payee.suggested_from_count} matching earlier payment{payee.suggested_from_count === 1 ? "" : "s"}. It is selected below; change it if needed.
        </p>
      )}
      {isNew && !isSuggested && (
        <p className="rounded-md border border-bad/30 bg-bad/5 px-3 py-2 text-sm text-bad">
          This payee needs a category before it can be added.
        </p>
      )}
      {CHANNEL_HINT[payee.channel] && (
        <p className="text-xs text-ink-faint">{CHANNEL_HINT[payee.channel]}</p>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex items-center gap-2 text-sm text-ink-soft sm:col-span-2">
          <input type="checkbox" checked={decision.skip}
                 onChange={(e) => onDecision({ skip: e.target.checked })} />
          Not an expense
        </label>
        {!decision.skip && (
          <>
            <label className="block text-sm font-medium text-ink-soft">
              Category
              <Select className="mt-1" value={decision.category_id ?? ""}
                      aria-label={`Category for ${payee.label}`}
                      onChange={(e) => onDecision({
                        category_id: e.target.value ? Number(e.target.value) : null,
                      })}>
                <option value="">Choose category…</option>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>{category.name}</option>
                ))}
              </Select>
            </label>
            <label className="block text-sm font-medium text-ink-soft">
              Supplier
              <Select className="mt-1" value={decision.vendor_id ?? (decision.vendor_name ? "new" : "")}
                      aria-label={`Vendor for ${payee.label}`}
                      onChange={(e) => {
                        const value = e.target.value;
                        onDecision(value === "new"
                          ? { vendor_id: null, vendor_name: payee.label }
                          : { vendor_id: value ? Number(value) : null, vendor_name: "" });
                      }}>
                <option value="">No supplier</option>
                <option value="new">Add "{payee.label}"</option>
                {vendors.map((vendor) => (
                  <option key={vendor.id} value={vendor.id}>{vendor.name}</option>
                ))}
              </Select>
            </label>
            {decision.vendor_name && (
              <Field label="New supplier" className="sm:col-span-2">
                <Input value={decision.vendor_name}
                       onChange={(e) => onDecision({ vendor_name: e.target.value })} />
              </Field>
            )}
            <label className="block text-sm font-medium text-ink-soft">
              Payment method
              <Select className="mt-1" value={decision.use_detected_mode ? "detected" : decision.mode}
                      aria-label={`Payment method for ${payee.label}`}
                      onChange={(e) => onDecision(e.target.value === "detected"
                        ? { use_detected_mode: true }
                        : { use_detected_mode: false, mode: e.target.value })}>
                <option value="detected">
                  Detected: {(payee.detected_modes ?? [payee.mode]).join(" / ")}
                </option>
                {MODES.map((mode) => <option key={mode} value={mode}>{mode}</option>)}
              </Select>
              <span className="mt-1 block text-xs font-normal text-ink-faint">
                Detected keeps UPI, NEFT/RTGS, card, and cash transactions correctly recorded per payment.
              </span>
            </label>
          </>
        )}
        <label className="flex items-center gap-2 text-sm text-ink-soft sm:col-span-2">
          <input type="checkbox" checked={decision.remember}
                 onChange={(e) => onDecision({ remember: e.target.checked })} />
          Remember this category and supplier for this payee
        </label>
      </div>

      {duplicatePayments.length > 0 && !decision.skip && (
        <div className="space-y-2 border-y border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-900">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="font-medium">Possible duplicates</p>
              <p className="text-xs">Only selected payments are added.</p>
            </div>
            <div className="flex gap-1">
              <Button size="sm" variant="outline" onClick={() => onSetPossibleDuplicates(true)}>Select all</Button>
              <Button size="sm" variant="outline" onClick={() => onSetPossibleDuplicates(false)}>Deselect all</Button>
            </div>
          </div>
          {duplicatePayments.map((txn) => {
            const selected = decision.include_possible_duplicate_hashes.includes(txn.hash);
            return (
              <div key={txn.hash} className="border-t border-amber-200 pt-2 first:border-t-0 first:pt-0">
                <label className="flex cursor-pointer items-center gap-2">
                  <input type="checkbox" checked={selected}
                         onChange={(e) => onPossibleDuplicate(txn.hash, e.target.checked)} />
                  <span className="font-medium">Add {fmtDateShort(txn.date)} · {inr(txn.amount_paise)}</span>
                </label>
                <details className="ml-5 mt-1 text-xs text-amber-800">
                  <summary className="cursor-pointer hover:text-amber-950">
                    See {txn.possible_duplicates.length} existing match{txn.possible_duplicates.length === 1 ? "" : "es"}
                  </summary>
                  <p className="mt-1">
                    {txn.possible_duplicates
                      .map((row) => `${fmtDateShort(row.business_date)} · ${inr(row.amount_paise)} · ${row.description}`)
                      .join("; ")}
                  </p>
                </details>
              </div>
            );
          })}
        </div>
      )}

      {payee.previous_count > 0 && !decision.skip && decision.category_id != null && (
        <div className="bg-paper-2 px-3 py-2.5 text-sm text-ink-soft">
          <label className="flex cursor-pointer items-start gap-2">
            <input className="mt-0.5" type="checkbox" checked={decision.update_previous}
                   onChange={(e) => onDecision({ update_previous: e.target.checked })} />
            <span>
              Apply category and supplier to {payee.previous_count} earlier matching payment{payee.previous_count === 1 ? "" : "s"}.
              <span className="mt-0.5 block text-xs text-ink-faint">Date, amount, and detected payment method never change.</span>
            </span>
          </label>
          {payee.previous_matches.length > 0 && (
            <details className="mt-2 text-xs text-ink-faint">
              <summary className="cursor-pointer font-medium hover:text-ink">Review matched payments</summary>
              <p className="mt-1">
                {payee.previous_matches
                  .map((row) => `${fmtDateShort(row.business_date)} · ${inr(row.amount_paise)} · ${row.description}`)
                  .join("; ")}
                {payee.previous_count > payee.previous_matches.length ? " …" : ""}
              </p>
            </details>
          )}
        </div>
      )}
      <div className="flex justify-end border-t border-rule pt-4">
        <Button variant="outline" onClick={onClose}>Done reviewing</Button>
      </div>
      </div>
    </Sheet>
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
  // Without a matching statement credit there is nothing to confirm, so an
  // unmatched close is history, not work. Ninety days of it printed one row
  // per day buries the handful that can actually be actioned today.
  const matchable = closures.filter((closure: any) =>
    credits.some((credit: any) => credit.id === closure.suggested_credit_id));
  const waiting = closures.filter((closure: any) => !matchable.includes(closure));
  const waitingTotal = waiting.reduce((sum: number, row: any) => sum + row.remaining_paise, 0);
  const waitingDates = waiting.map((row: any) => row.date).sort();
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
          {matchable.map((closure: any) => {
            const suggested = credits.find((credit: any) => credit.id === closure.suggested_credit_id);
            return (
              <div key={closure.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
                <span className="w-20 text-ink-soft">{fmtDateShort(closure.date)}</span>
                <span className="num font-medium">{inr(closure.remaining_paise)}</span>
                <span className="min-w-0 flex-1 truncate text-ink-faint">
                  Suggested bank credit {fmtDateShort(suggested.date)} · {suggested.narration || suggested.reference || "no narration"}
                </span>
                <Button size="sm" variant="outline" disabled={match.isPending}
                        onClick={() => match.mutate({ closure, credit: suggested })}>
                  Confirm match
                </Button>
              </div>
            );
          })}
          {waiting.length > 0 && (
            <div className="px-4 py-3 text-sm">
              <p className="text-ink-soft">
                <b className="num">{waiting.length}</b> earlier cash removal{waiting.length === 1 ? "" : "s"}
                {" "}totalling <b className="num">{inr(waitingTotal)}</b>
                {waitingDates.length > 1
                  ? ` (${fmtDateShort(waitingDates[0])} → ${fmtDateShort(waitingDates[waitingDates.length - 1])})`
                  : ` (${fmtDateShort(waitingDates[0])})`}
                {" "}have no matching bank credit yet.
              </p>
              <p className="mt-0.5 text-xs text-ink-faint">
                Import the statement covering those dates and they become matchable here.
              </p>
              <details className="mt-2">
                <summary className="cursor-pointer text-xs font-medium text-ink-soft hover:text-ink">
                  Show the {waiting.length} waiting day{waiting.length === 1 ? "" : "s"}
                </summary>
                <ul className="mt-2 divide-y divide-rule border-t border-rule">
                  {waiting.map((closure: any) => (
                    <li key={closure.id} className="flex items-center gap-3 py-1.5 text-sm">
                      <span className="w-20 text-ink-soft">{fmtDateShort(closure.date)}</span>
                      <span className="num font-medium">{inr(closure.remaining_paise)}</span>
                      <span className="text-xs text-ink-faint">no exact bank credit found</span>
                    </li>
                  ))}
                </ul>
              </details>
            </div>
          )}
        </div>
      )}
      <ErrorNote msg={match.error?.message ?? ""} />
    </Card>
  );
}

function RuleRow({ rule, cats, vendors }: { rule: any; cats: any[]; vendors: any[] }) {
  const qc = useQueryClient();
  const [err, setErr] = useState("");
  const [confirming, setConfirming] = useState(false);
  const remove = useMutation({
    mutationFn: () => api.del(`/bank/rules/${rule.id}`),
    onSuccess: () => {
      setConfirming(false);
      qc.invalidateQueries({ queryKey: ["bank-rules"] });
    },
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
      <Button variant="ghost" size="sm" className="text-bad"
              disabled={remove.isPending}
              aria-label={`Forget ${rule.label || rule.match_key}`}
              onClick={() => setConfirming(true)}>
        <Trash2 size={15} />
      </Button>
      <ConfirmSheet
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={() => remove.mutate()}
        title="Forget rule?"
        description={`Forget "${rule.label || rule.match_key}"? Future statements will ask you to classify it again.`}
        confirmLabel="Forget rule"
        pending={remove.isPending}
        pendingLabel="Forgetting…"
      />
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
