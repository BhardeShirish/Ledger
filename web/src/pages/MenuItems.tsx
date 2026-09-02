import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, downloadFile } from "../api/client";
import { useGuarded } from "../lib/auth";
import { fmtDateShort, inr, moneyCfg } from "../lib/format";
import { Badge, Button, Card, ErrorNote, Field, Input, SectionLabel, Sheet, Spinner } from "../components/ui";

function fmtDay(iso: string) {
  return new Date(iso + "T12:00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

export function MenuItems({ outletId, start, end }: {
  outletId: number | null; start: string; end: string;
}) {
  const qc = useQueryClient();
  const guarded = useGuarded();
  const items = useQuery({
    queryKey: ["items", outletId, start, end],
    queryFn: () => api.get(`/insights/items?start=${start}&end=${end}` +
                           (outletId ? `&outlet_id=${outletId}` : "")),
  });
  const [showImport, setShowImport] = useState(false);
  const [importError, setImportError] = useState("");

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-rule bg-paper-3/40 px-4 py-2.5">
        <SectionLabel>Menu intelligence · {fmtDay(start)} → {fmtDay(end)}</SectionLabel>
        {!showImport ? (
          <Button size="sm" variant="outline" onClick={() => setShowImport(true)}>
            Import item-wise sales
          </Button>
        ) : (
          <div className="flex items-center gap-2">
            <span className="text-xs text-ink-faint">
              Petpooja “Item wise sales” xlsx, or our template
            </span>
            <Button size="sm" variant="ghost"
                    onClick={() => downloadFile("/data/template/sales_items.xlsx",
                                                "template-sales_items.xlsx")}>
              Template
            </Button>
            <label className="cursor-pointer rounded-md border border-accent px-3 py-1 text-sm font-semibold text-accent hover:bg-accent-soft">
              Choose file…
              <input type="file" hidden accept=".xlsx,.xls"
                     onChange={async (e) => {
                       const f = e.target.files?.[0];
                       if (!f || !outletId) {
                         setImportError("Choose one outlet before importing item sales.");
                         return;
                       }
                       const fd = new FormData();
                       fd.append("file", f);
                       try {
                         setImportError("");
                         const staged = await api.post(
                           `/imports/upload?outlet_id=${outletId}`, fd,
                         );
                         await guarded(() =>
                           api.post(`/imports/${staged.batch_id}/commit`));
                         await qc.invalidateQueries({ queryKey: ["items"] });
                         setShowImport(false);
                       } catch (error: any) {
                         setImportError(error.message ?? "Item import failed.");
                       }
                     }} />
            </label>
          </div>
        )}
      </div>
      {importError && (
        <div className="px-4 pt-3"><ErrorNote msg={importError} /></div>
      )}

      {items.isLoading ? <Spinner /> : (
        <div className="grid gap-0 md:grid-cols-[1fr_260px] md:divide-x md:divide-rule">
          <div>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-rule text-left text-xs text-ink-faint">
                  <th className="px-4 py-1.5 font-medium">Top items</th>
                  <th className="px-2 py-1.5 text-right font-medium">Qty</th>
                  <th className="px-2 py-1.5 text-right font-medium">Revenue</th>
                  <th className="px-4 py-1.5 text-right font-medium">On menu</th>
                </tr>
              </thead>
              <tbody>
                {(items.data?.top ?? []).slice(0, 10).map((t: any) => (
                  <tr key={t.item} className="border-b border-rule/50 last:border-0">
                    <td className="px-4 py-1.5">{t.item}</td>
                    <td className="num px-2 py-1.5 text-right">{t.qty}</td>
                    <td className="num px-2 py-1.5 text-right font-medium">
                      {moneyCfg.symbol}{t.revenue_rupees.toLocaleString("en-IN")}
                    </td>
                    <td className="num px-4 py-1.5 text-right text-ink-faint">{t.menu_presence_percent}%</td>
                  </tr>
                ))}
                {(items.data?.top ?? []).length === 0 && (
                  <tr><td colSpan={4} className="px-4 py-6 text-center text-ink-faint">
                    No item data yet — upload an item-wise sheet above.
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="border-t border-rule p-4 md:border-t-0">
            <SectionLabel>Dead items</SectionLabel>
            <p className="mt-1 mb-2 text-xs text-ink-faint">
              sold before, absent in this range — consider cutting them
            </p>
            <ul className="space-y-1 text-sm">
              {(items.data?.dead_items ?? []).map((n: string) => (
                <li key={n} className="rounded bg-bad/5 px-2 py-1 text-bad">{n}</li>
              ))}
              {(items.data?.dead_items ?? []).length === 0 &&
                <li className="text-ink-faint">none detected ✓</li>}
            </ul>
          </div>
        </div>
      )}
    </Card>
  );
}

function me_allows(scopeAll: boolean) { void scopeAll; return true; }



