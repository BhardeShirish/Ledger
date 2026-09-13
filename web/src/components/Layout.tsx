import { clsx } from "clsx";
import { useQueryClient } from "@tanstack/react-query";
import {
  BarChart3, CalendarCheck, ChevronDown, CircleDollarSign, ClipboardList,
  CloudOff, Home, IndianRupee, Lock, LogOut, Menu, Package,
  Settings, type LucideIcon,
} from "lucide-react";
import { createContext, Suspense, useCallback, useContext, useEffect, useRef, useState } from "react";
import { Link, Outlet, useBlocker, useLocation, useNavigate } from "react-router-dom";
import {
  flushOutbox, getOutbox, removeOutbox, subscribeOutbox,
} from "../lib/outbox";
import { api } from "../api/client";
import { clearCachedMe, useAuth } from "../lib/auth";
import { fmtDate, todayISO } from "../lib/format";
import { useMoney } from "../lib/money";
import { Button, Select, Sheet, Spinner } from "./ui";
import OnboardingGuide, { OnboardingGuideTrigger } from "./OnboardingGuide";

type OutletRow = { id: number; name: string; is_active?: boolean };
type DirtyDraft = { label: string; discard: () => void };

const DraftGuardContext = createContext<{
  registerDirtyDraft: (draft: DirtyDraft | null) => void;
  requestDiscard: (action: () => void) => void;
}>({ registerDirtyDraft: () => {}, requestDiscard: (action) => action() });

/** Lets the current outlet page protect one meaningful, unsaved draft. */
export const useDraftGuard = () => useContext(DraftGuardContext);

const OUTLETS_CACHE = "ledger_outlets";

function usableOutlets(rows: unknown, permittedIds: number[]): OutletRow[] {
  if (!Array.isArray(rows)) return [];
  const permitted = new Set(permittedIds);
  return rows.filter((row): row is OutletRow => {
    if (!row || typeof row !== "object") return false;
    const outlet = row as OutletRow;
    return Number.isInteger(outlet.id) && outlet.id > 0
      && typeof outlet.name === "string" && outlet.name.trim().length > 0
      && outlet.is_active !== false && permitted.has(outlet.id);
  });
}

function storedOutletId(): number | null {
  try {
    const id = Number(localStorage.getItem("ledger_outlet"));
    return Number.isInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

function storeOutletId(id: number | null) {
  try {
    if (id === null) localStorage.removeItem("ledger_outlet");
    else localStorage.setItem("ledger_outlet", String(id));
  } catch { /* Selection remains valid even when browser storage is unavailable. */ }
}

// The bottom bar names the four things done every day. Naming the *action*
// matters: "Staff" made someone hunt for attendance, because the label
// described a filing cabinet rather than the job in front of them.
export const TABS = [
  { to: "/", label: "Home", icon: Home },
  { to: "/staff/attendance", label: "Attendance", icon: CalendarCheck },
  { to: "/sales", label: "Sales", icon: IndianRupee },
  { to: "/money/expenses", label: "Expenses", icon: CircleDollarSign },
];

/** Task-based workspaces. Every screen has one parent. */
export const GROUPS = [
  {
    key: "today", label: "Daily work", icon: ClipboardList,
    base: "/brief",
    children: [
      { to: "/brief", label: "Today’s brief" },
      { to: "/staff/attendance", label: "Attendance" },
      { to: "/sales", label: "Enter sales" },
      { to: "/money/expenses", label: "Expenses" },
      { to: "/money/cash", label: "Cash & close day" },
    ],
  },
  {
    key: "sales", label: "Sales & insights", icon: BarChart3,
    base: "/reports/analytics",
    children: [
      { to: "/reports/analytics", label: "Analytics & graphs" },
      { to: "/reports", label: "Monthly reports" },
      { to: "/sales/bills", label: "Bills & history" },
      { to: "/sales/import", label: "Import from POS", owner: true },
    ],
  },
  {
    key: "operations", label: "Suppliers & stock", icon: Package,
    base: "/inventory",
    children: [
      { to: "/inventory", label: "Inventory" },
      { to: "/money/vendors", label: "Suppliers" },
      { to: "/money/purchase-orders", label: "Purchase orders" },
      { to: "/money/unitprices", label: "What you pay per kg" },
      { to: "/money/bank", label: "Bank statement", owner: true },
    ],
  },
  {
    key: "staff", label: "Team & payroll", icon: CalendarCheck,
    base: "/staff/people",
    children: [
      { to: "/staff/people", label: "People" },
      { to: "/staff/shifts", label: "Shifts board" },
      { to: "/staff/payroll", label: "Payroll", owner: true },
      { to: "/staff/advances", label: "Advances", owner: true },
    ],
  },
];

/**
 * The groups as the phone's "Everything else" sheet shows them.
 *
 * Filtered by route, never by group. Dropping the whole "Every day" group
 * because the bottom bar "covers it" was wrong: the bar holds Home plus three
 * of its four children, so closing the day — the one job done at night, on a
 * phone, standing at the till — could not be reached at all. Removing exactly
 * the routes that have a tab means nothing can be stranded by association.
 *
 * Takes its inputs so the empty-group rule can be tested: with today's nav no
 * group is ever emptied, so a test using the real data proves nothing.
 */
export function mobileGroups(groups: typeof GROUPS = GROUPS, tabs: { to: string }[] = TABS) {
  const tabbed = new Set(tabs.map((t) => t.to));
  return groups
    .map((g) => ({ ...g, children: g.children.filter((c) => !tabbed.has(c.to)) }))
    .filter((g) => g.children.length > 0);
}

/** The sections below the grouped nav. Declared once so the desktop rail and
 *  the mobile "All sections" sheet cannot drift apart - keeping two copies is
 *  how three of these ended up sharing one icon. */
const SECTIONS: {
  to: string; label: string; icon: LucideIcon; owner?: boolean;
  match: (path: string) => boolean;
}[] = [
  {
    to: "/settings", label: "Settings", icon: Settings, owner: true,
    match: (p) => p.startsWith("/settings"),
  },
];

/**
 * Which nav entry owns a path.
 *
 * Decided by the longest matching child route, never by a bare prefix: /sales
 * opens "Every day" but /sales/bills belongs to "Sales records", and a prefix
 * test would hand both to whichever group was declared first. Returns the
 * winning child and its group, or undefined for pages outside the groups.
 */
export function ownerOf(pathname: string) {
  return GROUPS
    .flatMap((g) => g.children.map((c) => ({ g, c })))
    .filter(({ c }) => pathname === c.to || pathname.startsWith(c.to + "/"))
    .sort((a, b) => b.c.to.length - a.c.to.length)[0];
}

export default function Layout() {
  const { me, offline: authOffline, setMe } = useAuth();
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
  const permittedOutletIds = me?.outlet_ids;
  const [outlets, setOutlets] = useState<OutletRow[]>([]);
  const [outletStatus, setOutletStatus] = useState<"loading" | "ready" | "unavailable">("loading");
  const [outletId, setOutletId] = useState<number | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [outboxOpen, setOutboxOpen] = useState(false);
  const [apiError, setApiError] = useState("");
  const [errorSticky, setErrorSticky] = useState(false);
  const errorTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const [dirtyDraft, setDirtyDraft] = useState<DirtyDraft | null>(null);
  const dirtyDraftRef = useRef<DirtyDraft | null>(null);
  const [pendingDiscard, setPendingDiscard] = useState<(() => void) | null>(null);
  const bypassBlockerRef = useRef(false);
  const outletRequestRef = useRef(0);
  const [syncStatus, setSyncStatus] = useState("");
  const queryClient = useQueryClient();
  const nav = useNavigate();
  const loc = useLocation();
  const blocker = useBlocker(
    useCallback(
      () => Boolean(dirtyDraft) && !bypassBlockerRef.current,
      [dirtyDraft],
    ),
  );
  const registerDirtyDraft = useCallback((draft: DirtyDraft | null) => {
    dirtyDraftRef.current = draft;
    setDirtyDraft(draft);
  }, []);
  const requestDiscard = useCallback((action: () => void) => {
    if (dirtyDraftRef.current) setPendingDiscard(() => action);
    else action();
  }, []);
  const clearApiErrorTimer = useCallback(() => {
    if (errorTimerRef.current !== null) {
      window.clearTimeout(errorTimerRef.current);
      errorTimerRef.current = null;
    }
  }, []);
  const dismissApiError = useCallback(() => {
    clearApiErrorTimer();
    setApiError("");
    setErrorSticky(false);
  }, [clearApiErrorTimer]);

  // MoneyProvider sits above AuthProvider, so its first fetch happens on the
  // login screen and 401s. Layout only mounts once signed in, so refresh here
  // or the whole session runs on default currency/timezone/restaurant name.
  const { refresh: refreshMoney } = useMoney();
  useEffect(() => { void refreshMoney(); }, [refreshMoney]);

  // Accordion: the group owning the current path is open.
  const activeChild = ownerOf(loc.pathname);
  const activeGroup = activeChild?.g;
  const [openGroup, setOpenGroup] = useState<string | null>(activeGroup?.key ?? null);
  useEffect(() => {
    if (activeGroup) setOpenGroup(activeGroup.key);
  }, [activeGroup?.key]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setMobileMenuOpen(false);
    // A load error belongs to the page that requested it. Keeping it visible
    // after navigation makes a working screen look broken and obscures the
    // request that actually needs a retry.
    dismissApiError();
  }, [dismissApiError, loc.pathname]);

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
      clearApiErrorTimer();
      setApiError(d.message);
      setErrorSticky(d.sticky);
      if (!d.sticky) {
        const timer = window.setTimeout(() => {
          if (errorTimerRef.current !== timer) return;
          errorTimerRef.current = null;
          setApiError("");
          setErrorSticky(false);
        }, 6000);
        errorTimerRef.current = timer;
      }
    };
    window.addEventListener("ledger:api-error", showError);
    return () => {
      window.removeEventListener("ledger:api-error", showError);
      clearApiErrorTimer();
    };
  }, [clearApiErrorTimer]);

  const loadOutlets = useCallback(async () => {
    const request = ++outletRequestRef.current;
    setOutletStatus("loading");
    setOutlets([]);
    setOutletId(null);
    const resolve = (rows: unknown) => {
      if (request !== outletRequestRef.current) return;
      const available = usableOutlets(rows, permittedOutletIds ?? []);
      const saved = storedOutletId();
      const nextId = available.find((outlet) => outlet.id === saved)?.id ?? available[0]?.id;
      setOutlets(available);
      if (nextId) {
        storeOutletId(nextId);
        setOutletId(nextId);
        setOutletStatus("ready");
      } else {
        storeOutletId(null);
        setOutletId(null);
        setOutletStatus("unavailable");
      }
    };

    try {
      const rows = await api.get("/outlets");
      if (Array.isArray(rows)) {
        try {
          localStorage.setItem(OUTLETS_CACHE, JSON.stringify(rows));
        } catch { /* Cache storage is optional. */ }
      }
      resolve(rows);
    } catch {
      let cached: unknown = null;
      try {
        const raw = localStorage.getItem(OUTLETS_CACHE);
        cached = raw ? JSON.parse(raw) : null;
      } catch { /* A corrupt cache is not a source of outlet authority. */ }
      resolve(cached);
    }
  }, [permittedOutletIds]);

  useEffect(() => {
    void loadOutlets();
    return () => { outletRequestRef.current += 1; };
  }, [loadOutlets]);

  const pick = (id: number) => {
    requestDiscard(() => {
      if (!outlets.some((outlet) => outlet.id === id)) return;
      setOutletId(id);
      storeOutletId(id);
      window.dispatchEvent(new CustomEvent("outlet-changed", { detail: id }));
      nav("/");                     // switching outlet lands on Home
    });
  };
  const signOut = () => requestDiscard(() => {
    void (async () => {
      try {
        await api.post("/auth/logout");
      } catch {
        /* offline: clearing the local session below is what matters */
      }
      clearCachedMe();
      localStorage.removeItem(OUTLETS_CACHE);
      setMe(null);
      nav("/login", { replace: true });
    })();
  });
  if (me === null) return null;
  const current = outlets.find((outlet) => outlet.id === outletId);
  const outletReady = outletStatus === "ready" && current !== undefined;

  return (
    <DraftGuardContext.Provider value={{ registerDirtyDraft, requestDiscard }}>
    <div className="min-h-screen md:flex">
      <a href="#main-content" className="skip-link">Skip to main content</a>
      {/* Desktop rail */}
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-rule bg-paper px-3 py-4 md:flex">
        <div className="mb-4 px-2">
          <span className="text-sm text-ink-soft">Outlet</span>
          <OutletControl label="Outlet" status={outletStatus} current={current} outlets={outlets}
                         onPick={pick} className="mt-1 font-semibold" />
        </div>
        <nav aria-label="Main navigation" className="flex-1 space-y-1 overflow-y-auto">
          <RailLink to="/" label="Home" icon={Home} active={loc.pathname === "/"} />
          {GROUPS.filter((g) => g.children.some((c: any) => !c.owner || me.role === "owner"))
                 .map((g) => {
            const visible = g.children.filter((c: any) => !c.owner || me.role === "owner");
            const childActive = activeGroup?.key === g.key;
            const isOpen = openGroup === g.key;
            return (
              <div key={g.key}>
                <button
                  onClick={() => setOpenGroup(isOpen ? null : g.key)}
                  aria-expanded={isOpen}
                  aria-controls={`nav-${g.key}`}
                  className={clsx(
                    "flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm",
                    childActive ? "font-semibold text-accent hover:bg-paper-3" : "hover:bg-paper-3")}>
                  <g.icon size={17} strokeWidth={1.75}
                          className={childActive ? "text-accent" : "text-ink-faint"} />
                  <span className="flex-1 text-left">{g.label}</span>
                  <ChevronDown size={14}
                               className={clsx("transition-transform", isOpen && "rotate-180")} />
                </button>
                {isOpen && (
                  <div id={`nav-${g.key}`} className="ml-[15px] border-l border-rule pl-2">
                    {visible.map((c: any) => {
                      const a = activeChild?.c.to === c.to;
                      return (
                        <Link key={c.to} to={c.to}
                              aria-current={a ? "page" : undefined}
                              className={clsx(
                                "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm",
                                a ? "bg-accent-soft font-semibold text-accent"
                                  : "text-ink-soft hover:bg-paper-3")}>
                          <span className="flex-1">{c.label}</span>
                          {a && <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />}
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
        <OwnerBox onSignOut={signOut} />
      </aside>

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top bar */}
        <header className="sticky top-0 z-30 flex items-center justify-between gap-2 border-b border-rule bg-paper px-4 py-2.5 md:px-8">
          <div className="min-w-0 flex-1 md:hidden">
            <OutletControl label="Switch outlet" status={outletStatus} current={current} outlets={outlets}
                           onPick={pick}
                           className="max-w-64 border-transparent bg-paper-3 px-3 font-semibold" />
          </div>
          <div className="hidden text-sm text-ink-soft md:block">{fmtDate(todayISO())}</div>
          <div className="flex shrink-0 items-center gap-2">
            {outbox.length > 0 && (
              <button onClick={() => setOutboxOpen(true)}
                      title="Review entries waiting to sync"
                      className="inline-flex min-h-11 items-center gap-1 rounded-md bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">
                <CloudOff size={12} /> {outbox.length} pending
              </button>
            )}
            <LockHint />
            {outletReady && <OnboardingGuideTrigger />}
            <button onClick={() => nav("/settings/account")}
                    aria-label={`Account for ${me.full_name || me.username}`}
                    className="inline-flex min-h-11 max-w-24 items-center rounded-md bg-paper-3 px-3 py-1.5 text-sm font-medium sm:max-w-48">
              <span className="truncate">{me.full_name || me.username}</span>
            </button>
          </div>
        </header>

        <main id="main-content" tabIndex={-1} className="app-main mx-auto w-full max-w-5xl flex-1 px-4 pt-4 pb-[calc(3.5rem+env(safe-area-inset-bottom))] md:px-8 md:pb-0">
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
                            dismissApiError();
                            void queryClient.refetchQueries({ type: "active" });
                          }}>
                    Retry
                  </button>
                  <button aria-label="Dismiss" className="shrink-0 opacity-60 hover:opacity-100"
                          onClick={dismissApiError}>✕</button>
                </>
              )}
            </div>
          )}
          {/* Pages read outletId from this context and put it straight into
              their API calls, so rendering before /outlets resolves fires
              outlet_id=0 (or a stale id) and 403s on every first login. */}
          {outletReady ? (
            <Suspense fallback={<Spinner label="Loading page…" />}>
              <Outlet context={{ outletId: current.id }} />
            </Suspense>
          ) : outletStatus === "loading"
            ? <Spinner label="Loading outlets…" />
            : <OutletUnavailable offline={isOffline} onRetry={loadOutlets} />}
        </main>
      </div>

      {/* Mobile bottom tabs */}
      <nav aria-label="Daily navigation" className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-rule-strong bg-paper md:hidden"
           style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
        {TABS.map(({ to, label, icon: Icon }) => {
          const active = to === "/" ? loc.pathname === "/"
                                    : activeChild?.c.to === to;
          return (
            <Link key={to} to={to}
              aria-current={active ? "page" : undefined}
              className={clsx(
                "flex min-h-14 flex-col items-center justify-center gap-0.5 py-2 text-[11px] font-medium",
                active ? "bg-accent-soft text-accent" : "text-ink-soft")}>
              <Icon size={20} strokeWidth={1.75} />
              {label}
            </Link>
          );
        })}
        <button onClick={() => setMobileMenuOpen(true)}
                aria-haspopup="dialog"
                aria-expanded={mobileMenuOpen}
                className={clsx(
                  "flex min-h-11 flex-col items-center justify-center gap-0.5 py-2 text-[11px] font-medium",
                  // Highlight whenever the current page isn't one of the four
                  // daily tabs, so the bar never shows nothing selected.
                  SECTIONS.some((s) => s.match(loc.pathname))
                    || (loc.pathname !== "/"
                        && !TABS.some((t) => activeChild?.c.to === t.to))
                    ? "bg-accent-soft text-accent" : "text-ink-soft",
                )}>
          <Menu size={20} strokeWidth={1.75} />
          More
        </button>
      </nav>
      {outletReady && (
        <OnboardingGuide isOwner={me.role === "owner"} outletId={current.id}
                         outletName={current.name} fullName={me.full_name}
                         username={me.username} />
      )}
      <Sheet open={mobileMenuOpen} onClose={() => setMobileMenuOpen(false)}
             title="Everything else">
        {/* The bottom bar holds Home and three daily jobs. Everything else in
            the app has to be reachable from here, or a phone user simply
            cannot get to the cash count, payroll, suppliers or the bank
            statement at all. */}
        <div className="space-y-4">
          {mobileGroups()
                 .filter((g) => g.children.some((c: any) => !c.owner || me.role === "owner"))
                 .map((g) => (
            <div key={g.key}>
              <div className="label-caps mb-1.5 flex items-center gap-1.5">
                <g.icon size={13} strokeWidth={1.75} className="text-ink-faint" />
                {g.label}
              </div>
              <div className="grid grid-cols-2 gap-2">
                {g.children
                  .filter((c: any) => !c.owner || me.role === "owner")
                  .map((c: any) => (
                    <Link key={c.to} to={c.to}
                          aria-current={activeChild?.c.to === c.to ? "page" : undefined}
                          onClick={() => setMobileMenuOpen(false)}
                          className={clsx("rounded-md border border-rule-strong px-3 py-3 text-sm font-semibold hover:bg-paper-3",
                            activeChild?.c.to === c.to && "bg-accent-soft text-accent")}>
                      {c.label}
                    </Link>
                  ))}
              </div>
            </div>
          ))}
          <div>
            <div className="label-caps mb-1.5">Settings</div>
            <div className="grid grid-cols-2 gap-2">
              {SECTIONS
                .filter((s) => !s.owner || me.role === "owner")
                .map(({ to, label, icon: Icon, match }) => (
                  <Link key={to} to={to}
                        aria-current={match(loc.pathname) ? "page" : undefined}
                        onClick={() => setMobileMenuOpen(false)}
                        className={clsx("flex items-center gap-2 rounded-md border border-rule-strong px-3 py-3 text-sm font-semibold hover:bg-paper-3",
                          match(loc.pathname) && "bg-accent-soft text-accent")}>
                    <Icon size={16} strokeWidth={1.75} className="shrink-0 text-ink-faint" />
                    {label}
                  </Link>
                ))}
            </div>
          </div>
          <OwnerBox onSignOut={() => { setMobileMenuOpen(false); signOut(); }} />
        </div>
      </Sheet>
      <Sheet open={outboxOpen} onClose={() => setOutboxOpen(false)}
             title="Offline entries">
        <div className="space-y-2">
          {outbox.map((item) => (
            <div key={item.id} className="rounded-md border border-rule p-3 text-sm">
              <div className="font-medium">{item.summary}</div>
              <div className="text-xs text-ink-faint">
                Queued {new Date(item.ts).toLocaleString("en-IN")} · outlet {item.outletId ?? "not specified"}
              </div>
              {item.error && <div className="mt-1 text-xs text-bad">{item.error}</div>}
              <OutboxDiscard item={item} onDiscard={() => removeOutbox(item.id)} />
            </div>
          ))}
          {syncStatus && <p role="status" className="text-xs text-ink-soft">{syncStatus}</p>}
          <Button className="w-full" disabled={isOffline}
                  onClick={async () => {
                    const count = await flushOutbox();
                    setSyncStatus(count
                      ? `Synced ${count} queued entr${count === 1 ? "y" : "ies"}.`
                      : "Nothing synced yet. Check the error shown on each entry.");
                  }}>
            {isOffline ? "Reconnect to retry" : "Retry now"}
          </Button>
        </div>
      </Sheet>
    </div>
    {(pendingDiscard || blocker.state === "blocked") && (
      <Sheet open onClose={() => {
        if (blocker.state === "blocked") blocker.reset();
        setPendingDiscard(null);
      }} title="Keep unsaved work?">
        <div className="space-y-4">
          <p className="text-sm text-ink-soft">
            Your {dirtyDraft?.label ?? "draft"} has unsaved changes. Keep working, or discard it and continue.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => {
              if (blocker.state === "blocked") blocker.reset();
              setPendingDiscard(null);
            }}>Keep working</Button>
            <Button variant="danger" onClick={() => {
              dirtyDraft?.discard();
              const action = pendingDiscard;
              dirtyDraftRef.current = null;
              setDirtyDraft(null);
              setPendingDiscard(null);
              if (blocker.state === "blocked") blocker.proceed();
              else if (action) {
                bypassBlockerRef.current = true;
                action();
                queueMicrotask(() => { bypassBlockerRef.current = false; });
              }
            }}>Discard &amp; continue</Button>
          </div>
        </div>
      </Sheet>
    )}
    </DraftGuardContext.Provider>
  );
}

function OutletControl({ label, status, current, outlets, onPick, className }: {
  label: string;
  status: "loading" | "ready" | "unavailable";
  current: OutletRow | undefined;
  outlets: OutletRow[];
  onPick: (id: number) => void;
  className?: string;
}) {
  if (!current) {
    return (
      <div role="status" aria-live="polite"
           className={clsx("outlet-identity flex min-h-11 w-full items-center rounded-md text-sm text-ink-faint", className)}>
        {status === "loading" ? "Loading outlets…" : "Outlet unavailable"}
      </div>
    );
  }
  if (outlets.length === 1) {
    return (
      <div className={clsx("outlet-identity flex min-h-11 w-full items-center rounded-md text-sm", className)}>
        <span className="sr-only">Current outlet: </span>
        <span className="truncate">{current.name}</span>
      </div>
    );
  }
  return (
    <Select aria-label={label} value={current.id}
            onChange={(event) => onPick(Number(event.target.value))}
            className={clsx("min-h-11", className)}>
      {outlets.map((outlet) => (
        <option key={outlet.id} value={outlet.id}>{outlet.name}</option>
      ))}
    </Select>
  );
}

function OutletUnavailable({ offline, onRetry }: { offline: boolean; onRetry: () => void }) {
  return (
    <section role="alert" aria-labelledby="outlet-unavailable-heading"
             className="mx-auto flex max-w-md flex-col items-start gap-3 py-14">
      <div>
        <h1 id="outlet-unavailable-heading" className="text-xl font-semibold">Outlet unavailable</h1>
        <p className="mt-1 text-sm text-ink-soft">
          {offline
            ? "Reconnect, then retry so Ledger can confirm an active outlet for this session."
            : "Ledger could not confirm an active outlet you can use. Retry, or ask the owner to check your outlet access."}
        </p>
      </div>
      <Button variant="outline" onClick={onRetry}>Retry outlets</Button>
    </section>
  );
}

function RailLink({ to, label, icon: Icon, active }: any) {
  return (
    <Link to={to}
          aria-current={active ? "page" : undefined}
          className={clsx("flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm",
            active ? "bg-accent-soft font-semibold text-accent" : "hover:bg-paper-3")}>
      {Icon && <Icon size={17} strokeWidth={1.75}
                     className={active ? "text-accent" : "text-ink-faint"} />}
      <span className="flex-1">{label}</span>
      {active && <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />}
    </Link>
  );
}

function OutboxDiscard({ item, onDiscard }: { item: { id: string; summary: string }; onDiscard: () => void }) {
  const [confirming, setConfirming] = useState(false);
  return confirming ? (
    <div className="mt-2 space-y-2 border-t border-rule pt-2">
      <p className="text-xs text-ink-soft">Discard “{item.summary}”? It will not sync later.</p>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={() => setConfirming(false)}>Keep entry</Button>
        <Button variant="danger" size="sm" onClick={onDiscard}>Discard entry</Button>
      </div>
    </div>
  ) : (
    <Button variant="ghost" size="sm" className="mt-2" onClick={() => setConfirming(true)}>
      Discard
    </Button>
  );
}

function OwnerBox({ onSignOut }: { onSignOut: () => void }) {
  const { me } = useAuth();
  if (!me) return null;
  return (
    <div className="border-t border-rule pt-3">
      <div className="px-2 pb-2 text-xs text-ink-faint">
        Signed in as <span className="font-semibold text-ink">{me.username}</span> ({me.role})
      </div>
      {me.role !== "owner" && (
        <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-ink-faint">
          <Lock size={13} /> Salary areas are owner-only
        </div>
      )}
      <button
        onClick={onSignOut}
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
  return (
    <span role="status" aria-label={`Owner mode: ${elevated ? "unlocked" : "locked"}`}
          className={clsx("inline-flex items-center gap-1 text-xs font-medium",
            elevated ? "text-good" : "text-ink-faint")}>
      <Lock size={15} aria-hidden="true" />
      Owner: {elevated ? "unlocked" : "locked"}
    </span>
  );
}
