import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useOutletContext } from "react-router-dom";
import { useState } from "react";
import { api } from "../api/client";
import { useGuarded } from "../lib/auth";
import { fmtDateShort, inr } from "../lib/format";
import { Badge, Button, Card, SectionLabel, Spinner } from "../components/ui";

export default function InventoryCounts() {
  const { outletId } = useOutletContext<{ outletId: number }>();
  const guarded = useGuarded();
  const qc = useQueryClient();
  const [countId, setCountId] = useState<number | null>(null);
  const [values, setValues] = useState<Record<number, string>>({});
  const [result, setResult] = useState<any>(null);
  const history = useQuery({
    queryKey: ["inv-count-history", outletId],
    queryFn: () => api.get(`/inventory/counts?outlet_id=${outletId}&start=2020-01-01&end=${new Date().toISOString().slice(0, 10)}`),
  });

  const start = useMutation({
    mutationFn: () => guarded(() => api.post(`/inventory/count/start?outlet_id=${outletId}`)),
    onSuccess: (r) => setCountId(r.count_id),
  });
  const count = useQuery({
    queryKey: ["inv-count", countId],
    queryFn: () => api.get(`/inventory/count/${countId}`),
    enabled: countId != null,
  });
  const done = useMutation({
    mutationFn: () => guarded(() => api.post(`/inventory/count/${countId}/done`, {
      lines: Object.entries(values)
        .filter(([, v]) => v !== "")
        .map(([sid, v]) => ({ stock_item_id: Number(sid), counted_qty: Number(v) })),
    })),
    onSuccess: (r) => { setResult(r.json ?? r); setCountId(null); setValues({});
                        qc.invalidateQueries({ queryKey: ["inv-overview"] });
                        qc.invalidateQueries({ queryKey: ["inv-count-history"] }); },
  });
  const lines: any[] = count.data?.lines ?? [];
  const complete = lines.length > 0 && lines.every((line) => {
    const value = values[line.stock_item_id];
    return value !== undefined && value !== "" &&
      Number.isFinite(Number(value)) && Number(value) >= 0;
  });

  if (result) {
    return (
      <Card className="mx-auto max-w-md space-y-2 p-6 text-center">
        <SectionLabel>Count saved</SectionLabel>
        <div className={`num text-3xl font-semibold ${result.shrinkage_rupees > 0 ? "text-bad" : "text-good"}`}>
          {inr(Math.round(result.shrinkage_rupees * 100), { sign: true })}
        </div>
        <p className="text-sm text-ink-faint">shrinkage since last count</p>
        <Button onClick={() => setResult(null)}>Back</Button>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {!countId && (
        <Card className="flex flex-col items-center gap-2 p-10 text-center">
          <SectionLabel>Monthly true-up</SectionLabel>
          <p className="max-w-sm text-sm text-ink-faint">
            Count what's physically on the shelf. The difference vs system
            becomes your real shrinkage number.
          </p>
          <Button className="mt-2" onClick={() => start.mutate()}
                  disabled={start.isPending}>
            {start.isPending ? "Preparing…" : "Start a count"}
          </Button>
        </Card>
      )}

      {countId && count.isLoading && <Spinner />}
      {countId && count.data && (
        <Card className="divide-y divide-rule">
          <div className="flex items-center justify-between px-4 py-2.5">
            <SectionLabel>Count · {fmtDateShort(count.data.business_date)}</SectionLabel>
            <Badge>{count.data.status}</Badge>
          </div>
          {count.data.lines.map((l: any) => (
            <div key={l.stock_item_id} className="flex items-center gap-3 px-4 py-2 text-sm">
              <span className="min-w-0 flex-1 truncate">{l.name}
                <span className="ml-1 text-xs text-ink-faint">{l.base_unit}</span></span>
              <span className="num w-20 text-right text-ink-faint">sys {l.system_qty}</span>
              <input inputMode="decimal" placeholder="counted" value={values[l.stock_item_id] ?? ""}
                     onChange={(e) => setValues((x) => ({ ...x, [l.stock_item_id]: e.target.value }))}
                     className="w-24 rounded-md border border-rule-strong bg-paper px-2 py-1.5 text-right num" />
              {values[l.stock_item_id] !== undefined && values[l.stock_item_id] !== "" && (
                <span className={`num w-16 text-right text-xs ${
                  Number(values[l.stock_item_id]) - l.system_qty < 0 ? "text-bad" : "text-good"}`}>
                  {Number(values[l.stock_item_id]) - l.system_qty >= 0 ? "+" : ""}
                  {Math.round((Number(values[l.stock_item_id]) - l.system_qty) * 100) / 100}
                </span>
              )}

              {!countId && !result && (history.data?.counts ?? []).length > 0 && (
                <Card className="overflow-hidden">
                  <div className="border-b border-rule px-4 py-3">
                    <h2 className="font-semibold">Count variance history</h2>
                    <p className="mt-0.5 text-sm text-ink-faint">Frozen shelf counts compared with the system quantity at that time.</p>
                  </div>
                  <div className="divide-y divide-rule">
                    {history.data.counts.slice(0, 6).map((count: any) => (
                      <details key={count.id} className="group">
                        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 hover:bg-paper-3/50">
                          <span className="font-medium">{fmtDateShort(count.date)}</span>
                          <span className={`num ${count.variance_value_paise < 0 ? "text-bad" : "text-good"}`}>
                            {inr(count.variance_value_paise, { sign: true })}
                          </span>
                        </summary>
                        <div className="border-t border-rule bg-paper-2 px-4 py-2">
                          {count.lines.map((line: any) => (
                            <div key={line.stock_item_id} className="flex items-baseline gap-3 py-1 text-sm">
                              <span className="min-w-0 flex-1 truncate">{line.name}</span>
                              <span className="num text-ink-faint">sys {line.theoretical_qty}</span>
                              <span className="num">physical {line.physical_qty}</span>
                              <span className={`num w-16 text-right ${line.variance_qty < 0 ? "text-bad" : "text-good"}`}>
                                {line.variance_qty >= 0 ? "+" : ""}{line.variance_qty}
                              </span>
                            </div>
                          ))}
                        </div>
                      </details>
                    ))}
                  </div>
                </Card>
              )}
            </div>
          ))}
          <div className="px-4 py-3">
            <Button className="w-full" disabled={done.isPending || !complete}
                    onClick={() => done.mutate()}>
              Finish count & true-up stock
            </Button>
            {!complete && (
              <p className="mt-2 text-center text-xs text-ink-faint">
                Enter a non-negative count for every item before finishing.
              </p>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}
