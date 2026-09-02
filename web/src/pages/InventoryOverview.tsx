import { useQuery } from "@tanstack/react-query";
import { useOutletContext } from "react-router-dom";
import { api } from "../api/client";
import { inr, todayISO, addDaysISO } from "../lib/format";
import { LowStockTable } from "./Inventory";
import { Badge, Card, SectionLabel, Spinner, StatTile } from "../components/ui";

export default function InventoryOverview() {
  const { outletId } = useOutletContext<{ outletId: number }>();
  const ov = useQuery({
    queryKey: ["inv-overview", outletId],
    queryFn: () => api.get(`/inventory/overview?outlet_id=${outletId}`),
  });
  const uc = useQuery({
    queryKey: ["inv-usage", outletId],
    queryFn: () => api.get(`/inventory/usage?outlet_id=${outletId}` +
                           `&start=${addDaysISO(todayISO(), -29)}&end=${todayISO()}`),
  });

  if (ov.isLoading) return <Spinner />;
  const items = ov.data?.items ?? [];
  const low = items.filter((i: any) => i.below_min || (i.days_of_cover != null && i.days_of_cover < 4));
  const reorder = items.filter((i: any) => i.suggested_order > 0);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Tracked items" value={String(items.length)} />
        <StatTile label="Below reorder" value={String(ov.data?.below_min_count ?? 0)}
                  tone={(ov.data?.below_min_count ?? 0) > 0 ? "bad" : "good"} />
        <StatTile label="Food cost (30d)"
                  value={uc.data?.food_cost_percent != null
                         && (uc.data?.usage_value_rupees ?? 0) > 0
                         ? `${uc.data.food_cost_percent}%` : "learning…"}
                  sub={(uc.data?.usage_value_rupees ?? 0) > 0
                       ? `usage ${inr(Math.round(uc.data.usage_value_rupees * 100))}`
                       : "needs confirmed recipes"} />
        <StatTile label="Purchase variance (30d)"
                  value={uc.data?.links_used
                         ? inr(Math.round(uc.data.variance_rupees * 100), { sign: true })
                         : "—"}
                  sub={uc.data?.links_used ? `${uc.data.links_used} learned links` : "confirm links to enable"} />
      </div>

      <Card className="p-4">
        <div className="flex items-center justify-between">
          <SectionLabel>Needs attention</SectionLabel>
          <Badge tone={low.length ? "bad" : "good"}>
            {low.length ? `${low.length} items` : "all good"}
          </Badge>
        </div>
        <div className="mt-2">
          {low.length ? (
            <LowStockTable rows={low} />
          ) : (
            <p className="py-4 text-center text-sm text-ink-faint">
              Nothing running low. Set reorder levels on items to sharpen this.
            </p>
          )}
        </div>
      </Card>

      {uc.data && (
        <Card className="p-4">
          <SectionLabel>Last 30 days · purchases vs expected usage</SectionLabel>
          <p className="mt-1.5 text-sm text-ink-soft">
            Bought <b className="num">{inr(Math.round(uc.data.purchase_value_rupees * 100))}</b> ·
            expected used <b className="num">{inr(Math.round(uc.data.usage_value_rupees * 100))}</b> ·
            difference <b className={`num ${uc.data.variance_rupees > 5 ? "text-bad" : "text-good"}`}>
              {inr(Math.round(uc.data.variance_rupees * 100), { sign: true })}</b>
            <span className="text-ink-faint"> (stock built up or shrinkage)</span>
          </p>
          {reorder.length > 0 && (
            <p className="mt-2 text-sm">
              <b>Order soon:</b>{" "}
              {reorder.slice(0, 8).map((i: any) =>
                `${i.name} ${i.suggested_order}${i.base_unit}`).join(" · ")}
            </p>
          )}
        </Card>
      )}
    </div>
  );
}

