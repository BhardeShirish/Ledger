import { useOutletContext } from "react-router-dom";
import { CalendarCheck, CircleDollarSign, ClipboardList, IndianRupee, Lock, Package } from "lucide-react";
import { Link } from "react-router-dom";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { useAuth } from "../lib/auth";
import { fmtDate, inr, todayISO } from "../lib/format";
import { Badge, Card, SectionLabel, Spinner } from "../components/ui";

type Ctx = { outletId: number };

export default function Home() {
  const { outletId } = useOutletContext<Ctx>();
  const { me } = useAuth();
  const q = useQuery({
    queryKey: ["home", outletId],
    queryFn: () => api.get(`/stats/home?date=${todayISO()}`),
    refetchInterval: 60_000,
  });
  const inv = useQuery({
    queryKey: ["brief-inv", outletId],
    queryFn: () => api.get(`/inventory/overview?outlet_id=${outletId}`),
    refetchInterval: 120_000,
  });

  if (q.isLoading) return <Spinner />;
  const outlets = q.data?.outlets ?? [];
  const mine = outlets.find((o: any) => o.outlet_id === outletId) ?? outlets[0];

  return (
    <div className="space-y-5">
      <header>
        <SectionLabel>Today · {fmtDate(todayISO())}</SectionLabel>
        <h1 className="text-2xl font-semibold tracking-tight">
          Good {greeting()}, {me?.full_name?.split(" ")[0] || me?.username}
        </h1>
      </header>

      {!mine && (
        <Card className="p-6 text-center">
          <p className="font-medium">No outlet assigned yet</p>
          <p className="mt-1 text-sm text-ink-faint">
            {me?.role === "owner"
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

      <CatchUpCard />

      {mine && (
        <>
          {/* The daily flow. This is the whole point of the page, so it is the
              only place today's figures appear — they used to be repeated in
              stat tiles and again in phone-only buttons directly beneath, three
              renderings of the same two numbers stacked on top of each other. */}
          <Card className="divide-y divide-rule">
            {steps(mine).map((s) => (
              <FlowRow key={s.n} {...s} next={s.n === nextStep(mine)} />
            ))}
          </Card>

          <div className="grid grid-cols-2 gap-3">
            <Link to="/inventory"
                  className="rounded-lg border border-rule-strong bg-paper px-4 py-3 hover:bg-paper-3/50">
              <div className="flex items-center gap-1.5 text-sm font-semibold">
                <Package size={15} className="text-ink-faint" /> Inventory
              </div>
              <div className="mt-0.5 text-xs text-ink-faint">
                {inv.data?.below_min_count
                  ? `${inv.data.below_min_count} items running low`
                  : "stock healthy"}
              </div>
            </Link>
            <Link to="/brief"
                  className="rounded-lg border border-rule-strong bg-paper px-4 py-3 hover:bg-paper-3/50">
              <div className="flex items-center gap-1.5 text-sm font-semibold">
                <ClipboardList size={15} className="text-ink-faint" /> Today's brief
              </div>
              <div className="mt-0.5 text-xs text-ink-faint">one-glance summary</div>
            </Link>
          </div>
        </>
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
function CatchUpCard() {
  const [showAll, setShowAll] = useState(false);
  const q = useQuery({
    queryKey: ["missing-logs"],
    queryFn: () => api.get("/insights/missing-logs?days=14"),
  });
  const gaps: Gap[] = q.data ?? [];
  if (q.isLoading || gaps.length === 0) return null;

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
                      className="inline-flex items-center gap-1 rounded-md border border-accent/40 bg-accent/5 px-2 py-1 text-xs font-medium text-accent hover:border-accent hover:bg-accent/10">
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
                className="w-full border-t border-rule px-4 py-2 text-xs text-ink-faint hover:text-accent">
          {showAll ? "Show less" : `Show ${dates.length - 3} more`}
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
        {done ? "✓" : n}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-medium leading-tight">
          {title}
          {optional && <span className="ml-1.5 text-xs font-normal text-ink-faint">optional</span>}
          {next && <span className="ml-1.5 text-xs font-semibold text-accent">do this next</span>}
        </span>
        <span className="block truncate text-sm text-ink-faint">{detail}</span>
      </span>
      <span className={done ? "text-good" : next ? "text-accent" : "text-ink-faint"}>{icon}</span>
    </Link>
  );
}
