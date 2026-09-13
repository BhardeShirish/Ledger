import { NavLink, Outlet, useLocation, useOutletContext } from "react-router-dom";
import { useState } from "react";
import { clsx } from "clsx";
import { Check, ChevronDown } from "lucide-react";
import { Badge, SectionLabel, Sheet } from "../components/ui";

const TABS = [
  { to: "/inventory", label: "Overview", end: true },
  { to: "/inventory/items", label: "Items & ledger" },
  { to: "/inventory/links", label: "Auto-recipes" },
  { to: "/inventory/counts", label: "Counts" },
  { to: "/inventory/wastage", label: "Wastage" },
  { to: "/inventory/order", label: "Order list" },
];

const isActiveTab = (tab: { to: string; end?: boolean }, pathname: string) =>
  tab.end ? pathname === "/inventory" : pathname.startsWith(tab.to);

export default function InventoryLayout() {
  const loc = useLocation();
  const { outletId } = useOutletContext<{ outletId: number }>();
  const [pickerOpen, setPickerOpen] = useState(false);
  const active = TABS.find((t) => isActiveTab(t, loc.pathname)) ?? TABS[0];
  return (
    <div className="space-y-4">
      <header>
        <SectionLabel>Inventory</SectionLabel>
        <h1 className="text-2xl font-semibold tracking-tight">Stock, usage & food cost</h1>
      </header>

      {/* Mobile: one picker that names where you are. Six tabs scrolled
          sideways hid four of their own destinations off-screen. */}
      <button type="button" aria-haspopup="dialog" aria-expanded={pickerOpen}
              onClick={() => setPickerOpen(true)}
              className="flex min-h-11 w-full items-center justify-between gap-3 rounded-md border border-rule-strong bg-paper px-3 py-2 text-left md:hidden">
        <span className="min-w-0">
          <span className="label-caps block text-ink-faint">Inventory section</span>
          <span className="block truncate font-semibold">{active.label}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1 text-sm text-ink-faint">
          Change <ChevronDown size={16} />
        </span>
      </button>
      <Sheet open={pickerOpen} onClose={() => setPickerOpen(false)} title="Go to inventory section">
        <nav className="-my-1 divide-y divide-rule">
          {TABS.map((t) => {
            const current = isActiveTab(t, loc.pathname);
            return (
              <NavLink key={t.to} to={t.to} end={t.end}
                       aria-current={current ? "page" : undefined}
                       onClick={() => setPickerOpen(false)}
                       className="flex min-h-11 items-center justify-between gap-3 px-1 py-2.5 text-sm font-medium">
                <span>{t.label}</span>
                {current
                  ? <Badge tone="accent"><Check size={12} /> you are here</Badge>
                  : <span className="text-ink-faint">open</span>}
              </NavLink>
            );
          })}
        </nav>
      </Sheet>

      {/* Desktop keeps the full tab row. */}
      <div className="hidden flex-wrap gap-1 border-b border-rule pb-px md:flex">
        {TABS.map((t) => {
          const active = isActiveTab(t, loc.pathname);
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
