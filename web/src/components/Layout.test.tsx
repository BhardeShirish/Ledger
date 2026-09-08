import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryRouter, createRoutesFromElements, Link, Route, RouterProvider,
  useOutletContext,
} from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";

import Layout, { GROUPS, TABS, mobileGroups, ownerOf } from "./Layout";
import ExpensesList from "../pages/ExpensesList";
import SalesSheet from "../pages/SalesSheet";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  refreshMoney: vi.fn(),
}));

vi.mock("../api/client", () => ({ api: { get: mocks.get } }));
vi.mock("../lib/auth", () => ({
  useAuth: () => ({
    me: { username: "owner", role: "owner", outlet_ids: [7], full_name: "Owner" },
    logout: vi.fn(),
  }),
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
});

describe("Layout outlet resolution", () => {
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

    release([{ id: 7, name: "Ootaa", is_active: true }]);
    await waitFor(() => expect(screen.getByText(/page outlet/)).toBeInTheDocument());
    expect(seen).not.toContain(0);
    expect(seen.at(-1)).toBe(7);
  });

  it("does not leak a stale localStorage outlet id to pages", async () => {
    localStorage.setItem("ledger_outlet", "999"); // outlet since deleted
    mocks.get.mockImplementation((url: string) =>
      url === "/outlets"
        ? Promise.resolve([{ id: 7, name: "Ootaa", is_active: true }])
        : Promise.resolve({}),
    );

    renderLayout();
    await waitFor(() => expect(screen.getByText(/page outlet/)).toBeInTheDocument());
    expect(seen).not.toContain(999);
    expect(seen.at(-1)).toBe(7);
  });

  it("refreshes money config once signed in", async () => {
    mocks.get.mockResolvedValue([{ id: 7, name: "Ootaa", is_active: true }]);
    renderLayout();
    await waitFor(() => expect(mocks.refreshMoney).toHaveBeenCalled());
  });
});

describe("draft navigation guard", () => {
  const mockSalesApi = () => {
    mocks.get.mockImplementation((url: string) => {
      if (url === "/outlets") return Promise.resolve([{ id: 7, name: "Ootaa", is_active: true }]);
      if (url.startsWith("/sales/sheet")) {
        return Promise.resolve({
          rows: [{ channel_kind: "cash", manual_amount_rupees: null, effective_rupees: null }],
          total_rupees: 0, losses_rupees: 0, losses: [], loss_kinds: [],
        });
      }
      return Promise.resolve({});
    });
  };

  it("blocks the Sales page's direct import link until its draft is discarded", async () => {
    const user = userEvent.setup();
    mockSalesApi();
    localStorage.setItem("ledger_outlet", "7");
    renderLayout(["/sales"], undefined, true);
    const [amount] = await screen.findAllByPlaceholderText("₹");
    await user.type(amount, "100");

    await user.click(screen.getByText("Sales → Import"));
    expect(await screen.findByText("Keep unsaved work?")).toBeInTheDocument();
    await user.click(screen.getByText("Keep working"));
    expect(screen.getByDisplayValue("100")).toBeInTheDocument();

    await user.click(screen.getByText("Sales → Import"));
    await user.click(screen.getByText("Discard & continue"));
    expect(await screen.findByText("Sales import")).toBeInTheDocument();
  });

  it("keeps a sales draft mounted when browser history navigation is cancelled", async () => {
    const user = userEvent.setup();
    mockSalesApi();
    localStorage.setItem("ledger_outlet", "7");
    const { router } = renderLayout(["/", "/sales"], 1, true);
    const [amount] = await screen.findAllByPlaceholderText("₹");
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
      if (url === "/outlets") return Promise.resolve([{ id: 7, name: "Ootaa", is_active: true }]);
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
    expect(groupOf("/money/vendors")).toBe("spending");
  });

  it("matches a child own sub-pages", () => {
    expect(routeOf("/staff/people/7")).toBe("/staff/people");
    expect(routeOf("/money/vendors/3")).toBe("/money/vendors");
  });

  it("does not match a route that merely starts with the same letters", () => {
    expect(ownerOf("/salesman")).toBeUndefined();
    expect(ownerOf("/money/expenses-archive")).toBeUndefined();
  });

  it("claims nothing for pages outside the groups", () => {
    for (const p of ["/", "/reports", "/settings", "/inventory", "/brief"]) {
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

  it("puts money in and money out next to each other", () => {
    const keys = GROUPS.map((g) => g.key);
    expect(keys[0]).toBe("today");
    expect(Math.abs(keys.indexOf("sales") - keys.indexOf("spending"))).toBe(1);
  });
});
