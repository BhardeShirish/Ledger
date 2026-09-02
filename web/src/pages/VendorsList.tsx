import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api/client";
import { inr } from "../lib/format";
import { ExportButton } from "../components/DataButtons";
import {
  Badge, Button, Card, EmptyState, Field, Input, SectionLabel, Sheet, Spinner,
} from "../components/ui";

export function useVendors() {
  return useQuery({ queryKey: ["vendors"], queryFn: () => api.get("/vendors") });
}

export default function VendorsList() {
  const q = useVendors();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const create = useMutation({
    mutationFn: () => api.post("/vendors", { name, phone }),
    onSuccess: () => { setOpen(false); setName(""); setPhone(""); qc.invalidateQueries({ queryKey: ["vendors"] }); },
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

      <Card className="divide-y divide-rule">
        {rows.length === 0 && (
          <EmptyState title="No vendors yet" hint="Add your vegetable mart, dairy, gas agency — then log purchases on credit against them." />
        )}
        {rows.map((v) => (
          <a key={v.id} href={`/money/vendors/${v.id}`}
             className="flex items-center gap-3 px-4 py-3 hover:bg-paper-3/50">
            <div className="min-w-0 flex-1">
              <div className="font-medium">{v.name}</div>
              <div className="text-xs text-ink-faint">{v.phone || "—"}</div>
            </div>
            {!v.is_active && <Badge>inactive</Badge>}
            <div className={`num text-right font-medium ${v.balance_paise > 0 ? "text-bad" : ""}`}>
              {inr(v.balance_paise)}
              <div className="text-[10px] uppercase tracking-wide text-ink-faint">due</div>
            </div>
          </a>
        ))}
      </Card>

      <Sheet open={open} onClose={() => setOpen(false)} title="New vendor">
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

