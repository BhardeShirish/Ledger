import { clsx } from "clsx";
import { useQueries } from "@tanstack/react-query";
import { ArrowRight, Check, CircleDashed, LifeBuoy, Minus } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Link, useLocation } from "react-router-dom";
import { api } from "../api/client";
import { inr, todayISO } from "../lib/format";
import { Button } from "./ui";

/**
 * v2 deliberately ignores the v1 key ("ledger_onboarding_v1").
 *
 * v1 stored steps a person had *asserted* were done, and hid itself the moment
 * a step link was followed. Both are claims about the books that the books
 * never made, so neither is carried forward: the records are the only source
 * of truth for progress, and storage now holds presentation only.
 */
export const GUIDE_STORAGE_KEY = "ledger_onboarding_v2";

/* ---------------------------------------------------------------- steps -- */

export type GuideStepDef = {
  key: string;
  title: string;
  /** Why the job matters, in the words of the person doing it. */
  why: string;
  /** The evidence Ledger will accept. Stated up front so no check is a mystery. */
  evidence: string;
  links: { to: string; label: string }[];
  /** Routes where this step is done. The guide steps aside on these pages. */
  routes: string[];
};

/**
 * The daily round, in the order the counter actually runs it.
 *
 * Owners get the outlet's own setup; a manager cannot edit it, so offering
 * that screen would be a dead end. Their first step is the one thing about
 * this session they *can* put right — the name on their own login.
 */
export function guideSteps(isOwner: boolean): GuideStepDef[] {
  const first: GuideStepDef = isOwner
    ? {
      key: "business",
      title: "Name the business and this outlet",
      why: "Every report, export and bill you hand over carries these two names, and the outlet decides which set of books an entry lands in.",
      evidence: "Counts as done when the business name and this outlet's name are your own, not the ones Ledger ships with.",
      links: [{ to: "/settings", label: "Business & outlet settings" }],
      routes: ["/settings"],
    }
    : {
      key: "account",
      title: "Put your own name on this login",
      why: "Your name is what the app header and the owner's user list show, so the entries you save can be told apart from anyone else's.",
      evidence: "Counts as done when this account has a full name of its own, not the login id.",
      links: [{ to: "/settings/account", label: "Your account" }],
      routes: ["/settings/account"],
    };

  return [
    first,
    {
      key: "team",
      title: "Add your people and put them on shifts",
      why: isOwner
        ? "Attendance, payroll and the shift board all read this one list, and nothing can be planned until someone sits on a shift."
        : "Attendance and the shift board read this one list. Only the owner can add a person, so check it and ask for anyone missing.",
      evidence: "Counts as done when this outlet has at least one working person, at least one shift exists, and at least one person is on a shift — a default shift or a weekly pattern.",
      links: [
        { to: "/staff/people", label: "People list" },
        { to: "/staff/shifts", label: "Shift board" },
      ],
      routes: ["/staff/people", "/staff/shifts"],
    },
    {
      key: "sales",
      title: "Record today's sales",
      why: "Profit, the analytics and the cash you should be holding tonight are all built from the day's sales sheet.",
      evidence: "Counts as done when today's sheet holds a typed amount or a POS import. Either one is enough.",
      links: [
        { to: "/sales", label: "Today's sales sheet" },
        ...(isOwner ? [{ to: "/sales/import", label: "Import from POS" }] : []),
      ],
      routes: isOwner ? ["/sales", "/sales/import"] : ["/sales"],
    },
    {
      key: "expenses",
      title: "Record what you spent today",
      why: "Money paid out is what turns takings into real profit, and cash payouts are what the drawer has to account for tonight.",
      evidence: "Counts as done when at least one expense is filed under today's date. If nothing was spent, this step stays open — Ledger will not claim an entry that is not there.",
      links: [{ to: "/money/expenses", label: "Expenses" }],
      routes: ["/money/expenses"],
    },
    {
      key: "close",
      title: "Count the cash and close the day",
      why: "Closing compares the drawer against what today's sales and payouts say should be in it. It is the check that catches a mistake tonight instead of next month.",
      evidence: "Counts as done when today's closure exists and has not been reopened.",
      links: [{ to: "/money/cash", label: "Cash & close day" }],
      routes: ["/money/cash"],
    },
  ];
}

/* ----------------------------------------------------------- validation -- */

/**
 * "checking" is not a soft "no": it means Ledger has not seen the answer yet
 * and is saying so, rather than guessing in either direction.
 */
export type CheckState = "checking" | "incomplete" | "verified";
export type StepCheck = { state: CheckState; detail: string };

/** One React Query result, reduced to what a check is allowed to know. */
export type Source = { data?: unknown; isPending?: boolean; isError?: boolean };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const records = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? v.filter(isRecord) : [];
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Names the shipped database carries until someone puts their own in. */
const SHIPPED_BUSINESS_NAME = "my restaurant";
const SHIPPED_OUTLET_NAME = "main outlet";

const UNREADABLE: StepCheck = {
  state: "checking",
  detail: "Ledger's answer for this check could not be read, so nothing is claimed either way.",
};

/**
 * Loading and failure are held apart from "not done".
 *
 * A check that cannot reach the server has learnt nothing about the books; if
 * it reported "incomplete" the guide would push a person to redo work already
 * saved, which is exactly the false claim this guide exists to avoid.
 */
export function settle(sources: Source[], compute: () => StepCheck): StepCheck {
  if (sources.some((s) => s.isError)) {
    return {
      state: "checking",
      detail: "Ledger did not answer this check. It runs again when you come back to this screen.",
    };
  }
  if (sources.some((s) => s.isPending)) {
    return { state: "checking", detail: "Checking your records…" };
  }
  return compute();
}

/** GET /outlets (outlet name) + GET /lists/money-config (business name). */
export function checkBusinessSetup(outletName: unknown, config: unknown): StepCheck {
  if (!isRecord(config)) return UNREADABLE;
  const business = text(config.restaurant_name);
  const outlet = text(outletName);
  const open: string[] = [];
  if (!business) open.push("the business has no name yet");
  else if (business.toLowerCase() === SHIPPED_BUSINESS_NAME) {
    open.push("the business is still called “My restaurant”");
  }
  if (!outlet) open.push("this outlet has no name yet");
  else if (outlet.toLowerCase() === SHIPPED_OUTLET_NAME) {
    open.push("the outlet is still called “Main Outlet”");
  }
  if (open.length > 0) {
    return { state: "incomplete", detail: `${open.join(", and ")}.` };
  }
  return { state: "verified", detail: `Filed as ${business} · ${outlet}.` };
}

/** GET /auth/me, already held by the signed-in session. */
export function checkAccountName(fullName: unknown, username: unknown): StepCheck {
  const name = text(fullName);
  const login = text(username);
  if (!name) {
    return {
      state: "incomplete",
      detail: login ? `This login still shows only as “${login}”.` : "This login has no name on it yet.",
    };
  }
  if (login && name.toLowerCase() === login.toLowerCase()) {
    return { state: "incomplete", detail: `The name here is still the login id “${login}”.` };
  }
  return { state: "verified", detail: `Signed in as ${name}.` };
}

/** GET /staff/employees?outlet_id=… and GET /staff/shifts. */
export function checkTeamAndShifts(
  employees: unknown, shifts: unknown, outletId?: number,
): StepCheck {
  if (!Array.isArray(employees) || !Array.isArray(shifts)) return UNREADABLE;
  const people = records(employees).filter(
    (e) => e.is_active !== false && text(e.working_status) !== "left",
  );
  const live = records(shifts).filter((s) =>
    s.is_active !== false && (outletId === undefined || s.outlet_id === undefined || s.outlet_id === outletId),
  );
  const liveIds = new Set(live.map((s) => num(s.id)).filter((id): id is number => id !== null));
  const rostered = people.filter(
    (p) => {
      const defaultShift = num(p.default_shift_id);
      return (defaultShift !== null && liveIds.has(defaultShift))
        || (Array.isArray(p.pattern) && records(p.pattern).some((r) => {
          const patternShift = num(r.shift_id);
          return patternShift !== null && liveIds.has(patternShift);
        }));
    },
  );
  if (people.length === 0) {
    return { state: "incomplete", detail: "Nobody is on this outlet's team list yet." };
  }
  if (live.length === 0) {
    return {
      state: "incomplete",
      detail: `${count(people.length, "person", "people")} listed, but no shift timings exist yet.`,
    };
  }
  if (rostered.length === 0) {
    return {
      state: "incomplete",
      detail: `${count(people.length, "person", "people")} and ${count(live.length, "shift", "shifts")} exist, but nobody is on a shift yet.`,
    };
  }
  return {
    state: "verified",
    detail: `${count(people.length, "person", "people")}, ${rostered.length} on a shift.`,
  };
}

/** GET /sales/sheet?outlet_id=…&date=<today in the outlet's timezone>. */
export function checkTodaysSales(sheet: unknown): StepCheck {
  if (!isRecord(sheet)) return UNREADABLE;
  const rows = records(Array.isArray(sheet.all_rows) ? sheet.all_rows : sheet.rows);
  const typed = rows.filter((r) => num(r.manual_amount_rupees) !== null);
  const imported = rows.filter((r) => isRecord(r.imported));
  if (typed.length === 0 && imported.length === 0) {
    return {
      state: "incomplete",
      detail: "Today's sheet is empty — no amount typed in and no POS import.",
    };
  }
  const bills = imported.reduce(
    (sum, r) => sum + (isRecord(r.imported) ? (num(r.imported.bills) ?? 0) : 0), 0,
  );
  const source = typed.length > 0 && imported.length > 0
    ? `a POS import (${count(bills, "bill", "bills")}) and a typed amount`
    : imported.length > 0
      ? `a POS import (${count(bills, "bill", "bills")})`
      : `${count(typed.length, "typed amount", "typed amounts")}`;
  const total = num(sheet.total_rupees);
  return {
    state: "verified",
    detail: total === null
      ? `Today's sheet holds ${source}.`
      : `${inr(Math.round(total * 100))} on today's sheet, from ${source}.`,
  };
}

/** GET /expenses?outlet_id=…&start=<today>&end=<today>. */
export function checkTodaysExpenses(payload: unknown): StepCheck {
  if (!isRecord(payload)) return UNREADABLE;
  const filed = num(payload.total) ?? records(payload.rows).length;
  if (filed <= 0) {
    return { state: "incomplete", detail: "No expense is filed under today's date yet." };
  }
  return {
    state: "verified",
    detail: `${count(filed, "expense", "expenses")} filed for today.`,
  };
}

/** GET /cash/day?outlet_id=…&date=<today>. */
export function checkDayClose(day: unknown): StepCheck {
  if (!isRecord(day)) return UNREADABLE;
  const closure = isRecord(day.closure) ? day.closure : null;
  if (!closure) {
    const expected = num(day.expected_paise);
    return {
      state: "incomplete",
      detail: expected === null
        ? "Today is not closed yet."
        : `Today is not closed yet — Ledger expects ${inr(expected)} in the drawer.`,
    };
  }
  if (closure.reopened === true) {
    return {
      state: "incomplete",
      detail: "Today's close was reopened, so it is no longer final. Count and close again.",
    };
  }
  const counted = num(closure.counted_paise);
  const variance = num(closure.variance_paise);
  if (counted === null || variance === null) {
    return { state: "verified", detail: "Today is closed." };
  }
  return {
    state: "verified",
    detail: variance === 0
      ? `Closed on ${inr(counted)} counted, matching the expected cash.`
      : `Closed on ${inr(counted)} counted, ${inr(Math.abs(variance))} ${variance > 0 ? "over" : "short"}.`,
  };
}

export type Evidence = {
  outletId?: number;
  outletName?: string;
  fullName?: string;
  username?: string;
  config: Source;
  people: Source;
  shifts: Source;
  sales: Source;
  expenses: Source;
  cash: Source;
};

/** Every step's state, decided only by records the API has actually returned. */
export function evaluateSteps(steps: GuideStepDef[], evidence: Evidence): StepCheck[] {
  return steps.map((step) => {
    switch (step.key) {
      case "business":
        return settle([evidence.config],
          () => checkBusinessSetup(evidence.outletName, evidence.config.data));
      case "account":
        return checkAccountName(evidence.fullName, evidence.username);
      case "team":
        return settle([evidence.people, evidence.shifts],
          () => checkTeamAndShifts(evidence.people.data, evidence.shifts.data, evidence.outletId));
      case "sales":
        return settle([evidence.sales], () => checkTodaysSales(evidence.sales.data));
      case "expenses":
        return settle([evidence.expenses], () => checkTodaysExpenses(evidence.expenses.data));
      case "close":
        return settle([evidence.cash], () => checkDayClose(evidence.cash.data));
      default:
        return UNREADABLE;
    }
  });
}

/** The step the person is on: the first one the records do not vouch for. */
export function currentStepIndex(checks: StepCheck[]): number {
  const index = checks.findIndex((check) => check.state !== "verified");
  return index === -1 ? checks.length : index;
}

export const isRouteInStep = (pathname: string, step: GuideStepDef) =>
  step.routes.some((route) => pathname === route || pathname.startsWith(`${route}/`));

/* --------------------------------------------------------- presentation -- */

/**
 * Presentation only — never progress.
 *
 * Whether the guide is showing, collapsed or put away is this browser's
 * business; whether a step is done is the books' business. Keeping the two
 * apart is what makes hiding the guide safe: there is no progress to lose,
 * because there was never any progress stored.
 */
type Presentation = { dismissed: boolean; minimized: boolean };
const DEFAULT_PRESENTATION: Presentation = { dismissed: false, minimized: false };

let presentation: Presentation = DEFAULT_PRESENTATION;
let loaded = false;
let trigger: HTMLButtonElement | null = null;
let pill: HTMLButtonElement | null = null;
let focusIntent: "panel" | "pill" | null = null;
const listeners = new Set<() => void>();

function readStored(): Presentation | null {
  try {
    const raw = localStorage.getItem(GUIDE_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    return {
      dismissed: parsed.dismissed === true,
      minimized: parsed.minimized === true,
    };
  } catch {
    return null;
  }
}

function writeStored(next: Presentation) {
  try {
    localStorage.setItem(GUIDE_STORAGE_KEY, JSON.stringify(next));
  } catch { /* A full or blocked store must not break the app. */ }
}

function announce() {
  for (const listener of listeners) listener();
}

function setPresentation(next: Partial<Presentation>, persist = true) {
  const base = snapshot();
  const merged = { ...base, ...next };
  if (merged.dismissed === base.dismissed && merged.minimized === base.minimized) return;
  presentation = merged;
  if (persist) writeStored(merged);
  announce();
}

/**
 * The browser's saved preference, read on the first render of a session.
 *
 * Reading it here rather than in an effect matters: the first navigation can
 * collapse the guide before any effect has run, and a preference loaded after
 * that would overwrite what the person had already chosen.
 */
function snapshot(): Presentation {
  if (!loaded) {
    loaded = true;
    presentation = readStored() ?? DEFAULT_PRESENTATION;
  }
  return presentation;
}

/** Signing out ends the session; the next one re-reads the browser. */
function forgetSession() {
  loaded = false;
  presentation = DEFAULT_PRESENTATION;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const usePresentation = () =>
  useSyncExternalStore(subscribe, snapshot, () => DEFAULT_PRESENTATION);

/** The way back in, from the header, at any time. */
export function OnboardingGuideTrigger({ className }: { className?: string }) {
  const { dismissed, minimized } = usePresentation();
  const open = !dismissed && !minimized;
  return (
    <button
      ref={(node) => { trigger = node; }}
      onClick={() => {
        if (open) setPresentation({ minimized: true });
        else {
          focusIntent = "panel";
          setPresentation({ dismissed: false, minimized: false });
        }
      }}
      aria-expanded={open}
      aria-controls={open ? "onboarding-guide" : undefined}
      aria-label="Getting started guide"
      className={clsx(
        "inline-flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-sm hover:bg-paper-3",
        open ? "text-accent" : "text-ink-soft",
        className,
      )}
    >
      <LifeBuoy size={16} aria-hidden="true" />
      <span aria-hidden="true" className="hidden sm:inline">Guide</span>
    </button>
  );
}

/* --------------------------------------------------------------- guide --- */

const GUIDE_QUERY = { retry: false, refetchOnWindowFocus: true, staleTime: 10_000 } as const;

/** React Query treats `undefined` as a failure; an empty body is not one. */
const load = async (path: string): Promise<unknown> => (await api.get(path)) ?? null;

/**
 * A walkthrough that checks the books instead of taking your word for it.
 *
 * It is a panel, not a modal: no backdrop, no focus trap, no blocked route.
 * Following a step's link keeps the walkthrough alive as a small pill above
 * the phone's navigation, so the form underneath stays uncovered and one tap
 * brings the guide back at the step still outstanding. Nothing about progress
 * is stored: every step is re-read from the API on navigation and on focus,
 * and a step turns green only when a record says so.
 */
export default function OnboardingGuide({
  isOwner, outletId, outletName, fullName, username,
}: {
  isOwner: boolean;
  outletId: number;
  outletName?: string;
  fullName?: string;
  username?: string;
}) {
  const { dismissed, minimized } = usePresentation();
  const { pathname } = useLocation();
  const panelRef = useRef<HTMLDivElement>(null);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  const steps = useMemo(() => guideSteps(isOwner), [isOwner]);
  const today = todayISO();
  const enabled = !dismissed && Number.isInteger(outletId) && outletId > 0;

  // Deliberately *not* the pages' own query keys: sharing a key with a page
  // that passes different parameters would hand that page this component's
  // request. The shared prefixes are enough — a page invalidating "expenses"
  // or "people" re-checks the guide too.
  const results = useQueries({
    queries: [
      {
        queryKey: ["money-config"],
        queryFn: () => load("/lists/money-config"),
        enabled: enabled && isOwner,
        ...GUIDE_QUERY,
      },
      {
        queryKey: ["people", outletId, "guide"],
        queryFn: () => load(`/staff/employees?outlet_id=${outletId}`),
        enabled,
        ...GUIDE_QUERY,
      },
      {
        queryKey: ["shifts", "guide"],
        queryFn: () => load("/staff/shifts"),
        enabled,
        ...GUIDE_QUERY,
      },
      {
        queryKey: ["sales-sheet", outletId, today],
        queryFn: () => load(`/sales/sheet?outlet_id=${outletId}&date=${today}`),
        enabled,
        ...GUIDE_QUERY,
      },
      {
        queryKey: ["expenses", outletId, "guide-day", today],
        queryFn: () => load(`/expenses?outlet_id=${outletId}&start=${today}&end=${today}&limit=1`),
        enabled,
        ...GUIDE_QUERY,
      },
      {
        queryKey: ["cash-day", outletId, today],
        queryFn: () => load(`/cash/day?outlet_id=${outletId}&date=${today}`),
        enabled,
        ...GUIDE_QUERY,
      },
    ],
  });

  const [config, people, shifts, sales, expenses, cash] = results;
  // Six pure reads of data already in hand: cheaper to redo than to memoise
  // against six query results that are new objects on every render.
  const checks = evaluateSteps(steps, {
    outletId, outletName, fullName, username,
    config: config!, people: people!, shifts: shifts!,
    sales: sales!, expenses: expenses!, cash: cash!,
  });

  const index = currentStepIndex(checks);
  const complete = index === steps.length;
  const currentKey = complete ? null : steps[index]!.key;

  // A step's link lands on the page that step is about. Covering that page
  // with the guide is how the previous version forced itself to be closed,
  // and closing it was what lost the walkthrough.
  const onStepRoute = steps.some((step) => isRouteInStep(pathname, step));
  useEffect(() => {
    if (onStepRoute) setPresentation({ minimized: true }, false);
  }, [pathname, onStepRoute]);

  // Records can change on another device, in another tab, or on the page just
  // left — which is exactly where a step is usually completed.
  const refetchRef = useRef(results);
  refetchRef.current = results;
  const lastPath = useRef(pathname);
  useEffect(() => {
    if (!enabled || lastPath.current === pathname) return;
    const wasStepRoute = steps.some((step) => isRouteInStep(lastPath.current, step));
    lastPath.current = pathname;
    if (!complete && wasStepRoute) {
      for (const result of refetchRef.current) void result.refetch();
    }
  }, [pathname, enabled, complete, steps]);

  // Signing out unmounts the shell. The guide must not be left hanging over
  // the login screen of the next person to sign in.
  useEffect(() => forgetSession, []);

  const open = !dismissed && !minimized;

  // Opening always resumes at the step still outstanding, never at whatever
  // happened to be expanded last time.
  useEffect(() => {
    if (open) setExpandedKey(currentKey);
  }, [open, currentKey]);

  const minimize = useCallback(() => {
    focusIntent = "pill";
    setPresentation({ minimized: true });
  }, []);

  // Escape belongs to whatever the person is actually in. Minimising the
  // guide from a sheet or a form somewhere else on the page would be a second,
  // invisible thing happening to a key they pressed for one reason.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (!panelRef.current?.contains(document.activeElement)) return;
      event.preventDefault();
      minimize();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, minimize]);

  // Focus follows a request and nothing else. The first appearance is not a
  // request: pulling a screen reader out of the page it just loaded, for a
  // panel nobody asked for, is the cost of an unrequested tour.
  useEffect(() => {
    if (focusIntent === "panel" && open) {
      focusIntent = null;
      panelRef.current?.focus();
    } else if (focusIntent === "pill" && !open && !dismissed) {
      focusIntent = null;
      pill?.focus();
    }
  }, [open, dismissed]);

  if (dismissed || !enabled) return null;

  const total = steps.length;
  const position = complete ? total : index + 1;
  const progress = complete
    ? `All ${total} checks pass`
    : `Step ${position} of ${total}`;

  if (!open) {
    return (
      <button
        ref={(node) => { pill = node; }}
        id="onboarding-guide-pill"
        onClick={() => {
          focusIntent = "panel";
          setPresentation({ minimized: false });
        }}
        aria-expanded={false}
        aria-label={complete
          ? `Getting started guide, all ${total} checks pass`
          : `Getting started guide, step ${position} of ${total}: ${steps[index]!.title}`}
        className={clsx(
          "fixed right-3 z-30 inline-flex min-h-11 max-w-[calc(100vw-1.5rem)] items-center gap-2",
          "bottom-[calc(3.5rem+env(safe-area-inset-bottom)+0.5rem)] md:bottom-4 md:right-4",
          "rounded-full border border-rule-strong bg-paper px-4 py-2 text-sm font-medium",
          "text-ink shadow-sheet hover:bg-paper-3",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
        )}
      >
        <LifeBuoy size={15} aria-hidden="true" className="shrink-0 text-accent" />
        <span aria-hidden="true" className="truncate">
          Guide · <span className="num">{progress}</span>
        </span>
      </button>
    );
  }

  return (
    <div
      id="onboarding-guide"
      ref={panelRef}
      tabIndex={-1}
      role="region"
      aria-labelledby="onboarding-guide-heading"
      className={clsx(
        "fixed inset-x-0 bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-30",
        "max-h-[70vh] overflow-y-auto border-t border-rule-strong bg-paper shadow-sheet",
        "focus-visible:outline-none md:inset-x-auto md:bottom-4 md:right-4 md:w-[23rem]",
        "md:rounded-xl md:border",
      )}
    >
      <div className="sticky top-0 flex items-start justify-between gap-3 border-b border-rule bg-paper px-4 py-3">
        <div className="min-w-0">
          <h2 id="onboarding-guide-heading" className="font-semibold">Getting started</h2>
          <p aria-live="polite" className="mt-0.5 text-xs text-ink-soft">
            <span className="num">{progress}</span>
            {" · "}
            {complete
              ? "checked against your records"
              : "checked against your records, never ticked off by hand"}
          </p>
        </div>
        <button
          onClick={minimize}
          aria-label="Minimise getting started"
          className="-mr-1 flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full text-ink-soft hover:bg-paper-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <Minus size={17} aria-hidden="true" />
        </button>
      </div>

      <ol className="px-2 py-2">
        {steps.map((step, stepIndex) => {
          const check = checks[stepIndex]!;
          const expanded = expandedKey === step.key;
          const status = check.state === "verified" ? "done"
            : check.state === "checking" ? "still being checked"
              : "not done yet";
          return (
            <li key={step.key} className="border-b border-rule last:border-b-0">
              <button
                onClick={() => setExpandedKey(expanded ? null : step.key)}
                aria-expanded={expanded}
                aria-controls={`onboarding-step-${step.key}`}
                className="flex w-full min-h-11 items-center gap-2.5 rounded-md px-2 py-2.5 text-left hover:bg-paper-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <span
                  aria-hidden="true"
                  className={clsx(
                    "num flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[11px] font-medium",
                    check.state === "verified" ? "border-good bg-good/10 text-good"
                      : check.state === "checking" ? "border-rule-strong text-ink-faint"
                        : expanded ? "border-accent text-accent"
                          : "border-rule-strong text-ink-faint",
                  )}
                >
                  {check.state === "verified" ? <Check size={12} strokeWidth={3} />
                    : check.state === "checking" ? <CircleDashed size={12} />
                      : stepIndex + 1}
                </span>
                <span className={clsx("min-w-0 flex-1 text-sm",
                  expanded ? "font-semibold text-ink" : "text-ink-soft")}>
                  {step.title}
                </span>
                <span className="sr-only">{` — ${status}`}</span>
              </button>
              {expanded && (
                <div id={`onboarding-step-${step.key}`} className="px-2 pb-3 pl-[2.1rem]">
                  <p className="text-sm leading-relaxed text-ink-soft">{step.why}</p>
                  <p className="mt-1.5 text-xs leading-relaxed text-ink-faint">{step.evidence}</p>
                  <p className={clsx(
                    "mt-1.5 text-xs leading-relaxed",
                    check.state === "verified" ? "text-good"
                      : check.state === "incomplete" ? "text-accent" : "text-ink-soft",
                  )}>
                    {check.detail}
                  </p>
                  <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-2">
                    {step.links.map((link, linkIndex) => (
                      <Link
                        key={link.to}
                        to={link.to}
                        onClick={() => {
                          window.requestAnimationFrame(() => {
                            document.getElementById("main-content")?.focus();
                          });
                        }}
                        className={clsx(
                          "inline-flex min-h-11 items-center gap-1 text-sm text-accent underline",
                          linkIndex === 0 ? "font-semibold" : "font-medium",
                        )}
                      >
                        {link.label}
                        <ArrowRight size={14} aria-hidden="true" />
                      </Link>
                    ))}
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ol>

      <div className="border-t border-rule px-3 pb-2 pt-2">
        <p className="text-xs leading-relaxed text-ink-faint">
          {complete
            ? "Nothing is stored as progress. Reopen Guide any time and it reads the records again."
            : "Hiding it loses nothing: Guide in the header brings it back at this step."}
        </p>
        <div className="flex items-center justify-between gap-2">
          <Button
            variant="ghost" size="sm" className="text-ink-soft"
            onClick={() => { for (const result of results) void result.refetch(); }}
          >
            Check again
          </Button>
          <Button
            variant="ghost" size="sm" className="text-ink-soft"
            onClick={() => {
              setPresentation({ dismissed: true });
              trigger?.focus();
            }}
          >
            {complete ? "Done — put the guide away" : "Hide the guide"}
          </Button>
        </div>
      </div>
    </div>
  );
}
