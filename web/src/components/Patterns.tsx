import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ArrowDown, ArrowUp, Minus } from "lucide-react";
import { api } from "../api/client";
import { inr } from "../lib/format";
import { Card, ErrorNote, SectionLabel, Spinner } from "./ui";
import { FindingList, type Finding } from "./Findings";

function qs(start: string, end: string, outletId: number | null) {
  return `?start=${start}&end=${end}` + (outletId ? `&outlet_id=${outletId}` : "");
}

/** A bar whose width is a share of the biggest row, so rows compare by eye. */
function Bar({ value, max, label, right }: {
  value: number; max: number; label: string; right: string;
}) {
  const pct = max > 0 ? Math.max((value / max) * 100, 1.5) : 0;
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span className="num shrink-0 text-ink-soft">{right}</span>
      </div>
      <div className="h-1.5 rounded-full bg-paper-3">
        <div className="h-1.5 rounded-full bg-accent" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/**
 * When your shop is busy, and what next week looks like.
 *
 * Everything here comes from bill timestamps, which most shops never look
 * at. The forecast is a median of each weekday's own recent history — a
 * Sunday is predicted from Sundays, never from a blended daily average.
 */
export function TradePatterns({ start, end, outletId }: {
  start: string; end: string; outletId: number | null;
}) {
  const q = useQuery({
    queryKey: ["patterns-bills", start, end, outletId],
    queryFn: () => api.get(`/patterns/bills${qs(start, end, outletId)}`),
  });
  const d = q.data;
  const findings: Finding[] = d?.findings ?? [];

  const hours = (d?.hours ?? []).filter((h: any) => h.bills > 0);
  const peakHour = Math.max(1, ...hours.map((h: any) => h.rupees));
  const weekdays = d?.weekdays ?? [];
  const peakDay = Math.max(1, ...weekdays.map((w: any) => w.rupees_per_day));

  return (
    <Card className="space-y-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SectionLabel>When you're busy</SectionLabel>
        {d && (
          <span className="text-xs text-ink-faint">
            <span className="num">{d.totals.bills.toLocaleString("en-IN")}</span> bills over{" "}
            <span className="num">{d.totals.days_open}</span> days · average{" "}
            <span className="num">{inr(Math.round(d.totals.avg_ticket_rupees * 100))}</span>
          </span>
        )}
      </div>

      {q.isLoading && <Spinner label="Reading the books…" />}
      {q.isError && <ErrorNote msg="Couldn't read your bill history." />}

      {d && d.totals.bills === 0 ? (
        <p className="py-4 text-sm text-ink-faint">
          No bills in this period yet.
        </p>
      ) : d && (
        <>
          <FindingList findings={findings} />

          <div className="grid gap-5 sm:grid-cols-2">
            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
                Takings by hour
              </p>
              {hours.map((h: any) => (
                <Bar key={h.hour} value={h.rupees} max={peakHour}
                     label={`${String(h.hour).padStart(2, "0")}:00`}
                     right={`${inr(Math.round(h.rupees * 100))} · ${h.bills}`} />
              ))}
            </div>

            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
                An average day, by weekday
              </p>
              {weekdays.filter((w: any) => w.days_open > 0).map((w: any) => (
                <Bar key={w.dow} value={w.rupees_per_day} max={peakDay}
                     label={w.name}
                     right={`${inr(Math.round(w.rupees_per_day * 100))} · ${w.bills_per_day} bills`} />
              ))}
            </div>
          </div>

          <div className="rounded-md border border-rule-strong bg-paper-2 p-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
                Next seven days
              </p>
              <span className={d.forecast.week_rupees == null
                ? "text-sm font-semibold"
                : "num text-sm font-semibold"}>
                {d.forecast.week_rupees == null
                  ? "not enough history yet"
                  : inr(Math.round(d.forecast.week_rupees * 100))}
              </span>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
              {d.forecast.days.map((f: any) => (
                <div key={f.date} className="flex justify-between gap-2 text-sm">
                  <span className="text-ink-soft">{f.weekday.slice(0, 3)}</span>
                  <span className="num">
                    {f.rupees == null ? "—" : inr(Math.round(f.rupees * 100))}
                  </span>
                </div>
              ))}
            </div>
            <p className="mt-2 text-xs text-ink-faint">
              {d.forecast.method}. Plan buying and rosters against this, not
              against a flat daily average.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
                Bill sizes
              </p>
              <ul className="mt-1 space-y-0.5 text-sm">
                {d.tickets.map((t: any) => (
                  <li key={t.label} className="flex justify-between gap-2">
                    <span className="text-ink-soft">{t.label}</span>
                    <span className="num">
                      {t.bills} · {t.share_percent}%
                    </span>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
                How they order
              </p>
              <ul className="mt-1 space-y-0.5 text-sm">
                {d.order_types.map((o: any) => (
                  <li key={o.name} className="flex justify-between gap-2">
                    <span className="truncate text-ink-soft">{o.name}</span>
                    <span className="num">
                      {inr(Math.round(o.rupees * 100))} · {o.share_percent}%
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </>
      )}
    </Card>
  );
}

function Move({ pct }: { pct: number | null }) {
  if (pct == null) return <span className="text-ink-faint">—</span>;
  const Icon = pct > 0 ? ArrowUp : pct < 0 ? ArrowDown : Minus;
  const tone = pct > 0 ? "text-bad" : pct < 0 ? "text-good" : "text-ink-faint";
  return (
    <span className={`num inline-flex items-center gap-0.5 ${tone}`}>
      <Icon className="h-3.5 w-3.5" />{Math.abs(pct)}%
    </span>
  );
}

/**
 * What you buy, from whom, how often, and at what price.
 *
 * The price column is the point: a supplier rarely announces a rise, so
 * the only way to catch one is to keep the first and last price you paid
 * side by side.
 */
export function PurchasePatterns({ start, end, outletId }: {
  start: string; end: string; outletId: number | null;
}) {
  const [showAll, setShowAll] = useState(false);
  const q = useQuery({
    queryKey: ["patterns-purchases", start, end, outletId],
    queryFn: () => api.get(`/patterns/purchases${qs(start, end, outletId)}`),
  });
  const d = q.data;
  const findings: Finding[] = d?.findings ?? [];
  const items = d?.items ?? [];
  const shown = showAll ? items : items.slice(0, 8);
  const catMax = Math.max(1, ...(d?.categories ?? []).map((c: any) => c.rupees));
  const venMax = Math.max(1, ...(d?.vendors ?? []).map((v: any) => v.rupees));

  return (
    <Card className="space-y-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SectionLabel>What you buy</SectionLabel>
        {d && (
          <span className="text-xs text-ink-faint">
            <span className="num">{inr(Math.round(d.totals.rupees * 100))}</span> over{" "}
            <span className="num">{d.totals.entries}</span> purchases ·{" "}
            <span className="num">{d.totals.items_price_tracked}</span> items priced
          </span>
        )}
      </div>

      {q.isLoading && <Spinner label="Reading the books…" />}
      {q.isError && <ErrorNote msg="Couldn't read your purchase history." />}

      {d && d.totals.entries === 0 ? (
        <p className="py-4 text-sm text-ink-faint">
          No purchases logged in this period.
        </p>
      ) : d && (
        <>
          <FindingList findings={findings} />

          <div className="grid gap-5 sm:grid-cols-2">
            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
                Where the money goes
              </p>
              {d.categories.slice(0, 8).map((c: any) => (
                <Bar key={c.name} value={c.rupees} max={catMax} label={c.name}
                     right={`${inr(Math.round(c.rupees * 100))} · ${c.share_percent}%`} />
              ))}
            </div>
            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
                Who you buy from
              </p>
              {d.vendors.slice(0, 8).map((v: any) => (
                <Bar key={v.name} value={v.rupees} max={venMax} label={v.name}
                     right={`${inr(Math.round(v.rupees * 100))} · ${v.orders} orders`} />
              ))}
            </div>
          </div>

          {items.length > 0 && (
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
                Item by item
              </p>
              {/* Keyboard focus is required to scroll this labelled region without a pointer. */}
              {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
              <div role="region" tabIndex={0} aria-label="Item-by-item purchase pattern table"
                   className="mt-1 overflow-x-auto rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
                <table className="w-full min-w-[34rem] text-sm">
                  <thead className="text-xs text-ink-faint">
                    <tr className="border-b border-rule text-left">
                      <th className="py-1 pr-2 font-medium">Item</th>
                      <th className="py-1 px-2 text-right font-medium">Spent</th>
                      <th className="py-1 px-2 text-right font-medium">Bought</th>
                      <th className="py-1 px-2 text-right font-medium">Every</th>
                      <th className="py-1 px-2 text-right font-medium">First</th>
                      <th className="py-1 px-2 text-right font-medium">Now</th>
                      <th className="py-1 pl-2 text-right font-medium">Move</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((i: any) => (
                      <tr key={i.item} className="border-b border-rule/60">
                        <td className="py-1.5 pr-2">
                          {i.item}
                          {i.unit && <span className="text-ink-faint"> /{i.unit}</span>}
                        </td>
                        <td className="num py-1.5 px-2 text-right">
                          {inr(Math.round(i.rupees * 100))}
                        </td>
                        <td className="num py-1.5 px-2 text-right">
                          {i.times_bought}×
                        </td>
                        <td className="num py-1.5 px-2 text-right text-ink-soft">
                          {i.avg_days_between == null
                            ? "—" : `${i.avg_days_between}d`}
                        </td>
                        <td className="num py-1.5 px-2 text-right text-ink-soft">
                          {inr(Math.round(i.first_unit_price_rupees * 100))}
                        </td>
                        <td className="num py-1.5 px-2 text-right">
                          {inr(Math.round(i.last_unit_price_rupees * 100))}
                        </td>
                        <td className="py-1.5 pl-2 text-right">
                          <Move pct={i.change_percent} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {items.length > 8 && (
                <button type="button"
                        onClick={() => setShowAll((s) => !s)}
                        className="mt-2 text-sm font-medium text-accent hover:underline">
                  {showAll ? "Show fewer" : <>Show all <span className="num">{items.length}</span> items</>}
                </button>
              )}
              <p className="mt-2 text-xs text-ink-faint">
                Prices are per {items[0]?.unit || "unit"} where you recorded a
                quantity. Log quantities on expenses to track more of them.
              </p>
            </div>
          )}
        </>
      )}
    </Card>
  );
}
