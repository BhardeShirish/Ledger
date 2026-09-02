import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useOutletContext } from "react-router-dom";
import { useState } from "react";
import { api } from "../api/client";
import { useAuth, useGuarded } from "../lib/auth";
import {
  Badge, Button, Card, EmptyState, ErrorNote, Input, SectionLabel, Spinner,
} from "../components/ui";

export default function InventoryLinks() {
  const { outletId } = useOutletContext<{ outletId: number }>();
  const { me } = useAuth();
  const qc = useQueryClient();
  const guarded = useGuarded();
  const q = useQuery({
    queryKey: ["inv-learn", outletId],
    queryFn: () => api.get(`/inventory/learn?outlet_id=${outletId}`),
  });
  const [coefEdit, setCoefEdit] = useState<Record<string, string>>({});

  const decide = useMutation({
    mutationFn: (p: any) => {
      const coef = p.coefficient ?? Number(coefEdit[`${p.stock_item_id}|${p.menu_item}`] ?? 0);
      return guarded(() => api.put(`/inventory/links?outlet_id=${outletId}`, {
        stock_item_id: p.stock_item_id, menu_item_name: p.menu_item,
        coefficient: coef, status: p.status,
      }));
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["inv-learn"] }),
  });

  if (q.isLoading) return <Spinner />;
  const sugg = q.data?.suggestions ?? [];
  const links = q.data?.links ?? [];

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <SectionLabel>How this works</SectionLabel>
        <p className="mt-1.5 text-sm leading-relaxed text-ink-soft">
          The system correlates what you <b>buy</b> with what you <b>sell</b>.
          Confirmed pairs become your recipes — powering food-cost %, dish
          profitability and usage predictions. No recipe cards needed.
        </p>
      </Card>

      <Card className="p-4">
        <div className="flex items-center justify-between">
          <SectionLabel>Suggestions</SectionLabel>
          <Badge tone="warn">{sugg.length} pending</Badge>
        </div>
        {sugg.length === 0 && (
          <EmptyState title="No suggestions yet"
                      hint="Needs ~3+ weeks of item-wise sales plus quantity-tracked purchases." />
        )}
        <div className="mt-2 space-y-2">
          {sugg.map((s: any) => {
            const key = `${s.stock_item_id}|${s.menu_item}`;
            return (
              <div key={key} className="flex flex-wrap items-center gap-2 rounded-md border border-rule px-3 py-2 text-sm">
                <span className="font-medium">{s.stock_item}</span>
                <span className="text-ink-faint">↔</span>
                <span>{s.menu_item}</span>
                <Badge tone={s.confidence === "stable" ? "good" : "warn"}>
                  {s.confidence} · {s.weeks_data}wks
                </Badge>
                <span className="num ml-auto">r={s.correlation}</span>
                <Input inputMode="decimal" value={coefEdit[key] ?? String(s.coefficient)}
                       onChange={(e) => setCoefEdit((x) => ({ ...x, [key]: e.target.value }))}
                       className="!w-20 !py-1 text-right num text-xs"
                       title="kg per plate — edit if you know better" />
                <span className="text-xs text-ink-faint">per dish</span>
                <Button size="sm" disabled={decide.isPending}
                        onClick={() => decide.mutate({
                  stock_item_id: s.stock_item_id, menu_item: s.menu_item,
                  coefficient: Number(coefEdit[key] ?? s.coefficient),
                  status: "confirmed"})}>Confirm</Button>
                <Button size="sm" variant="ghost" disabled={decide.isPending}
                        onClick={() => decide.mutate({
                  stock_item_id: s.stock_item_id, menu_item: s.menu_item,
                  coefficient: Number(coefEdit[key] ?? s.coefficient),
                  status: "rejected"})}>Reject</Button>
              </div>
            );
          })}
        </div>
      </Card>

      <Card className="p-4">
        <SectionLabel>Your recipes</SectionLabel>
        <div className="mt-2 space-y-1.5 text-sm">
          {links.filter((l: any) => l.status === "confirmed").map((l: any) => (
            <div key={`${l.stock_item_id}-${l.menu_item}`}
                 className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-paper-3">
              <span className="font-medium">{l.stock_item}</span>
              <span className="text-ink-faint">↔</span>
              <span>{l.menu_item}</span>
              <span className="num ml-auto">{l.coefficient} per dish</span>
              <Badge tone={l.confidence === "stable" ? "good" : "warn"}>{l.confidence}</Badge>
              <button className="text-xs text-bad hover:underline disabled:opacity-40"
                      disabled={decide.isPending}
                      onClick={() => confirm(
                        `Remove the recipe link ${l.stock_item} ↔ ${l.menu_item}?`,
                      ) && decide.mutate({
                        stock_item_id: l.stock_item_id, menu_item: l.menu_item,
                        coefficient: l.coefficient, status: "rejected"})}>
                remove
              </button>
            </div>
          ))}
          {links.filter((l: any) => l.status === "confirmed").length === 0 && (
            <p className="py-2 text-ink-faint">None confirmed yet.</p>
          )}
        </div>
      </Card>
      <ErrorNote msg={decide.error?.message ?? ""} />
    </div>
  );
}

