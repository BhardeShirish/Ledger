import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { Card, ErrorNote, SectionLabel } from "./ui";
import { FindingList, type Finding } from "./Findings";

const money = (n: number) => "₹" + Math.round(n).toLocaleString("en-IN");

/** Colour by how a ratio sits against its healthy band.
 *
 * "unlogged" is deliberately grey rather than green. A 2% food cost is
 * not an achievement, it is a gap in the book, and colouring it green is
 * the single most expensive thing this page could do. */
const TONE: Record<string, string> = {
  over: "text-bad",
  high: "text-accent",
  good: "text-good",
  low: "text-ink",
  unlogged: "text-ink-faint",
  unknown: "text-ink-faint",
};

const WORD: Record<string, string> = {
  over: "too high",
  high: "over band",
  good: "healthy",
  low: "under band",
  unlogged: "not logged",
  unknown: "no data",
};

/** A ratio drawn against its healthy band, so "is this normal?" is
 *  answered by position rather than by remembering a benchmark. */
function BandBar({ pct, low, high, status }: {
  pct: number | null; low: number; high: number; status: string;
}) {
  // Scale to a little past the band so an overspend still fits on screen.
  const span = Math.max(high * 1.6, (pct ?? 0) * 1.15, 1);
  const at = (v: number) => `${Math.min((v / span) * 100, 100)}%`;
  const known = pct != null && status !== "unlogged" && status !== "unknown";
  return (
    <div className="relative h-2 rounded-full bg-paper-3">
      <div className="absolute inset-y-0 rounded-full bg-good/25"
           style={{ left: at(low), width: `calc(${at(high)} - ${at(low)})` }} />
      {pct != null && (
        <div className={`absolute -top-0.5 h-3 w-[3px] rounded-full ${
              known ? "bg-ink" : "bg-ink-faint"}`}
             style={{ left: at(pct) }} />
      )}
    </div>
  );
}

function Row({ line }: { line: any }) {
  const pct = line.percent_of_net;
  return (
    <tr className="border-b border-rule/60 align-middle">
      <td className="py-2 pr-2">
        <div className="font-medium">{line.label}</div>
        {line.note && (
          <div className="text-xs text-ink-faint">{line.note}</div>
        )}
      </td>
      <td className="py-2 px-2 text-right tabular-nums">{money(line.rupees)}</td>
      <td className={`py-2 px-2 text-right tabular-nums font-semibold ${TONE[line.status]}`}>
        {pct == null ? "—" : `${pct}%`}
      </td>
      <td className="hidden py-2 px-2 sm:table-cell sm:w-32">
        <BandBar pct={pct} low={line.band_low} high={line.band_high}
                 status={line.status} />
      </td>
      <td className="py-2 pl-2 text-right text-xs text-ink-soft whitespace-nowrap">
        <span className={TONE[line.status]}>{WORD[line.status] ?? line.status}</span>
        <span className="text-ink-faint"> · {line.band_low}–{line.band_high}%</span>
      </td>
    </tr>
  );
}

/** A number the page has chosen not to guess at. */
function Unknown({ why }: { why: string }) {
  return (
    <div className="rounded-md border border-dashed border-rule-strong bg-paper-2 p-3">
      <p className="text-sm font-semibold text-ink-soft">Not shown yet</p>
      <p className="mt-0.5 text-xs text-ink-faint">{why}</p>
    </div>
  );
}

function Stat({ label, value, hint }: {
  label: string; value: string; hint?: string;
}) {
  return (
    <div className="rounded-md border border-rule bg-paper-2 p-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
        {label}
      </p>
      <p className="mt-0.5 text-lg font-semibold tabular-nums">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-ink-faint">{hint}</p>}
    </div>
  );
}

/**
 * The month read the way an operator reads it: costs as a share of net
 * sales, against the bands a healthy restaurant sits in.
 *
 * Prime cost — food plus labour — leads, because those are the only large
 * costs that can be changed this week. Rent cannot be renegotiated on a
 * Tuesday; tomorrow's order and tomorrow's roster can.
 */
export function ProfitAndLoss({ month, outletId }: {
  month: string; outletId: number | null;
}) {
  const q = useQuery({
    queryKey: ["pnl", month, outletId],
    queryFn: () => api.get(
      `/pnl/summary?month=${month}` + (outletId ? `&outlet_id=${outletId}` : "")),
  });
  const d = q.data;
  const findings: Finding[] = d?.findings ?? [];
  const hasSales = (d?.sales?.net_rupees ?? d?.sales?.total_rupees ?? 0) > 0;
  // A manual daily total can prove revenue but cannot prove how many bills
  // made it. Prefer the explicit new contract, while accepting older servers.
  const billDetailsAvailable = d?.sales?.bill_metrics_available ??
    d?.sales?.bill_details_available ??
    d?.sales?.has_bill_details ?? d?.sales?.bills_known ??
    (d?.per_bill?.bills != null && d?.per_bill?.net_rupees != null);
  const perBillKnown = billDetailsAvailable && d?.per_bill?.profit_rupees != null;
  const sensitivity = billDetailsAvailable ? (d?.sensitivity ?? []) :
    (d?.sensitivity ?? []).filter((s: any) => !/bill|average/i.test(`${s.lever} ${s.how}`));

  return (
    <Card className="space-y-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SectionLabel>Where the money went</SectionLabel>
        {d && (
          <span className="text-xs text-ink-faint">
            {money(d.sales.net_rupees)} net sales · {d.measured_on}
            {d.period.partial && ` · ${d.period.days_counted} of ${d.period.days_in_month} days`}
          </span>
        )}
      </div>

      {q.isLoading && (
        <div className="py-6 text-sm text-ink-faint">Reading the books…</div>
      )}
      {q.isError && <ErrorNote msg="Couldn't work out this month's costs." />}

      {d && !hasSales ? (
        <p className="py-4 text-sm text-ink-faint">
          No sales recorded for this month yet.
        </p>
      ) : d && (
        <>
          <FindingList findings={findings} />

          <div className="overflow-x-auto">
            <table className="w-full min-w-[26rem] text-sm">
              <thead className="text-xs text-ink-faint">
                <tr className="border-b border-rule text-left">
                  <th className="py-1 pr-2 font-medium">Cost</th>
                  <th className="py-1 px-2 text-right font-medium">Spent</th>
                  <th className="py-1 px-2 text-right font-medium">% of sales</th>
                  <th className="hidden py-1 px-2 font-medium sm:table-cell">
                    Healthy band
                  </th>
                  <th className="py-1 pl-2 text-right font-medium">Verdict</th>
                </tr>
              </thead>
              <tbody>
                {d.lines.map((l: any) => <Row key={l.key} line={l} />)}
                <tr className="border-b-2 border-rule-strong bg-paper-2 align-middle">
                  <td className="py-2 pr-2">
                    <div className="font-semibold">Prime cost</div>
                    <div className="text-xs text-ink-faint">
                      Food and labour — the two you can change this week.
                    </div>
                  </td>
                  <td className="py-2 px-2 text-right tabular-nums font-semibold">
                    {money(d.prime_cost.rupees)}
                  </td>
                  <td className={`py-2 px-2 text-right tabular-nums font-semibold ${
                        TONE[d.prime_cost.status]}`}>
                    {d.prime_cost.percent_of_net == null
                      ? "—" : `${d.prime_cost.percent_of_net}%`}
                  </td>
                  <td className="hidden py-2 px-2 sm:table-cell">
                    <BandBar pct={d.prime_cost.percent_of_net}
                             low={d.prime_cost.band_low}
                             high={d.prime_cost.band_high}
                             status={d.prime_cost.status} />
                  </td>
                  <td className="py-2 pl-2 text-right text-xs whitespace-nowrap">
                    <span className={TONE[d.prime_cost.status]}>
                      {WORD[d.prime_cost.status] ?? d.prime_cost.status}
                    </span>
                    <span className="text-ink-faint">
                      {" "}· under {d.prime_cost.band_high}%
                    </span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            {d.totals.profit_known ? (
              <>
                <Stat label="Left over" value={money(d.totals.profit_rupees)}
                      hint={`${d.totals.profit_percent_of_net}% of net sales`} />
                {perBillKnown ? (
                  <>
                    <Stat label="Per bill"
                          value={money(d.per_bill.profit_rupees)}
                          hint={`from a ${money(d.per_bill.net_rupees)} average bill`} />
                    <Stat label="Break even"
                          value={d.breakeven.possible
                            ? `${d.breakeven.bills_per_day} bills/day` : "—"}
                          hint={d.breakeven.possible
                            ? `you serve ${d.breakeven.actual_bills_per_day} a day`
                            : d.breakeven.why} />
                  </>
                ) : (
                  <div className="sm:col-span-2">
                    <Unknown why="Per-bill and break-even figures need bill-level sales details. Daily sales totals do not provide a bill count." />
                  </div>
                )}
              </>
            ) : (
              <div className="sm:col-span-3">
                <Unknown why={d.totals.profit_unknown_why} />
              </div>
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
                What each move is worth
              </p>
              <ul className="mt-1 space-y-1.5">
                {sensitivity.map((s: any) => (
                  <li key={s.lever} className="text-sm">
                    <div className="flex justify-between gap-2">
                      <span>{s.lever}</span>
                      <span className="shrink-0 tabular-nums font-semibold text-good">
                        {money(s.monthly_rupees)}
                      </span>
                    </div>
                    <p className="text-xs text-ink-faint">{s.how}</p>
                  </li>
                ))}
              </ul>
            </div>

            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
                Food cost, last {d.rolling_food_cost.days} days
              </p>
              <p className="mt-1 text-sm">
                <span className="text-lg font-semibold tabular-nums">
                  {d.rolling_food_cost.percent_of_net == null
                    ? "—" : `${d.rolling_food_cost.percent_of_net}%`}
                </span>
                <span className="text-ink-faint">
                  {" "}({money(d.rolling_food_cost.cogs_rupees)} of{" "}
                  {money(d.rolling_food_cost.net_rupees)})
                </span>
              </p>
              <p className="mt-1 text-xs text-ink-faint">
                A rolling window, because one bulk order near a month end
                spikes that month and hollows out the next.
              </p>
              <p className="mt-2 text-xs text-ink-faint">
                Wages come from your staff list: {d.payroll.headcount} people,{" "}
                {money(d.payroll.monthly_rupees)} a month
                {d.payroll.prorated && ", counted pro rata for the days so far"}.
              </p>
            </div>
          </div>

          {d.budgets.length > 0 && (
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
                Against your budgets
              </p>
              <ul className="mt-1 space-y-0.5 text-sm">
                {d.budgets.map((b: any) => (
                  <li key={b.category} className="flex justify-between gap-2">
                    <span className="truncate text-ink-soft">{b.category}</span>
                    <span className={`shrink-0 tabular-nums ${
                          b.over ? "text-bad" : "text-ink"}`}>
                      {money(b.spent_rupees)} of {money(b.budget_rupees)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </Card>
  );
}
