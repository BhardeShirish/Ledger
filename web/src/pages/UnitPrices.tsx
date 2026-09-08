import { useQuery } from "@tanstack/react-query";
import { useOutletContext } from "react-router-dom";
import { useMemo, useState } from "react";
import { api } from "../api/client";
import { fmtDateShort, inr, monthLabelShort, todayISO } from "../lib/format";
import { ExportButton } from "../components/DataButtons";
import {
  Badge, Button, Card, EmptyState, Input, SectionLabel, Spinner,
} from "../components/ui";

type Ctx = { outletId: number };

export default function UnitPrices() {
  const { outletId } = useOutletContext<Ctx>();
  const [monthOffset, setMonthOffset] = useState(1);
  const [filter, setFilter] = useState("");

  const period = useMemo(() => {
    const d = new Date();
    d.setDate(1);
    d.setMonth(d.getMonth() - monthOffset + 1); // include current
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  }, [monthOffset]);
  const periodEnd = useMemo(() => {
    const [year, month] = period.split("-").map(Number);
    const last = new Date(year, month, 0).getDate();
    return `${period}-${String(last).padStart(2, "0")}`;
  }, [period]);

  const q = useQuery({
    queryKey: ["unit-econ", period, outletId],
    queryFn: () => api.get(`/insights/unit-economics?start=${period}-01&end=${periodEnd}&outlet_id=${outletId}`),
  });

  if (q.isLoading) return <Spinner />;
  const rows = (q.data ?? []).filter((r: any) =>
    !filter || r.item.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <SectionLabel>Money · Unit prices</SectionLabel>
          <h1 className="text-2xl font-semibold tracking-tight">What things cost per kg</h1>
          <p className="text-xs text-ink-faint">
            From expenses where you logged a quantity. Cheapest vendor highlighted.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" aria-label="Previous month"
                  onClick={() => setMonthOffset(monthOffset - 1)}>‹</Button>
          <span className="min-w-[5.5rem] px-1 py-1.5 text-center text-sm font-medium text-ink-soft">{monthLabelShort(period)}</span>
          <Button variant="outline" size="sm" disabled={monthOffset <= 0}
                  aria-label="Next month"
                  onClick={() => setMonthOffset(monthOffset + 1)}>›</Button>
          <ExportButton entity="unit_economics"
                        params={{ outlet_id: outletId, start: `${period}-01`, end: periodEnd }} />
        </div>
      </header>

      <Input placeholder="Filter item…" value={filter}
             onChange={(e) => setFilter(e.target.value)} className="max-w-xs" />

      {rows.length === 0 && (
        <Card className="p-8 text-center">
          <p className="font-medium">No quantity-tracked purchases this month</p>
          <p className="mt-1 text-sm text-ink-faint">
            When logging an expense, open “Bought by weight/quantity?” and enter
            qty + vendor — price-per-kg comparisons build themselves here.
          </p>
        </Card>
      )}

      <div className="space-y-3">
        {rows.map((it: any) => (
          <Card key={it.item} className="overflow-hidden">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-rule bg-paper-3/40 px-4 py-2.5">
              <span className="font-semibold">{it.item}</span>
              <Badge>{it.category}</Badge>
              <Badge tone={it.trend_percent > 5 ? "bad" : it.trend_percent < -5 ? "good" : "neutral"}>
                {it.trend_percent > 0 ? "▲" : it.trend_percent < 0 ? "▼" : "•"}
                {" "}{Math.abs(it.trend_percent)}% trend
              </Badge>
              <span className="num ml-auto text-sm text-ink-faint">
                avg {inr(Math.round(it.avg_unit_price * 100))}/{it.unit || "u"} · {it.purchases_count} buys
              </span>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-rule text-left text-xs text-ink-faint">
                  <th className="px-4 py-1.5 font-medium">Date</th>
                  <th className="px-2 py-1.5 font-medium">Vendor</th>
                  <th className="px-2 py-1.5 text-right font-medium">Qty</th>
                  <th className="px-2 py-1.5 text-right font-medium">Total</th>
                  <th className="px-4 py-1.5 text-right font-medium">Per {it.unit || "u"}</th>
                </tr>
              </thead>
              <tbody>
                {it.purchases.map((p: any, i: number) => {
                  const cheapest = p.unit_price_rupees === it.cheapest_unit_price;
                  return (
                    <tr key={i} className="border-b border-rule/50 last:border-0">
                      <td className="px-4 py-1.5">{fmtDateShort(p.date)}</td>
                      <td className="px-2 py-1.5">
                        {p.vendor || "—"}{" "}
                        {cheapest && <Badge tone="good">cheapest</Badge>}
                      </td>
                      <td className="num px-2 py-1.5 text-right">{p.qty} {p.unit}</td>
                      <td className="num px-2 py-1.5 text-right">{inr(Math.round(p.total_rupees * 100))}</td>
                      <td className={`num px-4 py-1.5 text-right font-semibold ${
                        cheapest ? "text-good" : ""}`}>
                        {inr(Math.round(p.unit_price_rupees * 100))}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>
        ))}
      </div>
    </div>
  );
}
