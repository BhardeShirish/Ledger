import { useQuery } from "@tanstack/react-query";
import { Link, useOutletContext } from "react-router-dom";
import { api } from "../api/client";
import { addDaysISO, todayISO } from "../lib/format";
import { LowStockTable } from "./Inventory";
import { Badge, Card, SectionLabel, Spinner, StatTile } from "../components/ui";

export default function InventoryOverview() {
  const { outletId } = useOutletContext<{ outletId: number }>();
  const ov = useQuery({
    queryKey: ["inv-overview", outletId],
    queryFn: () => api.get(`/inventory/overview?outlet_id=${outletId}`),
  });
  const intelligence = useQuery({
    queryKey: ["inventory-intelligence", outletId, "30d"],
    queryFn: () => api.get(`/inventory/intelligence?outlet_id=${outletId}&start=${addDaysISO(todayISO(), -29)}&end=${todayISO()}`),
  });

  if (ov.isLoading || intelligence.isLoading) return <Spinner label="Loading stock evidence…" />;
  const items = ov.data?.items ?? [];
  const evidence = intelligence.data?.items ?? [];
  const supported = evidence.filter((item: any) => item.reorder_eligible);
  const risks = supported.filter((item: any) =>
    ["at_or_below_minimum", "stockout_risk", "below_par"].includes(item.risk));
  const rows = risks.map((item: any) => ({
    id: item.stock_item_id, name: item.item, base_unit: item.base_unit,
    current_qty: item.current_qty, par_qty: item.par_qty,
    days_of_cover: item.days_of_cover, suggested_order: item.reorder_recommendation_qty,
  }));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Tracked items" value={String(items.length)} />
        <StatTile label="Supported decisions" value={String(supported.length)}
          sub="recipe, sales, purchases & counts" tone={supported.length ? "good" : "ink"} />
        <StatTile label="Evidence withheld" value={String(Math.max(0, evidence.length - supported.length))}
          sub="not treated as safe stock" tone={evidence.length > supported.length ? "bad" : "ink"} />
        <StatTile label="Evidence-backed risks" value={String(risks.length)}
          sub="based on confirmed consumption" tone={risks.length ? "bad" : "good"} />
      </div>

      <Card className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="font-semibold">Needs evidence-backed attention</h2>
            <p className="mt-0.5 text-sm text-ink-faint">Risk is shown only when the recorded inputs support a conservative consumption forecast.</p>
          </div>
          <Badge tone={risks.length ? "bad" : "good"}>{risks.length ? `${risks.length} items` : "none supported"}</Badge>
        </div>
        <div className="mt-2">
          {risks.length ? <LowStockTable rows={rows} /> : (
            <p className="py-4 text-center text-sm text-ink-faint">
              No credible reorder risk is available yet. This does not mean every item is healthy.
            </p>
          )}
        </div>
      </Card>

      <Card className="p-4">
        <SectionLabel>How to use this</SectionLabel>
        <p className="mt-1.5 text-sm text-ink-soft">
          Review the evidence window before ordering. Recipe estimates are planning controls, never stock movements or cost/profit facts.
        </p>
        <Link to="/inventory/order" className="mt-3 inline-block text-sm font-semibold text-accent underline underline-offset-2">
          Review reorder evidence →
        </Link>
      </Card>
    </div>
  );
}
