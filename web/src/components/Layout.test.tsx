import { act, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryRouter, createRoutesFromElements, Link, Route, RouterProvider,
  useOutletContext,
} from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { lazy } from "react";

import Layout, { GROUPS, TABS, mobileGroups, ownerOf } from "./Layout";
import ExpensesList from "../pages/ExpensesList";
import SalesSheet from "../pages/SalesSheet";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  setMe: vi.fn(),
  clearCachedMe: vi.fn(),
  role: "owner",
  outletIds: [7],
  elevatedUntil: null as string | null,
  refreshMoney: vi.fn(),
}));

vi.mock("../api/client", () => ({ api: { get: mocks.get, post: mocks.post } }));
vi.mock("../lib/auth", () => ({
  useAuth: () => ({
    me: {
      username: "owner", role: mocks.role, outlet_ids: mocks.outletIds,
      full_name: "Owner", elevated_until: mocks.elevatedUntil,
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

/** Records the outletId every time a child page renders. */
const seen: number[] = [];
function Probe() {
  const { outletId } = useOutletContext<{ outletId: number }>();
  seen.push(outletId);
  return <div>page outlet {outletId}</div>;
}

function ImportProbe() {
  return <div>Sales import</div>;
}

function renderLayout(initialEntries = ["/"], initialIndex?: number, sales = false, expenses = false) {
  // Layout uses useQueryClient for the retry button on failed loads, so it
  // needs the same provider main.tsx gives it in the real app.
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    createRoutesFromElements(
      <Route element={<Layout />}>
        <Route path="/" element={<Probe />} />
        <Route path="/next" element={<Probe />} />
        <Route path="/login" element={<div>Signed out</div>} />
        {sales && <Route path="/sales" element={<SalesSheet />} />}
        {sales && <Route path="/sales/import" element={<ImportProbe />} />}
        {expenses && <Route path="/money/expenses" element={<ExpensesList />} />}
      </Route>,
    ),
    {
      initialEntries,
      initialIndex,
      future: { v7_relativeSplatPath: true },
    },
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

beforeEach(() => {
  seen.length = 0;
  localStorage.clear();
  mocks.get.mockReset();
  mocks.refreshMoney.mockReset();
  mocks.post.mockReset().mockResolvedValue({});
  mocks.setMe.mockReset();
  mocks.clearCachedMe.mockReset();
  mocks.role = "owner";
  mocks.outletIds = [7];
  mocks.elevatedUntil = null;
});

describe("Layout outlet resolution", () => {
  it("clears a prior page's load error when navigating to another page", async () => {
    mocks.get.mockResolvedValue([{ id: 7, name: "Test restaurant" }]);
    const { router } = renderLayout();
    await screen.findByText(/page outlet/);
    window.dispatchEvent(new CustomEvent("ledger:api-error", {
      detail: { message: "Not found", sticky: true },
    }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Not found");
    void router.navigate("/next");
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  it("keeps navigation and outlet controls available while a page chunk loads", async () => {
    mocks.get.mockResolvedValue([{ id: 7, name: "Test restaurant" }]);
    localStorage.setItem("ledger_outlet", "7");
    let release!: (module: { default: typeof Probe }) => void;
    const DeferredPage = lazy(() => new Promise<{ default: typeof Probe }>((resolve) => { release = resolve; }));
    const router = createMemoryRouter([
      { element: <Layout />, children: [{ path: "/", element: <DeferredPage /> }] },
    ], { future: { v7_relativeSplatPath: true } });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <RouterProvider router={router} future={{ v7_startTransition: true }} />
      </QueryClientProvider>,
    );
    expect(await screen.findByText("Loading page…")).toHaveAttribute("role", "status");
    expect(screen.getByRole("navigation", { name: "Daily navigation" })).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Switch outlet" })).not.toBeInTheDocument();
    for (const identity of screen.getAllByText("Test restaurant")) {
      expect(identity.closest(".outlet-identity")).toHaveClass("min-h-11");
    }
    release({ default: Probe });
    expect(await screen.findByText("page outlet 7")).toBeInTheDocument();
    expect(screen.queryByText("Loading page…")).not.toBeInTheDocument();
  });

  it("never renders a page before /outlets resolves", async () => {
    let release!: (rows: unknown) => void;
    mocks.get.mockImplementation((url: string) =>
      url === "/outlets"
        ? new Promise((resolve) => { release = resolve; })
        : Promise.resolve({}),
    );

    renderLayout();
    // Outlets still in flight: no page, and crucially no outletId=0 leaked.
    expect(seen).toEqual([]);

    release([{ id: 7, name: "Test restaurant", is_active: true }]);
    await waitFor(() => expect(screen.getByText(/page outlet/)).toBeInTheDocument());
    expect(seen).not.toContain(0);
    expect(seen.at(-1)).toBe(7);
  });

  it("does not leak a stale localStorage outlet id to pages", async () => {
    localStorage.setItem("ledger_outlet", "999"); // outlet since deleted
    mocks.get.mockImplementation((url: string) =>
      url === "/outlets"
        ? Promise.resolve([{ id: 7, name: "Test restaurant", is_active: true }])
        : Promise.resolve({}),
    );

    renderLayout();
    await waitFor(() => expect(screen.getByText(/page outlet/)).toBeInTheDocument());
    expect(seen).not.toContain(999);
    expect(seen.at(-1)).toBe(7);
  });

  it("uses an active cached outlet after the live request is rejected", async () => {
    localStorage.setItem("ledger_outlets", JSON.stringify([
      { id: 7, name: "Cached restaurant", is_active: true },
    ]));
    mocks.get.mockRejectedValue(new Error("offline"));

    renderLayout();

    expect(await screen.findByText("page outlet 7")).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Switch outlet" })).not.toBeInTheDocument();
    expect(seen).toEqual([7]);
  });

  it("holds child routes and offers a retry when no outlet cache is usable", async () => {
    mocks.get.mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce([{ id: 7, name: "Restored restaurant", is_active: true }]);
    const user = userEvent.setup();
    renderLayout();

    expect(await screen.findByRole("alert")).toHaveTextContent("Outlet unavailable");
    expect(seen).toEqual([]);
    expect(screen.queryByRole("combobox", { name: "Switch outlet" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Retry outlets" }));
    expect(await screen.findByText("page outlet 7")).toBeInTheDocument();
    expect(seen).toEqual([7]);
  });

  it("does not trust an inaccessible stale outlet cache after a rejected request", async () => {
    localStorage.setItem("ledger_outlets", JSON.stringify([
      { id: 999, name: "Removed restaurant", is_active: true },
      { id: 7, name: "Inactive restaurant", is_active: false },
    ]));
    localStorage.setItem("ledger_outlet", "999");
    mocks.get.mockRejectedValue(new Error("offline"));

    renderLayout();

    expect(await screen.findByRole("alert")).toHaveTextContent("Outlet unavailable");
    expect(seen).toEqual([]);
    expect(localStorage.getItem("ledger_outlet")).toBeNull();
  });

  it("cancels a transient error timer when a later sticky error replaces it", async () => {
    mocks.get.mockResolvedValue([{ id: 7, name: "Test restaurant" }]);
    renderLayout();
    await screen.findByText("page outlet 7");
    vi.useFakeTimers();
    try {
      act(() => {
        window.dispatchEvent(new CustomEvent("ledger:api-error", {
          detail: { message: "Temporary error", sticky: false },
        }));
        vi.advanceTimersByTime(3_000);
        window.dispatchEvent(new CustomEvent("ledger:api-error", {
          detail: { message: "Retry required", sticky: true },
        }));
        vi.advanceTimersByTime(3_001);
      });

      expect(screen.getByRole("alert")).toHaveTextContent("Retry required");
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a prior timer on navigation so a later error gets its full lifetime", async () => {
    mocks.get.mockResolvedValue([{ id: 7, name: "Test restaurant" }]);
    const { router } = renderLayout();
    await screen.findByText("page outlet 7");
    vi.useFakeTimers();
    try {
      act(() => {
        window.dispatchEvent(new CustomEvent("ledger:api-error", {
          detail: { message: "Old page error", sticky: false },
        }));
        vi.advanceTimersByTime(3_000);
      });
      await act(async () => { await router.navigate("/next"); });
      act(() => {
        window.dispatchEvent(new CustomEvent("ledger:api-error", {
          detail: { message: "New page error", sticky: false },
        }));
        vi.advanceTimersByTime(3_001);
      });
      expect(screen.getByRole("alert")).toHaveTextContent("New page error");

      act(() => vi.advanceTimersByTime(2_999));
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("refreshes money config once signed in", async () => {
    mocks.get.mockResolvedValue([{ id: 7, name: "Test restaurant", is_active: true }]);
    renderLayout();
    await waitFor(() => expect(mocks.refreshMoney).toHaveBeenCalled());
  });
});

describe("draft navigation guard", () => {
  const mockSalesApi = () => {
    mocks.get.mockImplementation((url: string) => {
      if (url === "/outlets") return Promise.resolve([{ id: 7, name: "Test restaurant", is_active: true }]);
      if (url.startsWith("/sales/sheet")) {
        return Promise.resolve({
          rows: [{ channel_kind: "cash", manual_amount_rupees: null, effective_rupees: null }],
          total_rupees: 0, losses_rupees: 0, losses: [], loss_kinds: [],
        });
      }
      return Promise.resolve({});
    });
  };

  it("closes More before guarding phone sign-out and keeps the sales draft on cancel", async () => {
    mockSalesApi();
    localStorage.setItem("ledger_outlet", "7");
    const user = userEvent.setup();
    renderLayout(["/sales"], undefined, true);
    const [amount] = await screen.findAllByLabelText(/^Sales amount for /);
    await user.type(amount, "100");
    await user.click(screen.getByRole("button", { name: "More" }));
    const menu = screen.getByRole("dialog", { name: "Everything else" });
    await user.click(within(menu).getByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("dialog", { name: "Keep unsaved work?" })).toBeInTheDocument();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Keep working" }));
    expect(screen.getByDisplayValue("100")).toBeInTheDocument();
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("does not switch outlets or clear a draft when outlet switching is cancelled", async () => {
    mockSalesApi();
    mocks.outletIds = [7, 8];
    localStorage.setItem("ledger_outlet", "7");
    const originalGet = mocks.get.getMockImplementation()!;
    mocks.get.mockImplementation((url: string) => url === "/outlets"
      ? Promise.resolve([{ id: 7, name: "Market Road" }, { id: 8, name: "High Street" }])
      : originalGet(url));
    const user = userEvent.setup();
    renderLayout(["/sales"], undefined, true);
    const [amount] = await screen.findAllByLabelText(/^Sales amount for /);
    await user.type(amount, "100");
    await user.selectOptions(screen.getByRole("combobox", { name: "Switch outlet" }), "8");
    expect(await screen.findByRole("dialog", { name: "Keep unsaved work?" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Keep working" }));
    expect(localStorage.getItem("ledger_outlet")).toBe("7");
    expect(screen.getByRole("combobox", { name: "Switch outlet" })).toHaveValue("7");
    expect(screen.getByDisplayValue("100")).toBeInTheDocument();
  });

  it("blocks the Sales page's direct import link until its draft is discarded", async () => {
    const user = userEvent.setup();
    mockSalesApi();
    localStorage.setItem("ledger_outlet", "7");
    renderLayout(["/sales"], undefined, true);
    const [amount] = await screen.findAllByLabelText(/^Sales amount for /);
    await user.type(amount, "100");

    await user.click(screen.getByRole("link", { name: "Sales Import" }));
    expect(await screen.findByText("Keep unsaved work?")).toBeInTheDocument();
    await user.click(screen.getByText("Keep working"));
    expect(screen.getByDisplayValue("100")).toBeInTheDocument();

    await user.click(screen.getByRole("link", { name: "Sales Import" }));
    await user.click(screen.getByText("Discard & continue"));
    expect(await screen.findByText("Sales import")).toBeInTheDocument();
  });

  it("keeps a sales draft mounted when browser history navigation is cancelled", async () => {
    const user = userEvent.setup();
    mockSalesApi();
    localStorage.setItem("ledger_outlet", "7");
    const { router } = renderLayout(["/", "/sales"], 1, true);
    const [amount] = await screen.findAllByLabelText(/^Sales amount for /);
    await user.type(amount, "100");

    void router.navigate(-1);
    expect(await screen.findByText("Keep unsaved work?")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/sales");
    await user.click(screen.getByText("Keep working"));
    expect(screen.getByDisplayValue("100")).toBeInTheDocument();

    void router.navigate(-1);
    await user.click(await screen.findByText("Discard & continue"));
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
  });

  it("keeps the add-expense sheet mounted when its first amount is entered", async () => {
    const user = userEvent.setup();
    mocks.get.mockImplementation((url: string) => {
      if (url === "/outlets") return Promise.resolve([{ id: 7, name: "Test restaurant", is_active: true }]);
      if (url === "/lists/categories") return Promise.resolve([
        { id: 1, name: "Vegetables", is_active: true },
      ]);
      if (url === "/vendors") return Promise.resolve([]);
      if (url.startsWith("/expenses?")) return Promise.resolve({ rows: [] });
      if (url === "/ocr/status") return Promise.resolve({ configured: false });
      return Promise.resolve({});
    });
    localStorage.setItem("ledger_outlet", "7");
    renderLayout(["/money/expenses"], undefined, false, true);

    await user.click(await screen.findByText("Add expense"));
    const amount = await screen.findByPlaceholderText("₹ 0");
    await user.type(amount, "1");

    expect(amount).toHaveValue("1");
    expect(screen.queryByText("Something went wrong")).not.toBeInTheDocument();
  });
});

/**
 * Navigation grouping rules.
 *
 * Two things are protected here. First, that the four daily jobs stay
 * together: they used to sit in three different groups, so the daily round
 * meant learning which accounting bucket each chore had been filed under.
 * Second, that group ownership is decided by the longest matching route and
 * not a bare prefix - /sales and /sales/bills are different jobs.
 */
const routeOf = (p: string) => ownerOf(p)?.c.to;
const groupOf = (p: string) => ownerOf(p)?.g.key;

describe("nav grouping", () => {
  it("opens a rail group without navigating away from the current task", async () => {
    mocks.get.mockResolvedValue([{ id: 7, name: "Test restaurant" }]);
    const { router } = renderLayout();
    await screen.findByText(/page outlet/);
    const group = screen.getByRole("button", { name: "Suppliers & stock" });
    expect(group).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(group);
    expect(group).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("link", { name: "Suppliers" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/");
    await userEvent.click(group);
    expect(group).toHaveAttribute("aria-expanded", "false");
  });

  it("marks the active destination and offers a keyboard skip link", async () => {
    mocks.get.mockResolvedValue([{ id: 7, name: "Test restaurant" }]);
    renderLayout();
    await screen.findByText(/page outlet/);
    const daily = screen.getByRole("navigation", { name: "Daily navigation" });
    expect(within(daily).getByRole("link", { name: "Home" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Skip to main content" })).toHaveAttribute("href", "#main-content");
    expect(screen.getByRole("main")).toHaveAttribute("id", "main-content");
  });

  it("gives a direct and a nested desktop route the same accent dot and tint", async () => {
    mocks.get.mockResolvedValue([{ id: 7, name: "Test restaurant" }]);
    renderLayout(["/money/expenses"], undefined, false, true);
    const rail = await screen.findByRole("navigation", { name: "Main navigation" });

    const nested = within(rail).getByRole("link", { name: "Expenses" });
    expect(nested).toHaveAttribute("aria-current", "page");
    expect(nested.className).toContain("bg-accent-soft");
    expect(nested.querySelector("span.bg-accent")).not.toBeNull();

    const direct = within(rail).getByRole("link", { name: "Settings" });
    expect(direct.className).not.toContain("bg-accent-soft");
    expect(direct.querySelector("span.bg-accent")).toBeNull();

    // The group heading is an ancestor, not the current page: no second
    // current-page dot competing with the child's.
    const group = within(rail).getByRole("button", { name: "Daily work" });
    expect(group).not.toHaveAttribute("aria-current");
    expect(group.querySelector("span.bg-accent")).toBeNull();
  });

  it("keeps the end of mobile content above the fixed navigation and safe area", async () => {
    mocks.get.mockResolvedValue([{ id: 7, name: "Test restaurant" }]);
    renderLayout();
    await screen.findByText(/page outlet/);

    expect(screen.getByRole("main")).toHaveClass(
      "pb-[calc(3.5rem+env(safe-area-inset-bottom))]", "md:pb-0",
    );
    expect(screen.getByRole("navigation", { name: "Daily navigation" }))
      .toHaveStyle({ paddingBottom: "env(safe-area-inset-bottom)" });
  });

  it("lets a phone user sign out from More using the existing session cleanup", async () => {
    mocks.get.mockResolvedValue([{ id: 7, name: "Test restaurant" }]);
    renderLayout();
    await screen.findByText(/page outlet/);
    await userEvent.click(screen.getByRole("button", { name: "More" }));
    const menu = screen.getByRole("dialog", { name: "Everything else" });
    expect(within(menu).getByRole("link", { name: "Cash & close day" })).toBeInTheDocument();
    await userEvent.click(within(menu).getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(mocks.setMe).toHaveBeenCalledWith(null));
    expect(mocks.post).toHaveBeenCalledWith("/auth/logout");
    expect(mocks.clearCachedMe).toHaveBeenCalled();
  });

  it("preserves owner gates in the phone menu", async () => {
    mocks.role = "manager";
    mocks.get.mockResolvedValue([{ id: 7, name: "Test restaurant" }]);
    renderLayout();
    await screen.findByText(/page outlet/);
    await userEvent.click(screen.getByRole("button", { name: "More" }));
    const menu = screen.getByRole("dialog", { name: "Everything else" });
    for (const name of ["Settings", "Payroll", "Advances", "Bank statement", "Import from POS"]) {
      expect(within(menu).queryByRole("link", { name })).not.toBeInTheDocument();
    }
    expect(within(menu).getByRole("link", { name: "People" })).toBeInTheDocument();
  });

  it("shows Settings once for an owner", async () => {
    mocks.get.mockResolvedValue([{ id: 7, name: "Test restaurant", is_active: true }]);
    renderLayout();
    await screen.findByText(/page outlet/);
    expect(screen.getAllByRole("link", { name: "Settings" })).toHaveLength(1);
  });

  it("shows owner lock status as visible, labelled text", async () => {
    mocks.get.mockResolvedValue([{ id: 7, name: "Test restaurant", is_active: true }]);
    renderLayout();
    await screen.findByText(/page outlet/);
    expect(screen.getByRole("status", { name: "Owner mode: locked" }))
      .toHaveTextContent("Owner: locked");
  });

  it("keeps all four daily jobs in one group", () => {
    for (const p of ["/staff/attendance", "/sales", "/money/expenses",
                     "/money/cash"]) {
      expect(groupOf(p), p).toBe("today");
    }
  });

  it("does not let a prefix steal a deeper page", () => {
    expect(groupOf("/sales")).toBe("today");
    expect(groupOf("/sales/bills")).toBe("sales");
    expect(routeOf("/sales/bills")).toBe("/sales/bills");
    expect(groupOf("/staff/attendance")).toBe("today");
    expect(groupOf("/staff/people")).toBe("staff");
    expect(groupOf("/money/expenses")).toBe("today");
    expect(groupOf("/money/vendors")).toBe("operations");
  });

  it("matches a child own sub-pages", () => {
    expect(routeOf("/staff/people/7")).toBe("/staff/people");
    expect(routeOf("/money/vendors/3")).toBe("/money/vendors");
  });

  it("does not match a route that merely starts with the same letters", () => {
    expect(ownerOf("/salesman")).toBeUndefined();
    expect(ownerOf("/money/expenses-archive")).toBeUndefined();
  });

  it("claims only Home and Settings outside the workspaces", () => {
    for (const p of ["/", "/settings"]) {
      expect(ownerOf(p), p).toBeUndefined();
    }
  });

  it("gives every route exactly one owner", () => {
    const seenRoutes = new Set<string>();
    for (const g of GROUPS) {
      for (const c of g.children) {
        expect(seenRoutes.has(c.to), c.to + " listed twice").toBe(false);
        seenRoutes.add(c.to);
      }
    }
  });

  it("points every bottom tab at a real destination", () => {
    for (const t of TABS) {
      if (t.to === "/") continue;
      expect(ownerOf(t.to), t.to + " is not in any group").toBeDefined();
    }
  });

  it("names the bottom tabs after the job, not the filing cabinet", () => {
    expect(TABS.map((t) => t.label))
      .toEqual(["Home", "Attendance", "Sales", "Expenses"]);
  });

  it("reaches every page on a phone, tab or menu", () => {
    // The bar covers three daily jobs; the menu must cover the whole rest.
    // Closing the day had no tab and sat in the group the menu skipped, so
    // on a phone it could not be opened at all.
    const tabbed = new Set(TABS.map((t) => t.to));
    const inMenu = new Set(mobileGroups().flatMap((g) => g.children.map((c) => c.to)));
    for (const g of GROUPS) {
      for (const c of g.children) {
        expect(tabbed.has(c.to) || inMenu.has(c.to), `${c.to} is unreachable on a phone`)
          .toBe(true);
      }
    }
    expect(inMenu.has("/money/cash")).toBe(true);
  });

  it("does not repeat in the menu what the bottom bar already shows", () => {
    const inMenu = mobileGroups().flatMap((g) => g.children.map((c) => c.to));
    for (const t of TABS) expect(inMenu).not.toContain(t.to);
  });

  it("drops a group from the menu only when it is left with nothing", () => {
    for (const g of mobileGroups()) expect(g.children.length).toBeGreaterThan(0);
    // "Every day" must survive, because the cash count still lives there.
    expect(mobileGroups().map((g) => g.key)).toContain("today");

    // With today's nav no group is ever fully covered by tabs, so prove the
    // rule on a nav where one is: a heading with no links under it is worse
    // than no heading.
    const fixture = [
      { key: "all-tabbed", label: "All tabbed", children: [{ to: "/a" }, { to: "/b" }] },
      { key: "part", label: "Part", children: [{ to: "/a" }, { to: "/c" }] },
    ] as unknown as typeof GROUPS;
    const out = mobileGroups(fixture, [{ to: "/a" }, { to: "/b" }]);
    expect(out.map((g) => g.key)).toEqual(["part"]);
    expect(out[0].children.map((c) => c.to)).toEqual(["/c"]);
  });

  it("does not name a group after a list of its own contents", () => {
    // "Suppliers & bank" was the leftovers wearing a label. A group name
    // joining two of its children with "&" is the tell.
    for (const g of GROUPS) {
      const names = g.children.map((c) => c.label.toLowerCase());
      const parts = g.label.toLowerCase().split(" & ");
      if (parts.length < 2) continue;
      const echoes = parts.filter((p) => names.some((n) => n.includes(p)));
      expect(echoes.length, `"${g.label}" lists its own members`).toBeLessThan(2);
    }
  });

  it("keeps sales and supply work next to each other", () => {
    const keys = GROUPS.map((g) => g.key);
    expect(keys[0]).toBe("today");
    expect(Math.abs(keys.indexOf("sales") - keys.indexOf("operations"))).toBe(1);
  });
});
