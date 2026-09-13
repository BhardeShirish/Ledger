import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { FileUp } from "lucide-react";
import { api } from "../api/client";
import { fmtDateShort, inr, minToHHMM, todayISO } from "../lib/format";
import { ExportButton } from "../components/DataButtons";
import {
  Badge, Button, Card, EmptyState, ErrorNote, Field, Input, SectionLabel,
  Select, Sheet, Spinner,
} from "../components/ui";

const KIND_LABEL: Record<string, string> = {
  cash: "Cash", upi: "UPI", card: "Card", split: "Split bill",
  due: "Credit due", wallet: "Wallet", aggregator: "Delivery app", other: "Other",
};
const ALLOC_CHANNELS = ["cash", "upi", "card"];
const PER_PAGE = 100;

export default function Bills() {
  const { outletId } = useOutletContext<{ outletId: number }>();
  const [date, setDate] = useState("");
  const [kind, setKind] = useState("");
  // Typed text stays local; only a submitted search reaches the server. This
  // app has no debounce helper, and a request per keystroke is worse.
  const [search, setSearch] = useState("");
  const [qText, setQText] = useState("");
  const [page, setPage] = useState(1);
  const [allocating, setAllocating] = useState<any>(null);

  const q = useQuery({
    queryKey: ["bills", outletId, date, kind, qText, page],
    queryFn: () => {
      const params = new URLSearchParams({
        outlet_id: String(outletId), page: String(page),
        per_page: String(PER_PAGE),
      });
      if (date) params.set("business_date", date);
      if (kind) params.set("kind", kind);
      if (qText) params.set("q", qText);
      return api.get(`/sales/bills?${params.toString()}`);
    },
    placeholderData: (prev) => prev,
  });
  const splits = useQuery({
    queryKey: ["splits", outletId],
    queryFn: () => api.get(`/sales/unresolved-splits?outlet_id=${outletId}`),
  });

  if (q.isLoading) return <Spinner />;
  if (q.isError) {
    return (
      <div className="space-y-3">
        <ErrorNote msg="Couldn't load bills. Check your connection and retry." />
        <Button variant="outline" disabled={q.isFetching} onClick={() => void q.refetch()}>
          {q.isFetching ? "Retrying bills…" : "Retry bills"}
        </Button>
      </div>
    );
  }
  const rows: any[] = Array.isArray(q.data?.rows) ? q.data.rows : [];
  const total: number = Number.isSafeInteger(q.data?.total) && q.data.total >= 0
    ? q.data.total : rows.length;
  // The server owns the page size, so the counter cannot drift from the rows.
  const perPage: number = Number.isSafeInteger(q.data?.per_page) && q.data.per_page > 0
    ? q.data.per_page : PER_PAGE;
  const filtered = !!(date || kind || qText);
  const firstShown = rows.length === 0 ? 0 : (page - 1) * perPage + 1;
  const lastShown = (page - 1) * perPage + rows.length;
  const hasNext = lastShown < total;
  /** Any filter change invalidates the page the user was standing on. */
  const refilter = (apply: () => void) => { apply(); setPage(1); };

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <SectionLabel>Sales · Bills</SectionLabel>
          <h1 className="text-2xl font-semibold tracking-tight">Every bill, searchable</h1>
        </div>
        <div className="flex flex-wrap gap-2">
          <Input type="date" size="compact" value={date}
                 aria-label="Show bills for this date"
                 onChange={(e) => refilter(() => setDate(e.target.value))}
                 className="!w-auto" />
          <Select size="compact" value={kind}
                  aria-label="Filter bills by payment mode"
                  onChange={(e) => refilter(() => setKind(e.target.value))}
                  className="!w-auto">
            <option value="">All modes</option>
            {Object.entries(KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </Select>
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
      {splits.isError && (
        <div className="flex flex-wrap items-center gap-2">
          <ErrorNote msg="Couldn't check for unresolved split bills." />
          <Button size="sm" variant="outline" disabled={splits.isFetching}
                  onClick={() => void splits.refetch()}>
            {splits.isFetching ? "Retrying splits…" : "Retry split check"}
          </Button>
        </div>
      )}

      <form className="flex flex-wrap items-center gap-2"
            onSubmit={(e) => { e.preventDefault(); refilter(() => setQText(search.trim())); }}>
        <Input placeholder="Search invoice no or area…" value={search}
               fullWidth={false}
               aria-label="Search bills by invoice number or area"
               onChange={(e) => setSearch(e.target.value)}
               className="min-w-0 flex-1" />
        <Button type="submit" variant="outline">Search</Button>
        {qText && (
          <Button type="button" variant="ghost"
                  onClick={() => refilter(() => { setSearch(""); setQText(""); })}>
            Clear search
          </Button>
        )}
      </form>

      <Card className="divide-y divide-rule">
        {rows.length === 0 && (filtered ? (
          <EmptyState title="No bills match these filters"
                      hint="Try another date, payment mode, invoice number or area." />
        ) : (
          <EmptyState title="No bills found"
                      hint="Import a Petpooja Orders Master Report to fill history — every bill lands here."
                      action={
                        <Link to="/sales/import"
                              className="mt-2 inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-accent px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-accent/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2">
                          <FileUp size={15} aria-hidden="true" /> Import POS report
                        </Link>
                      } />
        ))}
        {rows.map((b) => {
          const unresolvedSplit = b.channel_kind === "split";
          const row = (
            <>
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
            {unresolvedSplit && <span className="text-xs font-semibold text-accent underline underline-offset-2">Resolve split</span>}
            </>
          );
          return unresolvedSplit ? (
            <button key={b.id} type="button"
                    aria-label={`Resolve split for bill #${b.invoice_no}`}
                    onClick={() => setAllocating(b)}
                    className="flex w-full items-center gap-3 px-4 py-2 text-left text-sm hover:bg-accent-soft/50">
              {row}
            </button>
          ) : (
            <div key={b.id} className="flex items-center gap-3 px-4 py-2 text-sm">{row}</div>
          );
        })}
      </Card>
      {(rows.length > 0 || page > 1) && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-ink-faint">
          <span role="status">
            {q.isFetching ? "Updating bills…"
              : rows.length === 0 ? "This page is empty — go back a page."
                : `Showing ${firstShown}–${lastShown} of ${total} bills`}
          </span>
          <span className="flex gap-2">
            <Button size="sm" variant="outline" aria-label="Previous page of bills"
                    disabled={page <= 1 || q.isFetching}
                    onClick={() => setPage(page - 1)}>
              <span aria-hidden="true">‹</span> Previous
            </Button>
            <Button size="sm" variant="outline" aria-label="Next page of bills"
                    disabled={!hasNext || q.isFetching}
                    onClick={() => setPage(page + 1)}>
              Next <span aria-hidden="true">›</span>
            </Button>
          </span>
        </div>
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
  const enteredAllocations = Object.entries(amounts)
    .filter(([, value]) => value.trim() !== "");
  const invalidAllocation = enteredAllocations.some(([, value]) => {
    const amount = Number(value);
    return !Number.isFinite(amount) || amount <= 0;
  });
  const allocations = enteredAllocations
    .filter(([, value]) => {
      const amount = Number(value);
      return Number.isFinite(amount) && amount > 0;
    })
    .map(([channel_kind, value]) => ({ channel_kind, amount_rupees: Number(value) }));
  const total = allocations.reduce((sum, allocation) => sum + allocation.amount_rupees, 0);
  const target = Number(bill?.total_rupees ?? 0);
  const balanced = !invalidAllocation && allocations.length >= 2
    && Math.round(total * 100) === Math.round(target * 100);
  const allocationError = invalidAllocation
    ? "Each entered split amount must be a finite amount greater than ₹0."
    : enteredAllocations.length > 0 && allocations.length < 2
      ? "A split payment needs at least two payment methods."
      : enteredAllocations.length > 0 && !balanced
        ? `Split amounts must total exactly ${inr(Math.round(target * 100))}.`
        : "";

  const save = useMutation({
    mutationFn: () => api.post(`/sales/bills/${bill.id}/allocate-split`, {
      allocations,
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
        <ErrorNote msg={save.error?.message ?? allocationError} />
        <Button size="lg" className="w-full" disabled={!balanced || save.isPending}
                onClick={() => save.mutate()}>
          Allocate &amp; resolve
        </Button>
      </div>
    </Sheet>
  );
}
