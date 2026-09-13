import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("../api/client", () => ({ api: { get: mocks.get, post: mocks.post } }));
vi.mock("../lib/auth", () => ({
  useAuth: () => ({ me: { role: "owner", outlet_ids: [1, 2] } }),
  useGuarded: () => (fn: () => unknown) => fn(),
}));
vi.mock("react-router-dom", () => ({
  useOutletContext: () => ({ outletId: 1 }),
  Link: ({ to, children, ...rest }: any) => <a href={to} {...rest}>{children}</a>,
}));
vi.mock("recharts", () => {
  const Box = ({ children }: any) => <div>{children}</div>;
  return { Area: Box, AreaChart: Box, Cell: Box, Pie: Box, PieChart: Box,
    ResponsiveContainer: Box, Tooltip: Box, XAxis: Box, YAxis: Box };
});
vi.mock("../components/EmptyMonthHint", () => ({ EmptyMonthHint: () => null }));

import Reports from "./Reports";

const DASHBOARD = {
  sales_total_rupees: 1000, expense_total_rupees: 400, payroll_accrual_rupees: 0,
  profit_rupees: 600, days_recorded: 1, avg_day_rupees: 1000, best_day: null,
  labor_cost_percent: 0, loss_total_rupees: 0, tips_rupees: 0,
  cash_variance_rupees: 0, cash_gap_days: [], trend: [], modes: [], expense_donut: [],
  profit_known: true, profit_unknown_reason: null, missing_cost_groups: [],
};

describe("Reports outlet benchmark", () => {
  it("provides labelled figures, a visible trend legend and keyboard-accessible data tables", async () => {
    mocks.get.mockImplementation((url: string) =>
      Promise.resolve(url.startsWith("/stats/dashboard") ? {
        ...DASHBOARD,
        trend: [{ date: "2026-09-01", total_rupees: 1000, expense_rupees: 400 }],
        expense_donut: [{ name: "Food", rupees: 400 }],
      } : []));
    render(
      <QueryClientProvider client={new QueryClient({
        defaultOptions: { queries: { retry: false } },
      })}>
        <Reports />
      </QueryClientProvider>,
    );

    const trend = await screen.findByRole("figure", { name: "Daily sales vs expenses" });
    expect(trend).toHaveTextContent("Sales");
    expect(trend).toHaveTextContent("Expenses");
    expect(trend).toHaveTextContent("Daily sales and expense values");
    expect(screen.getByRole("figure", { name: "Where expenses went" }))
      .toHaveTextContent("Expense breakdown values");
    expect(screen.getByRole("heading", { level: 2, name: "Cash discipline" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Sales" })).not.toBeInTheDocument();
  });

  it("keeps month-close actions reachable above the phone navigation while a queue is reviewed", async () => {
    mocks.get.mockImplementation((url: string) => {
      if (url.startsWith("/stats/dashboard")) return Promise.resolve(DASHBOARD);
      if (url.startsWith("/control/close-inbox")) {
        return Promise.resolve({
          locked: false, blockers: 1,
          items: Array.from({ length: 12 }, (_, i) => ({
            id: i, link: "/sales", date: `2026-09-${String(i + 1).padStart(2, "0")}`,
            severity: i === 0 ? "blocker" : "review", title: `Day ${i + 1} needs a look`,
            amount_paise: 1000, kind: "cash_variance",
          })),
        });
      }
      return Promise.resolve([]);
    });
    render(
      <QueryClientProvider client={new QueryClient({
        defaultOptions: { queries: { retry: false } },
      })}>
        <Reports />
      </QueryClientProvider>,
    );
    const actions = await screen.findByRole("group", { name: "Month close actions" });
    expect(actions).toContainElement(screen.getByRole("button", { name: "Close month" }));
    // `save-bar` pins above the fixed bottom tab bar and the safe area on
    // phones; `md:static` leaves the desktop card exactly as it was.
    expect(actions.className).toContain("save-bar");
    expect(actions.className).toContain("sticky");
    expect(actions.className).toContain("md:static");
    // The queue stays whole above the bar rather than being clipped by it.
    const lastItem = screen.getByText("Day 12 needs a look");
    expect(lastItem.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(actions.parentElement?.className ?? "").not.toContain("overflow-hidden");
  });

  it("keeps payment-mix rows inside their card on a narrow phone", async () => {
    mocks.get.mockImplementation((url: string) =>
      Promise.resolve(url.startsWith("/stats/dashboard") ? {
        ...DASHBOARD,
        modes: [{ kind: "aggregator", net_rupees: 1234567 }, { kind: "cash", net_rupees: 500 }],
      } : []));
    render(
      <QueryClientProvider client={new QueryClient({
        defaultOptions: { queries: { retry: false } },
      })}>
        <Reports />
      </QueryClientProvider>,
    );
    const amount = await screen.findByText("₹12,34,567");
    const row = amount.parentElement!;
    expect(row.className).toContain("flex-wrap");
    // No fixed amount column is reserved below sm:, which is what pushed the
    // row past the card edge at 320px.
    expect(amount.className).not.toMatch(/(^|\s)w-\d/);
    expect(amount.className).toContain("sm:w-24");
    expect(row.querySelector(".basis-full")).not.toBeNull();
  });

  it("does not offer a flat shared axis when sales dwarf expenses, and labels the scroll region", async () => {
    mocks.get.mockImplementation((url: string) => {
      if (url.startsWith("/stats/dashboard")) {
        return Promise.resolve({
          ...DASHBOARD,
          trend: [{ date: "2026-09-01", total_rupees: 100000, expense_rupees: 2000 },
                  { date: "2026-09-02", total_rupees: 90000, expense_rupees: 1500 }],
        });
      }
      if (url.startsWith("/insights/benchmark")) return Promise.resolve([
        { outlet_id: 1, name: "North", sales_rupees: 1000, expenses_rupees: 400,
          losses_rupees: 0, contribution_before_payroll_rupees: 600, active_days: 1,
          avg_active_day_rupees: 1000, best_weekday: "Mon" },
        { outlet_id: 2, name: "South", sales_rupees: 800, expenses_rupees: 300,
          losses_rupees: 0, contribution_before_payroll_rupees: 500, active_days: 1,
          avg_active_day_rupees: 800, best_weekday: "Tue" },
      ]);
      return Promise.resolve([]);
    });
    render(
      <QueryClientProvider client={new QueryClient({
        defaultOptions: { queries: { retry: false } },
      })}>
        <Reports />
      </QueryClientProvider>,
    );
    const trend = await screen.findByRole("figure", { name: "Daily sales vs expenses" });
    expect(trend).toHaveTextContent("Sales (left axis)");
    expect(trend).toHaveTextContent("Expenses (right axis)");
    expect(trend).toHaveTextContent(/each line has its own labelled axis/);
    // Exact figures stay available, and the drawing itself is not announced.
    expect(trend).toHaveTextContent("Daily sales and expense values");
    expect(trend.querySelector('[aria-hidden="true"].h-56')).not.toBeNull();

    const region = await screen.findByRole("region", { name: /Outlet comparison table/ });
    expect(region).toHaveAttribute("tabindex", "0");
  });

  it("calls the renamed contribution value before payroll, never profit", async () => {
    mocks.get.mockImplementation((url: string) => {
      if (url.startsWith("/stats/dashboard")) return Promise.resolve(DASHBOARD);
      if (url.startsWith("/insights/benchmark")) return Promise.resolve([
        { outlet_id: 1, name: "North", sales_rupees: 1000, expenses_rupees: 400,
          losses_rupees: 0, contribution_before_payroll_rupees: 600, active_days: 1,
          avg_active_day_rupees: 1000, best_weekday: "Mon" },
        { outlet_id: 2, name: "South", sales_rupees: 800, expenses_rupees: 300,
          losses_rupees: 0, contribution_before_payroll_rupees: 500, active_days: 1,
          avg_active_day_rupees: 800, best_weekday: "Tue" },
      ]);
      return Promise.resolve([]);
    });
    render(
      <QueryClientProvider client={new QueryClient({
        defaultOptions: { queries: { retry: false } },
      })}>
        <Reports />
      </QueryClientProvider>,
    );
    expect(await screen.findByRole("columnheader", { name: "Before payroll" }))
      .toBeInTheDocument();
    expect(screen.getByText(/Payroll is excluded, so this is not profit/)).toBeInTheDocument();
    expect(screen.getAllByText("₹600")).toHaveLength(2);
  });

  it("withholds profit and margin when the shared completeness check says costs are unknown", async () => {
    mocks.get.mockImplementation((url: string) =>
      Promise.resolve(url.startsWith("/stats/dashboard") ? {
        ...DASHBOARD,
        profit_known: false,
        profit_rupees: null,
        profit_unknown_reason: "Not shown: Food cost and rent are not recorded.",
        missing_cost_groups: ["Food cost", "Rent & occupancy"],
      } : []));
    render(
      <QueryClientProvider client={new QueryClient({
        defaultOptions: { queries: { retry: false } },
      })}>
        <Reports />
      </QueryClientProvider>,
    );
    const profit = await screen.findByText("Profit estimate");
    expect(profit.parentElement).toHaveTextContent("—");
    expect(profit.parentElement).toHaveTextContent(/Food cost and rent are not recorded/);
    const margin = screen.getByText("Net margin");
    expect(margin.parentElement).toHaveTextContent("—");
    expect(margin.parentElement).not.toHaveTextContent("₹0");
  });

  it("keeps scenario inputs and explains invalid finite values instead of submitting them", async () => {
    mocks.get.mockImplementation((url: string) => {
      if (url.startsWith("/stats/dashboard")) return Promise.resolve(DASHBOARD);
      if (url.startsWith("/insights/forecast")) {
        return Promise.resolve({ projected_rupees: 1000, scenarios: null });
      }
      return Promise.resolve([]);
    });
    render(
      <QueryClientProvider client={new QueryClient({
        defaultOptions: { queries: { retry: false } },
      })}>
        <Reports />
      </QueryClientProvider>,
    );
    const sales = await screen.findByLabelText("Sales change %");
    await userEvent.clear(sales);
    await userEvent.type(sales, "Infinity");
    await userEvent.click(screen.getByRole("button", { name: "Calculate scenario" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/finite number/i);
    expect(sales).toHaveValue("Infinity");
    expect(mocks.post).not.toHaveBeenCalled();
  });
});
