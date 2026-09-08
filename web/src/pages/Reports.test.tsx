import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("../api/client", () => ({ api: { get: mocks.get } }));
vi.mock("../lib/auth", () => ({
  useAuth: () => ({ me: { role: "owner", outlet_ids: [1, 2] } }),
  useGuarded: () => (fn: () => unknown) => fn(),
}));
vi.mock("react-router-dom", () => ({ useOutletContext: () => ({ outletId: 1 }) }));
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
};

describe("Reports outlet benchmark", () => {
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
});
