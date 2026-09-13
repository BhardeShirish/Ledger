import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useOutletContext } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { api } from "../api/client";
import { inr, todayISO } from "../lib/format";
import { useDirtyDraft } from "../lib/useDirtyDraft";
import { ExportButton } from "../components/DataButtons";
import {
  Badge, Button, Card, EmptyState, Field, Input, SectionLabel, Sheet, Spinner,
} from "../components/ui";

export function useVendors(outletId?: number) {
  return useQuery({
    queryKey: ["vendors", outletId ?? null],
    queryFn: () => api.get(`/vendors${outletId ? `?outlet_id=${outletId}` : ""}`),
  });
}

export default function VendorsList() {
  const { outletId } = useOutletContext<{ outletId: number }>();
  const q = useVendors(outletId);
  const aging = useQuery({
    queryKey: ["vendor-aging", outletId],
    queryFn: () => api.get(`/vendors/aging?outlet_id=${outletId}&as_of=${todayISO()}`),
  });
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const create = useMutation({
    mutationFn: () => api.post("/vendors", { name, phone }),
    onSuccess: () => { setOpen(false); setName(""); setPhone(""); qc.invalidateQueries({ queryKey: ["vendors"] }); },
  });
  const draft = useDirtyDraft({
    open, label: "new vendor",
    values: { name, phone }, pristine: { name: "", phone: "" },
    discard: () => { setName(""); setPhone(""); setOpen(false); },
  });

  if (q.isLoading) return <Spinner />;
  const rows: any[] = q.data ?? [];
  const totalDue = rows.reduce((s: number, v: any) => s + Math.max(0, v.balance_paise), 0);

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <SectionLabel>Money · Vendors</SectionLabel>
          <h1 className="text-2xl font-semibold tracking-tight">
            {inr(totalDue)} <span className="text-sm font-normal text-ink-faint">we owe</span>
          </h1>
        </div>
        <ExportButton entity="vendors" />
        <Button size="sm" onClick={() => setOpen(true)}>+ Vendor</Button>
      </header>

      {(aging.data ?? []).length > 0 && (
        <Card className="overflow-hidden">
          <div className="border-b border-rule px-4 py-3">
            <h2 className="font-semibold">Payable aging</h2>
            <p className="mt-0.5 text-sm text-ink-faint">Open credit purchases, aged from purchase date.</p>
          </div>
          <div className="divide-y divide-rule">
            {aging.data.slice(0, 8).map((row: any) => (
              <a key={row.vendor_id} href={`/money/vendors/${row.vendor_id}`}
                 className="flex items-center gap-3 px-4 py-2.5 hover:bg-paper-3/50">
                <span className="min-w-0 flex-1 truncate font-medium">{row.vendor}</span>
                {(["over_90", "61_90", "31_60", "1_30"] as const).map((bucket) =>
                  row.buckets[bucket] > 0 && (
                    <Badge key={bucket} tone={bucket === "over_90" ? "bad" : "warn"}>
                      {bucket.replace("_", "–")} {inr(row.buckets[bucket])}
                    </Badge>
                  ))}
                <span className="num font-medium">{inr(row.total_paise)}</span>
              </a>
            ))}
          </div>
        </Card>
      )}

      <Card className="divide-y divide-rule">
        {rows.length === 0 && (
          <EmptyState title="No vendors yet" hint="Add your vegetable mart, dairy, gas agency — then log purchases on credit against them." />
        )}
        {rows.map((v) => (
          <Link key={v.id} to={`/money/vendors/${v.id}`}
                aria-label={`Open ${v.name} — ${inr(v.balance_paise)} due`}
                className="flex min-h-11 items-center gap-3 px-4 py-3 hover:bg-paper-3/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
            <div className="min-w-0 flex-1">
              <div className="font-medium">{v.name}</div>
              <div className="text-xs text-ink-faint">{v.phone || "—"}</div>
            </div>
            {!v.is_active && <Badge>inactive</Badge>}
            <div className={`num text-right font-medium ${v.balance_paise > 0 ? "text-bad" : ""}`}>
              {inr(v.balance_paise)}
              <div className="text-xs uppercase tracking-wide text-ink-faint">due</div>
            </div>
            <ChevronRight size={16} aria-hidden="true" className="shrink-0 text-ink-faint" />
          </Link>
        ))}
      </Card>

      <Sheet open={open} onClose={draft.close} title="New vendor">
        <div className="space-y-3">
          <Field label="Name"><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Phone (optional)"><Input value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
          <Button className="w-full" disabled={!name.trim() || create.isPending}
                  onClick={() => create.mutate()}>
            {create.isPending ? "Saving…" : "Save vendor"}
          </Button>
        </div>
      </Sheet>
    </div>
  );
}
