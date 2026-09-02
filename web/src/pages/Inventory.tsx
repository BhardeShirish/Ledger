import { useQuery } from "@tanstack/react-query";
import { Link, NavLink, Outlet, useLocation, useOutletContext } from "react-router-dom";
import { clsx } from "clsx";
import { api } from "../api/client";
import { Badge, Button, Card, SectionLabel, Spinner, StatTile } from "../components/ui";

const TABS = [
  { to: "/inventory", label: "Overview", end: true },
  { to: "/inventory/items", label: "Items & ledger" },
  { to: "/inventory/links", label: "Auto-recipes" },
  { to: "/inventory/counts", label: "Counts" },
  { to: "/inventory/wastage", label: "Wastage" },
  { to: "/inventory/order", label: "Order list" },
];

export default function InventoryLayout() {
  const loc = useLocation();
  const { outletId } = useOutletContext<{ outletId: number }>();
  return (
    <div className="space-y-4">
      <header>
        <SectionLabel>Inventory</SectionLabel>
        <h1 className="text-2xl font-semibold tracking-tight">Stock, usage & food cost</h1>
      </header>
      <div className="flex gap-1 overflow-x-auto border-b border-rule pb-px">
        {TABS.map((t) => {
          const active = t.end ? loc.pathname === "/inventory"
                               : loc.pathname.startsWith(t.to);
          return (
            <NavLink key={t.to} to={t.to} end={t.end}
                     className={clsx("shrink-0 rounded-t-md px-3.5 py-2 text-sm font-medium",
                       active ? "border border-b-0 border-rule-strong bg-paper text-accent"
                              : "text-ink-faint hover:text-ink")}>
              {t.label}
            </NavLink>
          );
        })}
      </div>
      <Outlet context={{ outletId }} />
    </div>
  );
}

export function LowStockTable({ rows }: { rows: any[] }) {
  if (!rows.length) return <p className="py-3 text-sm text-good">Everything above par ✓</p>;
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-rule text-left text-xs text-ink-faint">
          <th className="px-2 py-1.5 font-medium">Item</th>
          <th className="px-2 py-1.5 text-right font-medium">Have</th>
          <th className="px-2 py-1.5 text-right font-medium">Par</th>
          <th className="px-2 py-1.5 text-right font-medium">Cover</th>
          <th className="px-2 py-1.5 text-right font-medium">Order</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id} className="border-b border-rule/50 last:border-0">
            <td className="px-2 py-1.5">{r.name}</td>
            <td className="num px-2 py-1.5 text-right">{r.current_qty} {r.base_unit}</td>
            <td className="num px-2 py-1.5 text-right text-ink-faint">{r.par_qty || "—"}</td>
            <td className="num px-2 py-1.5 text-right">
              {r.days_of_cover != null
                ? <Badge tone={r.days_of_cover < 3 ? "bad" : r.days_of_cover < 7 ? "warn" : "good"}>
                    {r.days_of_cover}d</Badge>
                : "—"}
            </td>
            <td className="num px-2 py-1.5 text-right font-semibold">
              {r.suggested_order > 0 ? `${r.suggested_order} ${r.base_unit}` : "—"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
