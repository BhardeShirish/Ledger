import { useQuery } from "@tanstack/react-query";
import { Link, useOutletContext } from "react-router-dom";
import { useState } from "react";
import { api } from "../api/client";
import { Badge, Button, Card, EmptyState, SectionLabel, Spinner } from "../components/ui";

export default function InventoryOrder() {
  const { outletId } = useOutletContext<{ outletId: number }>();
  const q = useQuery({
    queryKey: ["inv-order", outletId],
    queryFn: () => api.get(`/inventory/order?outlet_id=${outletId}`),
  });
  const [copied, setCopied] = useState<"idle" | "done" | "failed">("idle");

  if (q.isLoading) return <Spinner />;
  const rows = q.data ?? [];

  const whatsappText = rows
    .map((r: any) => `${r.item} — ${r.suggested_order} ${r.base_unit}`)
    .join("\n");
  const text = `Order list (${new Date().toLocaleDateString("en-IN")}):\n${whatsappText}`;

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <SectionLabel>Suggested order</SectionLabel>
          <h1 className="text-2xl font-semibold tracking-tight">
            {rows.length} items below par
          </h1>
          <p className="text-xs text-ink-faint">
            order qty = par − current · sorted by urgency (days of cover)
          </p>
        </div>
        {rows.length > 0 && (
          <Button onClick={async () => {
            try {
              await navigator.clipboard.writeText(text);
              setCopied("done");
            } catch {
              // clipboard can be blocked by the browser; say so instead of
              // looking like the button did nothing
              setCopied("failed");
            }
            setTimeout(() => setCopied("idle"), 2000);
          }}>
            {copied === "done" ? "Copied ✓"
              : copied === "failed" ? "Copy blocked — select the list"
              : "Copy for WhatsApp"}
          </Button>
        )}
      </header>

      <Card className="divide-y divide-rule">
        {rows.length === 0 && (
          <EmptyState title="Nothing to order"
                      hint="Set par levels on items first — then this list builds itself from stock and usage."
                      action={
                        <Link to="/inventory/items"
                              className="mt-1 text-sm font-medium text-accent underline underline-offset-2">
                          Set par levels →
                        </Link>
                      } />
        )}
        {rows.map((r: any) => (
          <div key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm">
            <span className="min-w-0 flex-1 truncate font-medium">{r.item}</span>
            <span className="num text-xs text-ink-faint">
              have {r.current_qty} · par {r.par_qty}
            </span>
            {r.days_of_cover != null && (
              <Badge tone={r.days_of_cover < 3 ? "bad" : r.days_of_cover < 7 ? "warn" : "neutral"}>
                {r.days_of_cover}d left
              </Badge>
            )}
            <span className="num w-28 text-right text-base font-semibold">
              {r.suggested_order} {r.base_unit}
            </span>
            {r.last_vendor && (
              <span className="w-28 truncate text-right text-xs text-ink-faint">{r.last_vendor}</span>
            )}
          </div>
        ))}
      </Card>

      {rows.length > 0 && (
        <p className="text-xs text-ink-faint">
          Quantities use forecast-aware usage. After buying, log the purchase as
          a normal expense with qty — stock updates itself.
        </p>
      )}
    </div>
  );
}

