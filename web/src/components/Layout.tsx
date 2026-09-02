import { clsx } from "clsx";
import { useQueryClient } from "@tanstack/react-query";
import {
  BarChart3, CalendarCheck, ChevronDown, CircleDollarSign, ClipboardList,
  CloudOff, Home, IndianRupee, LayoutDashboard, Lock, LogOut, Menu, Package,
  Settings, type LucideIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";
import {
  flushOutbox, getOutbox, removeOutbox, subscribeOutbox,
} from "../lib/outbox";
import { api } from "../api/client";
import { clearCachedMe, useAuth } from "../lib/auth";
import { fmtDate, todayISO } from "../lib/format";
import { useMoney } from "../lib/money";
import { Button, Sheet, Spinner } from "./ui";

type OutletRow = { id: number; name: string };

const OUTLETS_CACHE = "ledger_outlets";

const TABS = [
  { to: "/", label: "Home", icon: Home },
  { to: "/sales", label: "Sales", icon: IndianRupee },
  { to: "/staff/attendance", label: "Staff", icon: CalendarCheck },
  { to: "/money/expenses", label: "Money", icon: CircleDollarSign },
];

/** Accordion model for the desktop rail: parents stay collapsed; the open
 *  group reveals its children. One open group at a time. */
const GROUPS = [
  {
    key: "sales", label: "Sales", icon: IndianRupee, base: "/sales",
    children: [
      { to: "/sales", label: "Day sheet" },
      { to: "/sales/bills", label: "Bills & history" },
      { to: "/sales/import", label: "Petpooja import", owner: true },
    ],
  },
  {
    key: "staff", label: "Staff", icon: CalendarCheck, base: "/staff/attendance",
    children: [
      { to: "/staff/attendance", label: "Attendance" },
      { to: "/staff/people", label: "People" },
      { to: "/staff/shifts", label: "Shifts board" },
      { to: "/staff/payroll", label: "Payroll", owner: true },
      { to: "/staff/advances", label: "Advances", owner: true },
    ],
  },
  {
    key: "money", label: "Money", icon: CircleDollarSign, base: "/money/expenses",
    children: [
      { to: "/money/expenses", label: "Expenses" },
      { to: "/money/vendors", label: "Vendors" },
      { to: "/money/cash", label: "Cash register" },
      { to: "/money/unitprices", label: "Unit prices" },
      { to: "/money/bank", label: "Bank statement", owner: true },
    ],
  },
];

/** The sections below the grouped nav. Declared once so the desktop rail and
 *  the mobile "All sections" sheet cannot drift apart - keeping two copies is
 *  how three of these ended up sharing one icon. */
const SECTIONS: {
  to: string; label: string; icon: LucideIcon; owner?: boolean;
  match: (path: string) => boolean;
}[] = [
  {
    to: "/inventory", label: "Inventory", icon: Package,
    match: (p) => p.startsWith("/inventory"),
  },
  {
    to: "/brief", label: "Daily Brief", icon: ClipboardList,
    match: (p) => p.startsWith("/brief"),
  },
  {
    to: "/reports", label: "Dashboard", icon: LayoutDashboard,
    match: (p) => p.startsWith("/reports") && !p.includes("analytics"),
  },
  {
    to: "/reports/analytics", label: "Deep analysis", icon: BarChart3,
    match: (p) => p.includes("analytics"),
  },
  {
    to: "/settings", label: "Settings", icon: Settings, owner: true,
    match: (p) => p.startsWith("/settings"),
  },
];

export default function Layout() {
  const { me, offline: authOffline } = useAuth();
  const [navOnline, setNavOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const up = () => setNavOnline(true);
    const down = () => setNavOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);
  const isOffline = !navOnline || authOffline;
  const [outlets, setOutlets] = useState<OutletRow[]>([]);
  const [outletsLoaded, setOutletsLoaded] = useState(false);
  const [outletId, setOutletId] = useState<number>(() =>
    Number(localStorage.getItem("ledger_outlet") || 0));
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [outboxOpen, setOutboxOpen] = useState(false);
  const [apiError, setApiError] = useState("");
  const [errorSticky, setErrorSticky] = useState(false);
  const queryClient = useQueryClient();
  const nav = useNavigate();
  const loc = useLocation();

  // MoneyProvider sits above AuthProvider, so its first fetch happens on the
  // login screen and 401s. Layout only mounts once signed in, so refresh here
  // or the whole session runs on default currency/timezone/restaurant name.
  const { refresh: refreshMoney } = useMoney();
  useEffect(() => { void refreshMoney(); }, [refreshMoney]);

  // accordion: the group owning the current path is open
  const activeGroup = GROUPS.find((g) => loc.pathname.startsWith(g.base + "/")
    || (loc.pathname === g.base && g.base !== "/money/expenses")
    || loc.pathname.startsWith(g.key === "sales" ? "/sales" : `/${g.key}`));
  const [openGroup, setOpenGroup] = useState<string | null>(activeGroup?.key ?? null);
  useEffect(() => {
    if (activeGroup) setOpenGroup(activeGroup.key);
  }, [activeGroup?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  // offline outbox: flush when we come back online / every minute
  const [outbox, setOutbox] = useState(getOutbox());
  useEffect(() => {
    setOutbox(getOutbox());
    const unsub = subscribeOutbox(() => setOutbox(getOutbox()));
    const onOnline = () => { void flushOutbox(); };
    window.addEventListener("online", onOnline);
    const t = setInterval(onOnline, 60_000);
    return () => { window.removeEventListener("online", onOnline); clearInterval(t); unsub(); };
  }, []);
  useEffect(() => {
    const showError = (event: Event) => {
      const d = (event as CustomEvent<{ message: string; sticky: boolean }>).detail;
      setApiError(d.message);
      if (!d.sticky) window.setTimeout(() => setApiError(""), 6000);
      setErrorSticky(d.sticky);
    };
    window.addEventListener("ledger:api-error", showError);
    return () => window.removeEventListener("ledger:api-error", showError);
  }, []);

  useEffect(() => {
    api.get("/outlets").then((rows) => {
      setOutlets(rows);
      localStorage.setItem(OUTLETS_CACHE, JSON.stringify(rows));
      if (!rows.find((r: OutletRow) => r.id === outletId) && rows.length) {
        pick(rows[0].id);
      }
    }).catch(() => {
      // Offline the outlet name would otherwise be blank in the header while
      // entries are still being filed against its id, which reads like the
      // app has lost track of which outlet you are in.
      try {
        const cached = localStorage.getItem(OUTLETS_CACHE);
        if (cached) setOutlets(JSON.parse(cached));
      } catch { /* a corrupt cache must not block the app */ }
    }).finally(() => setOutletsLoaded(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pick = (id: number) => {
    setOutletId(id);
    localStorage.setItem("ledger_outlet", String(id));
    window.dispatchEvent(new CustomEvent("outlet-changed", { detail: id }));
    setSwitcherOpen(false);
    nav("/");                       // switching outlet lands on Home
  };
  if (me === null) return null;
  const current = outlets.find((o) => o.id === outletId);

  return (
    <div className="min-h-screen md:flex">
      {/* Desktop rail */}
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-rule bg-paper px-3 py-4 md:flex">
        <div className="relative mb-4">
          <button
            onClick={() => outlets.length > 1 && setSwitcherOpen(!switcherOpen)}
            aria-expanded={switcherOpen}
            className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-paper-3">
            <div>
              <div className="text-[11px] uppercase tracking-[0.14em] text-ink-faint">Outlet</div>
              <div className="flex items-center gap-1 font-semibold">
                {current?.name ?? "…"}
                {outlets.length > 1 && <ChevronDown size={14} />}
              </div>
            </div>
          </button>
          {switcherOpen && (
            <div className="absolute inset-x-0 top-full z-40 mt-1 rounded-md border border-rule-strong bg-paper p-1 shadow-sheet">
              {outlets.map((outlet) => (
                <button key={outlet.id} onClick={() => pick(outlet.id)}
                        className={clsx(
                          "w-full rounded px-2 py-2 text-left text-sm hover:bg-paper-3",
                          outlet.id === outletId && "font-semibold text-accent",
                        )}>
                  {outlet.name}
                </button>
              ))}
            </div>
          )}
        </div>
        <nav className="flex-1 space-y-1 overflow-y-auto">
          <RailLink to="/" label="Home" icon={Home}
                    active={loc.pathname === "/"} />
          {GROUPS.filter((g) => g.children.some((c: any) => !c.owner || me.role === "owner"))
                 .map((g) => {
            const visible = g.children.filter((c: any) => !c.owner || me.role === "owner");
            const childActive = visible.some((c: any) =>
              c.to === g.base ? loc.pathname === c.to : loc.pathname.startsWith(c.to));
            const isOpen = openGroup === g.key;
            return (
              <div key={g.key}>
                <button
                  onClick={() => {
                    setOpenGroup(isOpen ? null : g.key);
                    nav(g.base);
                  }}
                  className={clsx(
                    "flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm",
                    childActive ? "font-semibold text-accent" : "hover:bg-paper-3")}>
                  <g.icon size={17} strokeWidth={1.75}
                          className={childActive ? "text-accent" : "text-ink-faint"} />
                  <span className="flex-1 text-left">{g.label}</span>
                  {childActive && <span className="h-1.5 w-1.5 rounded-full bg-accent" />}
                  <ChevronDown size={14}
                               className={clsx("transition-transform", isOpen && "rotate-180")} />
                </button>
                {isOpen && (
                  <div className="ml-[15px] border-l border-rule pl-2">
                    {visible.map((c: any) => {
                      const a = c.to === g.base
                        ? loc.pathname === c.to
                        : loc.pathname.startsWith(c.to);
                      return (
                        <Link key={c.to} to={c.to}
                              className={clsx(
                                "block rounded-md px-2 py-1.5 text-sm",
                                a ? "bg-accent-soft font-semibold text-accent"
                                  : "text-ink-soft hover:bg-paper-3")}>
                          {c.label}
                        </Link>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
          <div className="!mt-3 space-y-1 border-t border-rule pt-3">
            {SECTIONS
              .filter((s) => !s.owner || me.role === "owner")
              .map((s) => (
                <RailLink key={s.to} to={s.to} label={s.label} icon={s.icon}
                          active={s.match(loc.pathname)} />
              ))}
          </div>
        </nav>
        <OwnerBox />
      </aside>

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top bar */}
        <header className="sticky top-0 z-30 flex items-center justify-between border-b border-rule bg-paper/95 px-4 py-2.5 backdrop-blur md:px-8">
          <div className="md:hidden">
            <select
              value={outletId} onChange={(e) => pick(Number(e.target.value))}
              className="rounded-md bg-paper-3 px-2 py-1 text-sm font-semibold">
              {outlets.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </div>
          <div className="hidden text-sm text-ink-soft md:block">{fmtDate(todayISO())}</div>
          <div className="flex items-center gap-2">
            {outbox.length > 0 && (
              <button onClick={() => setOutboxOpen(true)}
                      title="Review entries waiting to sync"
                      className="inline-flex min-h-9 items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">
                <CloudOff size={12} /> {outbox.length} pending
              </button>
            )}
            <LockHint />
            <button onClick={() => nav("/settings/account")}
                    className="rounded-full bg-paper-3 px-3 py-1.5 text-sm font-medium">
              {me.full_name || me.username}
            </button>
          </div>
        </header>

        <main className="mx-auto w-full max-w-5xl flex-1 px-4 pb-24 pt-4 md:px-8 md:pb-10">
          {isOffline && (
            <div role="status"
                 className="mb-3 flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              <CloudOff size={15} className="mt-0.5 shrink-0" />
              <span className="min-w-0 flex-1">
                <strong className="font-semibold">You are offline.</strong>{" "}
                Figures on screen may be out of date. New sales, expenses and
                attendance are saved on this device and sent when you reconnect.
              </span>
            </div>
          )}
          {apiError && (
            <div role="alert" className="mb-3 flex items-center gap-3 rounded-md border border-bad/30 bg-bad/10 px-3 py-2 text-sm text-bad">
              <span className="min-w-0 flex-1">{apiError}</span>
              {errorSticky && (
                <>
                  <button className="shrink-0 font-medium underline"
                          onClick={() => {
                            setApiError("");
                            void queryClient.refetchQueries({ type: "active" });
                          }}>
                    Retry
                  </button>
                  <button aria-label="Dismiss" className="shrink-0 opacity-60 hover:opacity-100"
                          onClick={() => setApiError("")}>✕</button>
                </>
              )}
            </div>
          )}
          {/* Pages read outletId from this context and put it straight into
              their API calls, so rendering before /outlets resolves fires
              outlet_id=0 (or a stale id) and 403s on every first login. */}
          {outletsLoaded ? <Outlet context={{ outletId }} /> : <Spinner />}
        </main>
      </div>

      {/* Mobile bottom tabs */}
      <nav className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-rule-strong bg-paper/95 backdrop-blur md:hidden"
           style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
        {TABS.map(({ to, label, icon: Icon }) => {
          const active =
            to === "/" ? loc.pathname === "/"
          : to === "/sales" ? loc.pathname.startsWith("/sales")
          : to === "/staff/attendance" ? loc.pathname.startsWith("/staff")
          : to === "/money/expenses" ? loc.pathname.startsWith("/money")
          : false;
          return (
            <Link key={to} to={to}
              className={clsx(
                "flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium",
                active ? "text-accent" : "text-ink-faint")}>
              <Icon size={20} strokeWidth={1.75} />
              {label}
            </Link>
          );
        })}
        <button onClick={() => setMobileMenuOpen(true)}
                className={clsx(
                  "flex min-h-11 flex-col items-center justify-center gap-0.5 py-2 text-[11px] font-medium",
                  SECTIONS.some((s) => s.match(loc.pathname))
                    ? "text-accent" : "text-ink-faint",
                )}>
          <Menu size={20} strokeWidth={1.75} />
          More
        </button>
      </nav>
      <Sheet open={mobileMenuOpen} onClose={() => setMobileMenuOpen(false)}
             title="All sections">
        <div className="grid grid-cols-2 gap-2">
          {SECTIONS
            .filter((s) => !s.owner || me.role === "owner")
            .map(({ to, label, icon: Icon }) => (
              <Link key={to} to={to} onClick={() => setMobileMenuOpen(false)}
                    className="flex items-center gap-2 rounded-md border border-rule-strong px-3 py-3 text-sm font-semibold hover:bg-paper-3">
                <Icon size={16} strokeWidth={1.75} className="shrink-0 text-ink-faint" />
                {label}
              </Link>
            ))}
        </div>
      </Sheet>
      <Sheet open={outboxOpen} onClose={() => setOutboxOpen(false)}
             title="Offline entries">
        <div className="space-y-2">
          {outbox.map((item) => (
            <div key={item.id} className="rounded-md border border-rule p-3 text-sm">
              <div className="font-medium">{item.label}</div>
              <div className="text-xs text-ink-faint">
                {item.method} · outlet {item.outletId ?? "not specified"}
              </div>
              {item.error && <div className="mt-1 text-xs text-bad">{item.error}</div>}
              <Button variant="ghost" size="sm" className="mt-2"
                      onClick={() => removeOutbox(item.id)}>
                Discard
              </Button>
            </div>
          ))}
          <Button className="w-full" onClick={() => void flushOutbox()}>
            Retry now
          </Button>
        </div>
      </Sheet>
    </div>
  );
}

function RailLink({ to, label, icon: Icon, active }: any) {
  return (
    <Link to={to}
          className={clsx("flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm",
            active ? "bg-accent-soft font-semibold text-accent" : "hover:bg-paper-3")}>
      {Icon && <Icon size={17} strokeWidth={1.75}
                     className={active ? "text-accent" : "text-ink-faint"} />}
      {label}
    </Link>
  );
}

function OwnerBox() {
  const { me, setMe } = useAuth();
  const nav = useNavigate();
  if (!me) return null;
  return (
    <div className="border-t border-rule pt-3">
      <div className="px-2 pb-2 text-xs text-ink-faint">
        Signed in as <span className="font-semibold text-ink">{me.username}</span> ({me.role})
      </div>
      {me.role === "owner" ? (
        <button onClick={() => nav("/settings")}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-paper-3">
          <Settings size={15} /> Settings
        </button>
      ) : (
        <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-ink-faint">
          <Lock size={13} /> Salary areas are owner-only
        </div>
      )}
      <button
        onClick={async () => {
          // Sign out locally even if the server is unreachable, otherwise the
          // button does nothing on a phone with no signal and the cached
          // identity stays behind.
          try {
            await api.post("/auth/logout");
          } catch {
            /* offline: clearing the local session below is what matters */
          }
          clearCachedMe();
          localStorage.removeItem(OUTLETS_CACHE);
          setMe(null);
          nav("/login", { replace: true });
        }}
        className="mt-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-paper-3">
        <LogOut size={15} /> Sign out
      </button>
    </div>
  );
}

function LockHint() {
  const { me } = useAuth();
  const [, setTick] = useState(0);
  useEffect(() => {
    if (me?.role !== "owner") return;
    const t = setInterval(() => setTick((value) => value + 1), 30_000);
    return () => clearInterval(t);
  }, [me]);
  if (me?.role !== "owner") return null;
  const elevated = Boolean(
    me.elevated_until && new Date(me.elevated_until).getTime() > Date.now()
  );
  return elevated
    ? <span title="Owner mode unlocked" className="text-good"><Lock size={15} /></span>
    : <span title="Locked — password needed for old edits" className="text-ink-faint"><Lock size={15} /></span>;
}
