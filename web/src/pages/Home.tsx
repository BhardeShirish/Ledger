import { useOutletContext } from "react-router-dom";
import { CalendarCheck, Check, CircleDollarSign, ClipboardList, IndianRupee, Lock, Package } from "lucide-react";
import { Link } from "react-router-dom";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { useAuth } from "../lib/auth";
import { fmtDate, inr, todayISO } from "../lib/format";
import { Badge, Button, Card, SectionLabel, Spinner } from "../components/ui";

type Ctx = { outletId: number };

export default function Home() {
  const { outletId } = useOutletContext<Ctx>();
  const { me } = useAuth();
  const today = todayISO();
  const q = useQuery({
    queryKey: ["home", outletId, today],
    queryFn: () => api.get(`/stats/home?date=${today}`),
    refetchInterval: 60_000,
  });
  const inv = useQuery({
    enabled: Boolean(outletId),
    queryKey: ["brief-inv", outletId],
    queryFn: () => api.get(`/inventory/overview?outlet_id=${outletId}`),
    refetchInterval: 120_000,
  });
  const closeInbox = useQuery({
    enabled: me?.role === "owner" && Boolean(outletId),
    queryKey: ["close-inbox-home", outletId, today.slice(0, 7)],
    queryFn: () => api.get(`/control/close-inbox?outlet_id=${outletId}&month=${today.slice(0, 7)}`),
  });
  const intelligence = useQuery({
    enabled: me?.role === "owner" && Boolean(outletId),
    queryKey: ["intelligence-brief", outletId, today],
    queryFn: () => api.get(`/intelligence/brief?outlet_id=${outletId}&as_of=${today}`),
  });

  const outlets = q.data?.outlets ?? [];
  const mine = outlets.find((o: any) => o.outlet_id === outletId);
  const dailySteps = mine ? steps(mine) : [];
  const remaining = dailySteps.filter((step) => !step.optional && !step.done).length;

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">
          Good {greeting()}, {me?.full_name?.split(" ")[0] || me?.username}
        </h1>
        <p className="mt-1 text-sm text-ink-soft">Today · {fmtDate(today)}</p>
      </header>

      {q.isLoading && <Spinner label="Loading today's progress…" />}

      {q.isError && (
        <div role="alert" className="rounded-lg border border-bad/30 bg-paper p-4">
          <h2 className="font-semibold">{mine ? "Today's progress may be out of date" : "Couldn't load today's progress"}</h2>
          <p className="mt-1 text-sm text-ink-soft">
            {mine ? "Showing the last loaded figures. " : ""}
            Check your connection and try again. You can still open a daily task below.
          </p>
          <Button variant="outline" className="mt-3" disabled={q.isFetching} onClick={() => void q.refetch()}>
            {q.isFetching ? "Retrying…" : "Retry today's progress"}
          </Button>
          {!mine && (
            <nav aria-label="Daily tasks" className="mt-3 flex flex-wrap gap-2">
              {[
                ["/staff/attendance", "Mark attendance"], ["/sales", "Enter sales"],
                ["/money/expenses", "Log expenses"], ["/money/cash", "Close the day"],
              ].map(([to, label]) => (
                <Link key={to} to={to} className="inline-flex min-h-11 items-center rounded-md border border-rule-strong px-3 text-sm font-medium text-accent">
                  {label}
                </Link>
              ))}
            </nav>
          )}
        </div>
      )}

      {q.isSuccess && !mine && (
        <Card className="p-6 text-center">
          <p className="font-medium">{outletId ? "No progress available for this outlet" : "No outlet assigned yet"}</p>
          <p className="mt-1 text-sm text-ink-faint">
            {outletId
              ? "Try another outlet using the selector above, or ask the owner to check your outlet access."
              : me?.role === "owner"
              ? "Add your restaurant in Settings to start recording the day."
              : "Ask the owner to give you access to an outlet, then sign in again."}
          </p>
          {me?.role === "owner" && (
            <Link to="/settings"
                  className="mt-3 inline-block rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white">
              Open Settings
            </Link>
          )}
        </Card>
      )}

      {mine && (
        <>
          {/* The daily flow. This is the whole point of the page, so it is the
              only place today's figures appear — they used to be repeated in
              stat tiles and again in phone-only buttons directly beneath, three
              renderings of the same two numbers stacked on top of each other. */}
          <section aria-labelledby="daily-round-heading">
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <h2 id="daily-round-heading" className="text-lg font-semibold">Your daily round</h2>
              <span className="text-sm text-ink-soft">
                {remaining ? `${remaining} of 3 daily tasks left` : "Daily round complete"}
              </span>
            </div>
            <Card className="divide-y divide-rule overflow-hidden">
              {dailySteps.map((s) => (
                <FlowRow key={s.n} {...s} next={s.n === nextStep(mine)} />
              ))}
            </Card>
            {!remaining && <p className="mt-2 text-sm text-good">Attendance and sales recorded. Cash counted, day closed.</p>}
          </section>

          <div className="grid grid-cols-2 gap-3">
            <Link to="/inventory"
                  className="rounded-lg border border-rule-strong bg-paper px-4 py-3 hover:bg-paper-3/50">
              <div className="flex items-center gap-1.5 text-sm font-semibold">
                <Package size={15} className="text-ink-faint" /> Inventory
              </div>
              <div className="mt-0.5 text-xs text-ink-faint">
                {inv.isError ? "Stock check unavailable · open to retry"
                  : inv.isPending ? "Checking stock…"
                  : inv.data?.below_min_count
                  ? `${inv.data.below_min_count} items running low`
                  : (inv.data?.items ?? []).some((item: any) =>
                    item.intelligence_confidence === "insufficient")
                  ? "stock evidence incomplete"
                  : "no supported reorder risks"}
              </div>
            </Link>
            <Link to="/brief"
                  className="rounded-lg border border-rule-strong bg-paper px-4 py-3 hover:bg-paper-3/50">
              <div className="flex items-center gap-1.5 text-sm font-semibold">
                <ClipboardList size={15} className="text-ink-faint" /> Today's brief
              </div>
              <div className="mt-0.5 text-xs text-ink-faint">
                {intelligence.data?.feed?.[0]?.title ?? "one-glance summary"}
              </div>
            </Link>
          </div>
        </>
      )}

      {!q.isLoading && (
        <section aria-labelledby="follow-up-heading" className="space-y-3 border-t border-rule pt-5">
          <h2 id="follow-up-heading" className="text-lg font-semibold">Earlier days &amp; follow-up</h2>
          <CatchUpCard outletId={outletId} />
          {me?.role === "owner" && closeInbox.isError && (
            <p role="status" className="text-sm text-ink-soft">
              Month-close review is unavailable. <Link to="/reports" className="inline-flex min-h-11 items-center text-accent underline">Open reports</Link>
            </p>
          )}
          {me?.role === "owner" && closeInbox.data?.items?.length > 0 && (
            <Link to="/reports" className="block rounded-lg border border-amber-300/70 bg-amber-50/40 px-4 py-3 hover:bg-amber-50">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold">Month-close review</span>
                <Badge tone={closeInbox.data.blockers ? "bad" : "warn"}>
                  {closeInbox.data.blockers || closeInbox.data.items.length} need attention
                </Badge>
              </div>
              <p className="mt-1 text-sm text-ink-soft">Resolve cash, split-payment, stock, payroll and supplier exceptions before closing the month.</p>
            </Link>
          )}
        </section>
      )}
    </div>
  );
}

/** The four jobs of a day, in the order they happen. */
export function steps(mine: any) {
  return [
    {
      n: 1, done: mine.attendance.done, title: "Mark attendance",
      detail: mine.attendance.done
        ? `All ${mine.attendance.total} marked`
        : `${mine.attendance.marked}/${mine.attendance.total} marked${mine.attendance.open ? ` · ${mine.attendance.open} awaiting out-time` : ""}`,
      to: `/staff/attendance?date=${todayISO()}`,
      icon: <CalendarCheck size={18} />,
    },
    {
      n: 2, done: mine.sales.done, title: "Enter sales",
      detail: mine.sales.rupees_paise > 0
        ? `${inr(mine.sales.rupees_paise)} recorded` : "Not yet entered",
      to: "/sales", icon: <IndianRupee size={18} />,
    },
    {
      n: 3, optional: true, done: (mine.expenses.count ?? 0) > 0,
      title: "Log expenses",
      detail: `${mine.expenses.count} today · ${inr(mine.expenses.total_paise ?? 0)} total`,
      to: "/money/expenses", icon: <CircleDollarSign size={18} />,
    },
    {
      n: 4, done: !!mine.closed, title: "Close the day",
      detail: mine.closed ? "Cash counted, day closed"
                          : "Count the drawer when shutting shop",
      to: "/money/cash", icon: <Lock size={18} />,
    },
  ];
}

/** The first job that still needs doing, skipping optional ones — so the page
 *  always points at exactly one thing to do next, at every screen width. */
export function nextStep(mine: any): number | null {
  const s = steps(mine).find((x) => !x.done && !x.optional);
  return s ? s.n : null;
}

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "morning" : h < 17 ? "afternoon" : "evening";
}

type Gap = { date: string; outlet: string; type: string; detail: string; link: string };

/** Past days that were never filled in, so they can be caught up on. */
function CatchUpCard({ outletId }: Ctx) {
  const [showAll, setShowAll] = useState(false);
  const q = useQuery({
    queryKey: ["missing-logs", outletId, todayISO()],
    queryFn: () => api.get("/insights/missing-logs?days=14"),
  });
  const gaps: Gap[] = q.data ?? [];
  if (q.isLoading) return <p role="status" className="text-sm text-ink-soft">Checking the previous 14 days…</p>;
  if (q.isError) return (
    <div role="status" className="flex flex-wrap items-center gap-2 text-sm text-ink-soft">
      <span>Couldn't check earlier days.</span>
      <Button variant="outline" size="sm" disabled={q.isFetching} onClick={() => void q.refetch()}>Retry earlier days</Button>
    </div>
  );
  if (gaps.length === 0) return <p className="text-sm text-ink-soft">No missing logs found in the previous 14 days.</p>;

  const byDate = gaps.reduce<Record<string, Gap[]>>((acc, g) => {
    (acc[g.date] ??= []).push(g);
    return acc;
  }, {});
  const dates = Object.keys(byDate).sort().reverse();
  const shown = showAll ? dates : dates.slice(0, 3);

  return (
    <Card className="overflow-hidden border-amber-300/70">
      <div className="flex items-center justify-between border-b border-rule bg-amber-50/60 px-4 py-2.5">
        <SectionLabel>Still to fill in</SectionLabel>
        <Badge tone="warn">{dates.length} {dates.length === 1 ? "day" : "days"}</Badge>
      </div>
      <div className="divide-y divide-rule">
        {shown.map((d) => (
          <div key={d} className="px-4 py-2.5">
            <div className="text-sm font-medium">{fmtDate(d)}</div>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {byDate[d].map((g) => (
                <Link key={g.type + g.outlet} to={`${g.link}?date=${g.date}`}
                      className="inline-flex min-h-11 items-center gap-1 rounded-md border border-accent/40 bg-accent/5 px-3 py-2 text-sm font-medium text-accent hover:border-accent hover:bg-accent/10">
                  {g.detail}
                  {byDate[d].some((x) => x.outlet !== g.outlet) && ` · ${g.outlet}`}
                  <span aria-hidden="true">→</span>
                </Link>
              ))}
            </div>
          </div>
        ))}
      </div>
      {dates.length > 3 && (
        <button onClick={() => setShowAll(!showAll)}
                aria-expanded={showAll}
                className="min-h-11 w-full border-t border-rule px-4 py-2 text-sm text-ink-soft hover:text-accent">
          {showAll ? "Show fewer days" : `Show ${dates.length - 3} more days`}
        </button>
      )}
      <p className="border-t border-rule px-4 py-2 text-xs text-ink-faint">
        Days older than the edit window will ask for the owner password.
      </p>
    </Card>
  );
}

function FlowRow({ n, done, title, detail, to, icon, optional, next }: {
  n: number; done: boolean; title: string; detail: string; to: string;
  icon: React.ReactNode; optional?: boolean; next?: boolean;
}) {
  return (
    <Link to={to}
          aria-current={next ? "step" : undefined}
          className={`flex items-center gap-3 px-4 py-3.5 ${
            next ? "bg-accent-soft/60 hover:bg-accent-soft" : "hover:bg-paper-3/50"}`}>
      {/* Keep the step number even when a step is optional: a checklist that
          reads 1, 2, ·, 4 looks like something failed to load. */}
      <span className={`num flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold ${
        done ? "border-good bg-good/10 text-good"
        : next ? "border-accent bg-accent text-white"
        : optional ? "border-dashed border-rule-strong text-ink-faint" : "border-rule-strong text-ink-faint"}`}>
        {done ? <><Check size={15} aria-hidden="true" /><span className="sr-only">Completed:</span></> : n}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-medium leading-tight">
          {title}
          {optional && <span className="ml-1.5 text-xs font-normal text-ink-faint">optional</span>}
          {next && <span className="ml-1.5 text-xs font-semibold text-accent">do this next</span>}
        </span>
        <span className="mt-1 block text-sm text-ink-soft">{detail}</span>
      </span>
      <span aria-hidden="true" className={done ? "text-good" : next ? "text-accent" : "text-ink-faint"}>{icon}</span>
    </Link>
  );
}
