import { render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryRouter, createRoutesFromElements, Route, RouterProvider,
} from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";

import Layout, { GROUPS, ownerOf } from "./Layout";
import {
  GUIDE_STORAGE_KEY, checkAccountName, checkBusinessSetup, checkDayClose,
  checkTeamAndShifts, checkTodaysExpenses, checkTodaysSales, currentStepIndex,
  evaluateSteps, guideSteps, settle, type Evidence,
} from "./OnboardingGuide";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  setMe: vi.fn(),
  clearCachedMe: vi.fn(),
  role: "owner",
  fullName: "Ravi Kumar",
  // Stable identity: Layout reloads outlets whenever me.outlet_ids changes,
  // so a fresh array per render would loop forever.
  outletIds: [7],
  refreshMoney: vi.fn(),
}));

vi.mock("../api/client", () => ({ api: { get: mocks.get, post: mocks.post } }));
vi.mock("../lib/auth", () => ({
  useAuth: () => ({
    me: {
      username: "ravi", role: mocks.role, outlet_ids: mocks.outletIds,
      full_name: mocks.fullName, elevated_until: null,
    },
    setMe: mocks.setMe,
    logout: vi.fn(),
  }),
  clearCachedMe: mocks.clearCachedMe,
  useGuarded: () => (action: () => unknown) => action(),
}));
vi.mock("../lib/money", () => ({
  useMoney: () => ({ config: { restaurant_name: "Test" }, refresh: mocks.refreshMoney }),
}));

/* ------------------------------------------------------------ fixtures -- */

type Fixture = {
  outlets: unknown; moneyConfig: unknown; employees: unknown; shifts: unknown;
  sheet: unknown; expenses: unknown; cash: unknown;
};

/** A signed-up outlet whose books stop after people and shifts. */
const freshBooks = (): Fixture => ({
  outlets: [{ id: 7, name: "Market Road" }],
  moneyConfig: { restaurant_name: "Sagar Tiffins", timezone: "Asia/Kolkata" },
  employees: [
    { id: 1, name: "Asha", working_status: "working", is_active: true, default_shift_id: 3, pattern: [] },
    { id: 2, name: "Vikram", working_status: "working", is_active: true, default_shift_id: null, pattern: [] },
  ],
  shifts: [{ id: 3, name: "Morning", is_active: true }],
  sheet: { rows: [], all_rows: [{ channel_kind: "cash", manual_amount_rupees: null, imported: null }], total_rupees: 0 },
  expenses: { total: 0, rows: [] },
  cash: { closure: null, expected_paise: 125000 },
});

let fixture: Fixture;
let failing: Set<keyof Fixture>;

function respond(url: string) {
  const send = (key: keyof Fixture) => failing.has(key)
    ? Promise.reject(new Error("Cannot reach Ledger"))
    : Promise.resolve(fixture[key]);
  if (url === "/outlets") return send("outlets");
  if (url === "/lists/money-config") return send("moneyConfig");
  if (url.startsWith("/staff/employees")) return send("employees");
  if (url === "/staff/shifts") return send("shifts");
  if (url.startsWith("/sales/sheet")) return send("sheet");
  if (url.startsWith("/expenses")) return send("expenses");
  if (url.startsWith("/cash/day")) return send("cash");
  return Promise.resolve({});
}

function renderLayout(initialEntries = ["/"]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const page = (label: string) => <div>{label}</div>;
  const router = createMemoryRouter(
    createRoutesFromElements(
      <Route element={<Layout />}>
        <Route path="/" element={page("home page")} />
        <Route path="/sales" element={page("sales day sheet")} />
        <Route path="/sales/import" element={page("import from POS")} />
        <Route path="/staff/people" element={page("people list")} />
        <Route path="/staff/shifts" element={page("shift board")} />
        <Route path="/money/expenses" element={page("expenses page")} />
        <Route path="/money/cash" element={page("cash register")} />
        <Route path="/settings" element={page("settings page")} />
        <Route path="/settings/account" element={page("account page")} />
      </Route>,
    ),
    { initialEntries, future: { v7_relativeSplatPath: true } },
  );
  return {
    router,
    ...render(
      <QueryClientProvider client={qc}>
        <RouterProvider router={router} future={{ v7_startTransition: true }} />
      </QueryClientProvider>,
    ),
  };
}

const guide = () => screen.queryByRole("region", { name: "Getting started" });
const pill = () => screen.queryByRole("button", { name: /^Getting started guide, / });
const helpButton = () => screen.getByRole("button", { name: "Getting started guide" });
const progressLine = () => within(guide()!).getByText(/checked against your records/).textContent;
const step = (name: RegExp) => within(guide()!).getByRole("button", { name });
const openGuide = async () => {
  await waitFor(() => expect(guide()).not.toBeNull());
  return guide()!;
};

beforeEach(() => {
  localStorage.clear();
  fixture = freshBooks();
  failing = new Set();
  mocks.get.mockReset().mockImplementation(respond);
  mocks.post.mockReset().mockResolvedValue({});
  mocks.refreshMoney.mockReset();
  mocks.role = "owner";
  mocks.fullName = "Ravi Kumar";
});

/* ---------------------------------------------------------- validation -- */

describe("business and outlet setup check", () => {
  it("refuses the names Ledger ships with, and names which one is still open", () => {
    expect(checkBusinessSetup("Main Outlet", { restaurant_name: "My restaurant" }))
      .toEqual({
        state: "incomplete",
        detail: "the business is still called “My restaurant”, and the outlet is still called “Main Outlet”.",
      });
    expect(checkBusinessSetup("Market Road", { restaurant_name: "my restaurant" }).detail)
      .toBe("the business is still called “My restaurant”.");
    expect(checkBusinessSetup("main outlet", { restaurant_name: "Sagar Tiffins" }).detail)
      .toBe("the outlet is still called “Main Outlet”.");
  });

  it("treats an unnamed business or outlet as unfinished, not as done", () => {
    expect(checkBusinessSetup("", { restaurant_name: "" })).toEqual({
      state: "incomplete",
      detail: "the business has no name yet, and this outlet has no name yet.",
    });
    expect(checkBusinessSetup(undefined, { restaurant_name: "Sagar Tiffins" }).state)
      .toBe("incomplete");
  });

  it("passes once both names are the owner's own", () => {
    expect(checkBusinessSetup("Market Road", { restaurant_name: "Sagar Tiffins" }))
      .toEqual({ state: "verified", detail: "Filed as Sagar Tiffins · Market Road." });
  });

  it("claims nothing when the answer cannot be read", () => {
    for (const bad of [null, undefined, "nope", [1, 2]]) {
      expect(checkBusinessSetup("Market Road", bad).state).toBe("checking");
    }
  });
});

describe("manager account check", () => {
  it("does not accept a login id standing in for a name", () => {
    expect(checkAccountName("", "ravi"))
      .toEqual({ state: "incomplete", detail: "This login still shows only as “ravi”." });
    expect(checkAccountName("Ravi", "ravi").state).toBe("incomplete");
    expect(checkAccountName("   ", "ravi").state).toBe("incomplete");
    expect(checkAccountName(null, "").detail).toBe("This login has no name on it yet.");
  });

  it("passes on a real name", () => {
    expect(checkAccountName("Ravi Kumar", "ravi"))
      .toEqual({ state: "verified", detail: "Signed in as Ravi Kumar." });
  });
});

describe("people and shifts check", () => {
  const roster = [{ id: 1, working_status: "working", default_shift_id: 3, pattern: [] }];
  const shifts = [{ id: 3, is_active: true }];

  it("says which half of the job is still open", () => {
    expect(checkTeamAndShifts([], shifts))
      .toEqual({ state: "incomplete", detail: "Nobody is on this outlet's team list yet." });
    expect(checkTeamAndShifts(roster, []).detail)
      .toBe("1 person listed, but no shift timings exist yet.");
    expect(checkTeamAndShifts(
      [{ id: 1, working_status: "working", default_shift_id: null, pattern: [] }], shifts,
    ).detail).toBe("1 person and 1 shift exist, but nobody is on a shift yet.");
  });

  it("accepts either a default shift or a weekly pattern", () => {
    expect(checkTeamAndShifts(roster, shifts))
      .toEqual({ state: "verified", detail: "1 person, 1 on a shift." });
    expect(checkTeamAndShifts(
      [{ id: 1, working_status: "working", default_shift_id: null, pattern: [{ dow: 1, shift_id: 3 }] }],
      shifts,
    ).state).toBe("verified");
    expect(checkTeamAndShifts(
      [{ id: 1, working_status: "working", default_shift_id: null, pattern: [{ dow: 1, shift_id: null }] }],
      shifts,
    ).state).toBe("incomplete");
  });

  it("ignores people who have left and shifts that were retired", () => {
    expect(checkTeamAndShifts(
      [{ id: 9, working_status: "left", default_shift_id: 3 }], shifts,
    ).detail).toBe("Nobody is on this outlet's team list yet.");
    expect(checkTeamAndShifts(
      [{ id: 9, working_status: "working", is_active: false, default_shift_id: 3 }], shifts,
    ).state).toBe("incomplete");
    expect(checkTeamAndShifts(roster, [{ id: 3, is_active: false }]).detail)
      .toBe("1 person listed, but no shift timings exist yet.");
  });

  it("requires an assigned shift to still be active for this outlet", () => {
    expect(checkTeamAndShifts(
      [{ id: 1, working_status: "working", default_shift_id: 9, pattern: [] }],
      [{ id: 3, is_active: true, outlet_id: 7 }, { id: 9, is_active: false, outlet_id: 7 }],
      7,
    ).detail).toBe("1 person and 1 shift exist, but nobody is on a shift yet.");
    expect(checkTeamAndShifts(
      [{ id: 1, working_status: "working", default_shift_id: 3, pattern: [] }],
      [{ id: 3, is_active: true, outlet_id: 8 }],
      7,
    ).detail).toBe("1 person listed, but no shift timings exist yet.");
  });

  it("claims nothing when either list cannot be read", () => {
    expect(checkTeamAndShifts({ rows: [] }, shifts).state).toBe("checking");
    expect(checkTeamAndShifts(roster, null).state).toBe("checking");
  });
});

describe("today's sales check", () => {
  it("accepts a typed amount or a POS import, and says which", () => {
    expect(checkTodaysSales({
      all_rows: [{ channel_kind: "cash", manual_amount_rupees: 4200, imported: null }],
      total_rupees: 4200,
    })).toEqual({ state: "verified", detail: "₹4,200 on today's sheet, from 1 typed amount." });

    expect(checkTodaysSales({
      all_rows: [{ channel_kind: "card", manual_amount_rupees: null, imported: { bills: 37, total_paise: 900000 } }],
      total_rupees: 9000,
    }).detail).toBe("₹9,000 on today's sheet, from a POS import (37 bills).");

    expect(checkTodaysSales({
      all_rows: [
        { channel_kind: "cash", manual_amount_rupees: 100, imported: null },
        { channel_kind: "card", manual_amount_rupees: null, imported: { bills: 1 } },
      ],
      total_rupees: 200,
    }).detail).toBe("₹200 on today's sheet, from a POS import (1 bill) and a typed amount.");
  });

  it("counts a deliberate zero as recorded, but an empty sheet as not done", () => {
    expect(checkTodaysSales({
      all_rows: [{ channel_kind: "cash", manual_amount_rupees: 0, imported: null }],
      total_rupees: 0,
    }).state).toBe("verified");
    expect(checkTodaysSales({ all_rows: [{ channel_kind: "cash", manual_amount_rupees: null, imported: null }], total_rupees: 0 }))
      .toEqual({
        state: "incomplete",
        detail: "Today's sheet is empty — no amount typed in and no POS import.",
      });
  });

  it("falls back to the displayed rows and survives a missing total", () => {
    expect(checkTodaysSales({ rows: [{ manual_amount_rupees: 50 }] }).detail)
      .toBe("Today's sheet holds 1 typed amount.");
    expect(checkTodaysSales(null).state).toBe("checking");
  });
});

describe("today's expenses check", () => {
  it("needs a real entry filed under today", () => {
    expect(checkTodaysExpenses({ total: 0, rows: [] }))
      .toEqual({ state: "incomplete", detail: "No expense is filed under today's date yet." });
    expect(checkTodaysExpenses({ total: 3, rows: [{ id: 1 }] }))
      .toEqual({ state: "verified", detail: "3 expenses filed for today." });
    expect(checkTodaysExpenses({ rows: [{ id: 1 }] }).detail).toBe("1 expense filed for today.");
    expect(checkTodaysExpenses("no").state).toBe("checking");
  });
});

describe("cash close check", () => {
  it("holds the day open until a closure exists and stands", () => {
    expect(checkDayClose({ closure: null, expected_paise: 125000 })).toEqual({
      state: "incomplete",
      detail: "Today is not closed yet — Ledger expects ₹1,250 in the drawer.",
    });
    expect(checkDayClose({ closure: null }).detail).toBe("Today is not closed yet.");
    expect(checkDayClose({ closure: { id: 4, reopened: true } })).toEqual({
      state: "incomplete",
      detail: "Today's close was reopened, so it is no longer final. Count and close again.",
    });
  });

  it("reports the counted cash and the direction of any gap", () => {
    expect(checkDayClose({ closure: { id: 4, counted_paise: 125000, variance_paise: 0, reopened: false } }))
      .toEqual({ state: "verified", detail: "Closed on ₹1,250 counted, matching the expected cash." });
    expect(checkDayClose({ closure: { id: 4, counted_paise: 120000, variance_paise: -5000 } }).detail)
      .toBe("Closed on ₹1,200 counted, ₹50 short.");
    expect(checkDayClose({ closure: { id: 4, counted_paise: 130000, variance_paise: 5000 } }).detail)
      .toBe("Closed on ₹1,300 counted, ₹50 over.");
    expect(checkDayClose({ closure: { id: 4 } }))
      .toEqual({ state: "verified", detail: "Today is closed." });
    expect(checkDayClose(undefined).state).toBe("checking");
  });
});

describe("loading and failure are not answers", () => {
  it("keeps a pending or failed request out of the verdict", () => {
    const compute = () => ({ state: "verified" as const, detail: "should not be reached" });
    expect(settle([{ isPending: true }], compute))
      .toEqual({ state: "checking", detail: "Checking your records…" });
    expect(settle([{ isError: true }], compute).detail)
      .toBe("Ledger did not answer this check. It runs again when you come back to this screen.");
    // A failure outranks a pending sibling: it is the one worth explaining.
    expect(settle([{ isPending: true }, { isError: true }], compute).detail)
      .toMatch(/did not answer/);
    expect(settle([{ isPending: false }], compute).state).toBe("verified");
  });
});

describe("step order", () => {
  const ready = (data: unknown) => ({ data, isPending: false, isError: false });
  const evidence = (over: Partial<Evidence> = {}): Evidence => ({
    outletId: 7,
    outletName: "Market Road",
    fullName: "Ravi Kumar",
    username: "ravi",
    config: ready({ restaurant_name: "Sagar Tiffins" }),
    people: ready([{ id: 1, working_status: "working", default_shift_id: 3 }]),
    shifts: ready([{ id: 3, is_active: true }]),
    sales: ready({ all_rows: [{ manual_amount_rupees: 100 }], total_rupees: 100 }),
    expenses: ready({ total: 1, rows: [{ id: 1 }] }),
    cash: ready({ closure: { id: 2, counted_paise: 100, variance_paise: 0 } }),
    ...over,
  });

  it("stops at the first step the records do not vouch for", () => {
    const steps = guideSteps(true);
    expect(currentStepIndex(evaluateSteps(steps, evidence()))).toBe(steps.length);

    const noSales = evaluateSteps(steps, evidence({ sales: ready({ all_rows: [] }) }));
    expect(currentStepIndex(noSales)).toBe(2);
    // A later step being done does not carry the walkthrough past an open one.
    expect(noSales[4]!.state).toBe("verified");

    const checking = evaluateSteps(steps, evidence({ people: { isPending: true } }));
    expect(checking[1]!.state).toBe("checking");
    expect(currentStepIndex(checking)).toBe(1);
  });

  it("gives a manager the account check in place of the owner's setup", () => {
    const managerSteps = guideSteps(false);
    expect(managerSteps.map((s) => s.key))
      .toEqual(["account", "team", "sales", "expenses", "close"]);
    expect(guideSteps(true).map((s) => s.key))
      .toEqual(["business", "team", "sales", "expenses", "close"]);

    const checks = evaluateSteps(managerSteps, evidence({ fullName: "ravi" }));
    expect(checks[0]!.state).toBe("incomplete");
    expect(currentStepIndex(checks)).toBe(0);
  });
});

describe("route exposure", () => {
  it("points every step at a destination the app actually routes", () => {
    const standalone = new Set(["/settings", "/settings/account"]);
    for (const isOwner of [true, false]) {
      for (const s of guideSteps(isOwner)) {
        expect(s.links.length).toBeGreaterThan(0);
        for (const link of s.links) {
          expect(Boolean(ownerOf(link.to)) || standalone.has(link.to), `${s.key} → ${link.to}`)
            .toBe(true);
        }
        for (const route of s.routes) {
          expect(s.links.some((l) => l.to === route), `${s.key} route ${route}`).toBe(true);
        }
      }
    }
  });

  it("never offers a manager an owner-only screen", () => {
    const ownerOnly = new Set(
      GROUPS.flatMap((g) => g.children)
        .filter((c) => (c as { owner?: boolean }).owner)
        .map((c) => c.to),
    );
    for (const s of guideSteps(false)) {
      for (const link of s.links) {
        expect(ownerOnly.has(link.to), `${s.key} → ${link.to}`).toBe(false);
        expect(link.to).not.toBe("/settings");
      }
    }
    expect(guideSteps(true).flatMap((s) => s.links).map((l) => l.to))
      .toContain("/sales/import");
  });
});

/* --------------------------------------------------------- in the shell -- */

describe("guide in the app shell", () => {
  it("shows what the records say, without a way to tick a step off by hand", async () => {
    renderLayout();
    const panel = await openGuide();
    expect(await screen.findByText("home page")).toBeInTheDocument();
    // Not a modal: no dialog, no backdrop, and the page keeps its own focus.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.body).toHaveFocus();

    await waitFor(() => expect(progressLine()).toMatch(/Step 3 of 5/));
    expect(step(/Name the business and this outlet/)).toHaveTextContent("done");
    expect(step(/Add your people/)).toHaveTextContent("done");
    expect(step(/Record today's sales/)).toHaveAttribute("aria-expanded", "true");
    expect(within(panel).getByText(/Today's sheet is empty/)).toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: /I have done this|Mark .*done/i }))
      .toBeNull();
  });

  it("ignores progress a previous version let people claim by hand", async () => {
    localStorage.setItem("ledger_onboarding_v1", JSON.stringify({
      done: ["outlet", "staff", "sales", "expenses", "cash"], hidden: true,
    }));
    renderLayout();
    await openGuide();
    await waitFor(() => expect(progressLine()).toMatch(/Step 3 of 5/));
    expect(within(guide()!).getByText(/Today's sheet is empty/)).toBeInTheDocument();
  });

  it("stays with the person across the route change instead of disappearing", async () => {
    const user = userEvent.setup();
    const { router } = renderLayout();
    await openGuide();
    await waitFor(() => expect(progressLine()).toMatch(/Step 3 of 5/));

    await user.click(within(guide()!).getByRole("link", { name: /Today's sales sheet/ }));
    expect(await screen.findByText("sales day sheet")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/sales");

    // Off the form, still on the job: a pill above the phone's navigation.
    expect(guide()).toBeNull();
    const collapsed = pill()!;
    expect(collapsed).toHaveAccessibleName(
      "Getting started guide, step 3 of 5: Record today's sales",
    );
    expect(collapsed).toHaveTextContent("Step 3 of 5");
    expect(localStorage.getItem(GUIDE_STORAGE_KEY)).toBeNull();
    // The destination receives focus; the guide does not snatch it back.
    expect(collapsed).not.toHaveFocus();
    await waitFor(() => expect(screen.getByRole("main")).toHaveFocus());

    await user.click(collapsed);
    expect(guide()).toHaveFocus();
    expect(step(/Record today's sales/)).toHaveAttribute("aria-expanded", "true");
  });

  it("does not remember an automatic route collapse as a user preference", async () => {
    const user = userEvent.setup();
    const first = renderLayout();
    await openGuide();
    await waitFor(() => expect(progressLine()).toMatch(/Step 3 of 5/));
    await user.click(within(guide()!).getByRole("link", { name: /Today's sales sheet/ }));
    await screen.findByText("sales day sheet");
    expect(localStorage.getItem(GUIDE_STORAGE_KEY)).toBeNull();
    first.unmount();

    renderLayout();
    expect(await openGuide()).toBeInTheDocument();
  });

  it("does not count a step as done because its link was followed", async () => {
    const user = userEvent.setup();
    renderLayout();
    await openGuide();
    await waitFor(() => expect(progressLine()).toMatch(/Step 3 of 5/));
    await user.click(within(guide()!).getByRole("link", { name: /Today's sales sheet/ }));
    await screen.findByText("sales day sheet");
    await user.click(pill()!);
    expect(progressLine()).toMatch(/Step 3 of 5/);
    expect(step(/Record today's sales/)).toHaveTextContent("not done yet");
  });

  it("advances only once the day's records catch up", async () => {
    const user = userEvent.setup();
    const { router } = renderLayout();
    await openGuide();
    await waitFor(() => expect(progressLine()).toMatch(/Step 3 of 5/));

    // The sale is entered on the page the guide sent them to.
    fixture.sheet = {
      all_rows: [{ channel_kind: "cash", manual_amount_rupees: 4200, imported: null }],
      total_rupees: 4200,
    };
    await user.click(within(guide()!).getByRole("link", { name: /Today's sales sheet/ }));
    await screen.findByText("sales day sheet");
    await router.navigate("/");
    await screen.findByText("home page");
    await waitFor(() => expect(pill()).toHaveTextContent("Step 4 of 5"));

    await user.click(pill()!);
    expect(progressLine()).toMatch(/Step 4 of 5/);
    expect(step(/Record today's sales/)).toHaveTextContent("done");
    expect(step(/Record what you spent today/)).toHaveAttribute("aria-expanded", "true");
    await user.click(step(/Record today's sales/));
    expect(within(guide()!).getByText("₹4,200 on today's sheet, from 1 typed amount."))
      .toBeInTheDocument();
  });

  it("says a check could not be run rather than calling it undone", async () => {
    failing.add("sheet");
    renderLayout();
    await openGuide();
    await waitFor(() => expect(within(guide()!).getByText(/did not answer this check/))
      .toBeInTheDocument());
    expect(step(/Record today's sales/)).toHaveTextContent("still being checked");
  });

  it("comes back at the same step after being hidden, with nothing lost", async () => {
    const user = userEvent.setup();
    const first = renderLayout();
    await openGuide();
    await waitFor(() => expect(progressLine()).toMatch(/Step 3 of 5/));
    await user.click(within(guide()!).getByRole("button", { name: "Hide the guide" }));
    expect(guide()).toBeNull();
    expect(pill()).toBeNull();
    expect(helpButton()).toHaveFocus();
    expect(JSON.parse(localStorage.getItem(GUIDE_STORAGE_KEY)!).dismissed).toBe(true);
    first.unmount();

    renderLayout();
    expect(await screen.findByText("home page")).toBeInTheDocument();
    expect(guide()).toBeNull();

    await user.click(helpButton());
    await waitFor(() => expect(progressLine()).toMatch(/Step 3 of 5/));
    expect(step(/Record today's sales/)).toHaveAttribute("aria-expanded", "true");
    expect(helpButton()).toHaveAttribute("aria-expanded", "true");
  });

  it("can be put away when every check passes, and replayed from Guide", async () => {
    const user = userEvent.setup();
    fixture.sheet = { all_rows: [{ manual_amount_rupees: 4200 }], total_rupees: 4200 };
    fixture.expenses = { total: 2, rows: [{ id: 1 }] };
    fixture.cash = { closure: { id: 5, counted_paise: 125000, variance_paise: 0 } };
    renderLayout();
    await openGuide();
    await waitFor(() => expect(progressLine()).toMatch(/All 5 checks pass/));

    await user.click(within(guide()!).getByRole("button", { name: /Done — put the guide away/ }));
    expect(guide()).toBeNull();
    expect(pill()).toBeNull();

    await user.click(helpButton());
    await waitFor(() => expect(progressLine()).toMatch(/All 5 checks pass/));
  });

  it("minimises to the pill from the panel and from Escape", async () => {
    const user = userEvent.setup();
    renderLayout();
    await openGuide();
    await user.click(within(guide()!).getByRole("button", { name: "Minimise getting started" }));
    expect(guide()).toBeNull();
    expect(pill()).toHaveFocus();

    await user.click(pill()!);
    expect(guide()).not.toBeNull();

    // Escape pressed on the page behind is not the guide's key to take.
    await user.click(screen.getByText("home page"));
    await user.keyboard("{Escape}");
    expect(guide()).not.toBeNull();

    await user.click(step(/Record today's sales/));
    await user.keyboard("{Escape}");
    expect(guide()).toBeNull();
    expect(pill()).toHaveFocus();
    expect(JSON.parse(localStorage.getItem(GUIDE_STORAGE_KEY)!))
      .toEqual({ dismissed: false, minimized: true });
  });

  it("keeps a manager on their own steps and out of owner screens", async () => {
    mocks.role = "manager";
    mocks.fullName = "";
    renderLayout();
    const panel = await openGuide();
    await waitFor(() => expect(progressLine()).toMatch(/Step 1 of 5/));
    expect(step(/Put your own name on this login/)).toHaveAttribute("aria-expanded", "true");
    expect(within(panel).getByText(/This login still shows only as “ravi”/))
      .toBeInTheDocument();
    expect(within(panel).getByRole("link", { name: /Your account/ }))
      .toHaveAttribute("href", "/settings/account");

    await userEvent.click(step(/Record today's sales/));
    expect(within(panel).getByRole("link", { name: /Today's sales sheet/ })).toBeInTheDocument();
    expect(within(panel).queryByRole("link", { name: /Import from POS/ })).toBeNull();
    expect(within(panel).queryByRole("link", { name: /Business & outlet settings/ })).toBeNull();
  });

  it("collapses itself when the app opens straight onto a step's page", async () => {
    renderLayout(["/money/cash"]);
    expect(await screen.findByText("cash register")).toBeInTheDocument();
    await waitFor(() => expect(pill()).not.toBeNull());
    expect(guide()).toBeNull();
  });

  it("re-reads the records on demand", async () => {
    const user = userEvent.setup();
    renderLayout();
    await openGuide();
    await waitFor(() => expect(progressLine()).toMatch(/Step 3 of 5/));
    fixture.sheet = { all_rows: [{ manual_amount_rupees: 900 }], total_rupees: 900 };
    await user.click(within(guide()!).getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(progressLine()).toMatch(/Step 4 of 5/));
  });

  it("asks the API for today's records for this outlet only", async () => {
    renderLayout();
    await openGuide();
    await waitFor(() => expect(progressLine()).toMatch(/Step 3 of 5/));
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date());
    const asked = mocks.get.mock.calls.map(([url]) => url as string);
    expect(asked).toContain("/lists/money-config");
    expect(asked).toContain("/staff/employees?outlet_id=7");
    expect(asked).toContain("/staff/shifts");
    expect(asked).toContain(`/sales/sheet?outlet_id=7&date=${today}`);
    expect(asked).toContain(`/expenses?outlet_id=7&start=${today}&end=${today}&limit=1`);
    expect(asked).toContain(`/cash/day?outlet_id=7&date=${today}`);
    // Read-only: the walkthrough never writes anything.
    expect(mocks.post).not.toHaveBeenCalled();
  });
});
