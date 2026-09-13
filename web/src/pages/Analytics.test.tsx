import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { describe, expect, it, vi } from "vitest";
import { addDaysISO, fmtDateShort, todayISO } from "../lib/format";

const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("../api/client", () => ({ api: { get: mocks.get } }));
vi.mock("react-router-dom", () => ({
  useOutletContext: () => ({ outletId: 1 }),
  Link: ({ to, children, ...rest }: any) => <a href={to} {...rest}>{children}</a>,
}));
vi.mock("recharts", () => {
  const Box = ({ children }: any) => <div>{children}</div>;
  return {
    Area: Box, AreaChart: Box, Bar: Box, BarChart: Box, CartesianGrid: Box, Cell: Box, ComposedChart: Box,
    Legend: Box, Line: Box, Pie: Box, PieChart: Box, ResponsiveContainer: Box,
    Tooltip: Box, XAxis: Box, YAxis: Box,
  };
});
vi.mock("../components/SpendReview", () => ({ default: () => <div>Spend review view</div> }));
vi.mock("../components/ProfitAndLoss", () => ({ ProfitAndLoss: () => <div>P&amp;L view</div> }));
vi.mock("../components/Patterns", () => ({
  TradePatterns: () => <div>Trade patterns</div>,
  PurchasePatterns: () => <div>Purchase patterns</div>,
}));
vi.mock("../components/KotGaps", () => ({ KotGaps: () => <div>KOT gaps</div> }));
vi.mock("../components/DataButtons", () => ({ ExportButton: () => <button>Download xlsx</button> }));
vi.mock("./MenuItems", () => ({ MenuItems: () => <div>Menu items</div> }));

import Analytics, { buildNextActions } from "./Analytics";

const DATA: any = {
  days: ["2026-09-08"],
  series: { sales_total: [1200] },
  totals: { sales_total: 1200, expenses: 400 },
  weekday_avg_sales: [0, 0, 0, 0, 0, 0, 0],
  days_recorded: 1,
  recording_coverage: {
    findings: [{ severity: "act", title: "Cash-close gap", detail: "1 day needs closing." }],
  },
};

function show(data = DATA) {
  mocks.get.mockImplementation((url: string) =>
    Promise.resolve(url.startsWith("/stats/analytics") ? data : []));
  return render(
    <QueryClientProvider client={new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })}>
      <Analytics />
    </QueryClientProvider>,
  );
}

describe("Analytics decisions", () => {
  it("leads with the fixed decision scorecard and recording quality", async () => {
    show();
    await screen.findByRole("heading", { name: /Decisions for/ });
    const sales = screen.getAllByText("Sales")[0];
    const expenses = screen.getAllByText("Expenses")[0];
    const remainder = screen.getByText("After recorded expenses");
    const recording = screen.getByText("Recording days");
    expect(sales.compareDocumentPosition(expenses) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(expenses.compareDocumentPosition(remainder) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(remainder.compareDocumentPosition(recording) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText(/not profit — imports may still be incomplete/)).toBeInTheDocument();
    expect(screen.getByText("Cash-close gap")).toBeInTheDocument();
    // Attention comes before anything that first has to be configured.
    expect(screen.getByText("What to do next").compareDocumentPosition(
      screen.getByText("Build a graph"),
    ) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByLabelText("Custom date start").compareDocumentPosition(
      screen.getByText("What to do next"),
    ) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("says when one shared rupee scale flattens a smaller metric and offers an indexed view", async () => {
    show({
      ...DATA,
      days: ["2026-09-08", "2026-09-09"],
      series: { sales_total: [100000, 120000], expenses: [4000, 3000] },
      totals: { sales_total: 220000, expenses: 7000 },
    });
    await screen.findByRole("heading", { name: /Decisions for/ });
    expect(screen.getByText(/so the smaller lines look flat/)).toHaveTextContent(/31×/);

    const indexed = screen.getByRole("button", { name: "Indexed" });
    expect(indexed).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(indexed);
    expect(indexed).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText(/100 = its average day/)).toBeInTheDocument();
    // The exact rupee totals stay on the page.
    expect(screen.getAllByText(/2,20,000/).length).toBeGreaterThan(0);
  });

  it("keeps the wide menu table in a labelled, keyboard-reachable scroll region", async () => {
    mocks.get.mockImplementation((url: string) => {
      if (url.startsWith("/stats/analytics")) return Promise.resolve(DATA);
      if (url.startsWith("/insights/menu-engineering")) {
        return Promise.resolve({ items: [{ outlet_id: 1, item: "Dosa", sales_velocity_per_day: 4,
          momentum_percent: 5, cost_status: "withheld", cost_withheld_reason: "no recipe" }] });
      }
      return Promise.resolve([]);
    });
    render(
      <QueryClientProvider client={new QueryClient({
        defaultOptions: { queries: { retry: false } },
      })}>
        <Analytics />
      </QueryClientProvider>,
    );
    const region = await screen.findByRole("region", { name: /Menu engineering table/ });
    expect(region).toHaveAttribute("tabindex", "0");
    expect(region.className).toContain("overflow-x-auto");
    expect(region.className).toContain("max-w-full");
  });

  it("hides the pie drawing from assistive tech but keeps its exact figures", async () => {
    show({
      ...DATA,
      totals: { sales_total: 1200, expenses: 400, sales_cash: 700, sales_upi: 500 },
    });
    const mix = await screen.findByRole("figure", { name: "Channel mix in range" });
    const drawing = mix.querySelector('[aria-hidden="true"]');
    expect(drawing).not.toBeNull();
    expect(mix).toHaveTextContent("₹700");
    expect(mix).toHaveTextContent("₹500");
  });

  it("shows a non-profit cashflow graph and recorded-day pulse", async () => {
    show();
    expect(await screen.findByText("Sales vs recorded expenses over time")).toBeInTheDocument();
    expect(screen.getByText("Cumulative values make the gap between money in and recorded spending visible. This is not profit."))
      .toBeInTheDocument();
    expect(screen.getByText("Typical recorded sales day")).toBeInTheDocument();
    expect(screen.getByText("Average per recorded sales day")).toBeInTheDocument();
    expect(screen.getByText("Recorded spend rate")).toBeInTheDocument();
    expect(await screen.findByText(/\+0\.0% sales vs previous \d+d/i)).toBeInTheDocument();
  });

  it("offers cost groups and imported expense categories for charting", async () => {
    show({
    ...DATA,
    series: { sales_total: [1200], food_cost: [400], expense_category_8: [60] },
    totals: { sales_total: 1200, expenses: 460, food_cost: 400, expense_category_8: 60 },
    cost_metrics: [{ key: "food_cost", label: "Food cost" }],
    expense_metrics: [{ key: "expense_category_8", label: "Water" }],
    });

    await screen.findByRole("heading", { name: /Decisions for/ });
    expect(screen.getByRole("button", { name: "Food cost" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Water" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sales vs water vs food cost" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Bars" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "This month" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "All outlets" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByLabelText("Custom date start")).toBeInTheDocument();
    expect(screen.getByLabelText("Custom date end")).toBeInTheDocument();
  });

  it("does not render zero comparison charts when the previous-period request fails", async () => {
    let analyticsCalls = 0;
    mocks.get.mockImplementation((url: string) => {
      if (url.startsWith("/stats/analytics")) {
        analyticsCalls += 1;
        return analyticsCalls === 1
          ? Promise.resolve(DATA)
          : Promise.reject(new Error("Previous period is unavailable"));
      }
      return Promise.resolve([]);
    });
    render(
      <QueryClientProvider client={new QueryClient({
        defaultOptions: { queries: { retry: false } },
      })}>
        <Analytics />
      </QueryClientProvider>,
    );
    expect(await screen.findByText("Comparison unavailable")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Previous period is unavailable");
    expect(screen.getByRole("button", { name: "Retry comparison" })).toBeInTheDocument();
    expect(screen.queryByText(/Current vs previous/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Day-by-day/)).not.toBeInTheDocument();
  });

  it("labels the calendar month used by monthly views after choosing an arbitrary range", async () => {
    show();
    await userEvent.click(await screen.findByRole("button", { name: "Today" }));
    expect(await screen.findByText(/Month-only decisions/)).toBeInTheDocument();
    expect(screen.getByText(/Spend review and P&L below represent/)).toHaveTextContent(
      /not today/i,
    );
  });

  it("withholds the non-profit remainder when the range has no sales", async () => {
    show({ ...DATA, series: { sales_total: [0] },
      totals: { sales_total: 0, expenses: 0 }, days_recorded: 0 });
    await screen.findByRole("heading", { name: /Decisions for/ });
    const tile = screen.getByText("After recorded expenses").parentElement!;
    expect(tile).toHaveTextContent("—");
    expect(tile).toHaveTextContent(/needs recorded sales/i);
    expect(tile).not.toHaveTextContent("₹0");
  });

  it("keeps an incomplete custom range local instead of requesting invalid analytics", async () => {
    show();
    await screen.findByRole("heading", { name: /Decisions for/ });
    mocks.get.mockClear();

    const start = document.querySelectorAll<HTMLInputElement>('input[type="date"]')[0];
    await userEvent.clear(start);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Choose both a valid start and end date.",
    );
    expect(mocks.get).not.toHaveBeenCalled();
  });
});

const TODAY = todayISO();
const DAY = (offset: number) => addDaysISO(TODAY, offset);
const labels = { food_cost: "Food cost", labour_cost: "Labour" };

describe("next actions from recorded data", () => {
  it("names the unrecorded days, the caveat, and the sheet that fixes them", () => {
    const [action] = buildNextActions({
      data: {
        days: [DAY(-2), DAY(-1), TODAY],
        series: { sales_total: [0, 5000, 6000], expenses: [100, 200, 300] },
        totals: { sales_total: 11000, expenses: 600 },
      },
      previous: null, today: TODAY, previousLabel: "Previous 3d", metricLabels: labels,
    });
    expect(action.rank).toBe("act");
    expect(action.title).toBe("1 of 3 days in range have no sales recorded");
    expect(action.evidence).toContain(fmtDateShort(DAY(-2)));
    expect(action.caveat).toMatch(/shut/i);
    expect(action.href).toBe(`/sales?date=${DAY(-2)}`);
  });

  it("does not count a day that has not happened yet as an unrecorded day", () => {
    const actions = buildNextActions({
      data: {
        days: [TODAY, DAY(1), DAY(2)],
        series: { sales_total: [4000, 0, 0], expenses: [900, 0, 0] },
        totals: { sales_total: 4000, expenses: 900 },
      },
      previous: null, today: TODAY, previousLabel: "Previous 3d", metricLabels: labels,
    });
    expect(actions.map((a) => a.id)).not.toContain("sales-days-unrecorded");
  });

  it("reports the biggest cost-share move against the same books last period", () => {
    const actions = buildNextActions({
      data: {
        days: [DAY(-1)],
        series: { sales_total: [100000], expenses: [40000] },
        totals: { sales_total: 100000, expenses: 40000, food_cost: 35000, labour_cost: 5000 },
      },
      previous: { totals: { sales_total: 100000, food_cost: 25000, labour_cost: 4500 } },
      today: TODAY, previousLabel: "Previous 30d", metricLabels: labels,
    });
    const move = actions.find((a) => a.id === "cost-share-food_cost")!;
    expect(move.rank).toBe("act");
    expect(move.title).toBe("Food cost takes 10.0 more points of sales than previous 30d");
    expect(move.evidence).toContain("35.0% of recorded sales now");
    expect(move.evidence).toContain("25.0%");
    expect(move.caveat).toMatch(/recorded rows only/i);
    expect(move.href).toBe("/money/unitprices");
    // Labour moved only 0.5 points, so it is not raised as a second decision.
    expect(actions.some((a) => a.id === "cost-share-labour_cost")).toBe(false);
  });

  it("sends a cash shortfall to the register rather than settling it here", () => {
    const actions = buildNextActions({
      data: {
        days: [DAY(-1)],
        series: { sales_total: [20000], expenses: [9000] },
        totals: { sales_total: 20000, expenses: 9000, sales_cash: 2000, expense_cash: 9000 },
      },
      previous: null, today: TODAY, previousLabel: "Previous 1d", metricLabels: labels,
    });
    const cash = actions.find((a) => a.id === "cash-out-exceeds-cash-in")!;
    expect(cash.rank).toBe("act");
    expect(cash.evidence).toContain("₹7,000 more out than in");
    expect(cash.caveat).toMatch(/float|withdrawal/i);
    expect(cash.href).toBe(`/money/cash?date=${DAY(-1)}`);
    // Worst first: the cash gap outranks the recording gaps in the same range.
    expect(actions[0].rank).toBe("act");
  });

  it("flags a single outlier spend day for reading, not for conclusions", () => {
    const actions = buildNextActions({
      data: {
        days: [DAY(-5), DAY(-4), DAY(-3), DAY(-2), DAY(-1)],
        series: {
          sales_total: [20000, 20000, 20000, 20000, 20000],
          expenses: [2000, 2000, 2000, 2000, 40000],
        },
        totals: { sales_total: 100000, expenses: 48000 },
      },
      previous: null, today: TODAY, previousLabel: "Previous 5d", metricLabels: labels,
    });
    const outlier = actions.find((a) => a.id === "spend-day-outlier")!;
    expect(outlier.rank).toBe("check");
    expect(outlier.title).toContain("₹40,000");
    expect(outlier.evidence).toContain("20.0× the ₹2,000 middle day");
    expect(outlier.caveat).toMatch(/duplicated entry|decimal/i);
    expect(outlier.href).toBe("/money/expenses");
  });

  it("withholds per-bill work when bill counts are absent, and stays quiet on complete books", () => {
    const complete = {
      days: [DAY(-1)],
      series: { sales_total: [20000], expenses: [4000] },
      totals: { sales_total: 20000, expenses: 4000 },
      bill_metrics_available: true,
    };
    expect(buildNextActions({
      data: complete, previous: null, today: TODAY,
      previousLabel: "Previous 1d", metricLabels: labels,
    })).toEqual([]);

    const [withoutBills] = buildNextActions({
      data: { ...complete, bill_metrics_available: false },
      previous: null, today: TODAY, previousLabel: "Previous 1d", metricLabels: labels,
    });
    expect(withoutBills.id).toBe("bill-counts-missing");
    expect(withoutBills.title).toMatch(/cannot be shown/i);
    expect(withoutBills.href).toBe("/sales/import");
  });

  it("renders each action with its evidence, its caveat and a link out — never a money control", async () => {
    show({
      ...DATA,
      days: [DAY(-2), DAY(-1)],
      series: { sales_total: [0, 5000], expenses: [0, 1000] },
      totals: { sales_total: 5000, expenses: 1000, sales_cash: 0, expense_cash: 2000 },
      days_recorded: 1,
    });
    const list = await screen.findByRole("list", { name: "Next actions" });
    expect(within(list).getByText("1 of 2 days in range have no sales recorded"))
      .toBeInTheDocument();
    expect(within(list).getAllByText(/Before you act/)).toHaveLength(2);
    const link = within(list).getByRole("link", {
      name: new RegExp(`Open the sales sheet for ${fmtDateShort(DAY(-2))}`),
    });
    expect(link).toHaveAttribute("href", `/sales?date=${DAY(-2)}`);
    expect(within(list).getByRole("link", { name: /Open the cash register/ }))
      .toHaveAttribute("href", `/money/cash?date=${DAY(-1)}`);
    // Rupees inside the evidence sentence are still set as figures.
    expect(list.querySelector(".num")).toHaveTextContent("₹2,000");
    // Analytics explains; it never books an entry on the owner's behalf.
    expect(within(list).queryAllByRole("button")).toHaveLength(0);
    // The supplied recording-quality findings still stand alongside the actions.
    expect(screen.getByText("Recording quality")).toBeInTheDocument();
    expect(screen.getByText("Cash-close gap")).toBeInTheDocument();
  });

  it("says so plainly when the recorded range asks for nothing", async () => {    show({
      ...DATA,
      days: [DAY(-1)],
      series: { sales_total: [5000], expenses: [1000] },
      totals: { sales_total: 5000, expenses: 1000 },
      bill_metrics_available: true,
      days_recorded: 1,
    });
    await screen.findByText("What to do next");
    expect(screen.getByText(/asks for a next step/))
      .toHaveTextContent("not a verdict on the business");
    expect(screen.queryByRole("list", { name: "Next actions" })).not.toBeInTheDocument();
  });

  it("keeps the action list structurally sound and every control named", async () => {
    const { container } = show({
      ...DATA,
      days: [DAY(-2), DAY(-1)],
      series: { sales_total: [0, 5000], expenses: [0, 1000] },
      totals: { sales_total: 5000, expenses: 1000, sales_cash: 0, expense_cash: 2000 },
      days_recorded: 1,
    });
    await screen.findByRole("list", { name: "Next actions" });

    const result = await axe.run(container, {
      runOnly: ["cat.name-role-value", "cat.structure"],
      rules: { "color-contrast": { enabled: false } },
    });
    expect(result.violations.map((violation) => violation.id)).toEqual([]);
  });
});
