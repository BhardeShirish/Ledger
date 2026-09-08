import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("../api/client", () => ({ api: { get: mocks.get } }));
vi.mock("react-router-dom", () => ({ useOutletContext: () => ({ outletId: 1 }) }));
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

import Analytics from "./Analytics";

const DATA = {
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
    expect(screen.getByText(/not profit — payroll and other costs excluded/)).toBeInTheDocument();
    expect(screen.getByText("Cash-close gap")).toBeInTheDocument();
    expect(screen.getByText("Explore other metrics").compareDocumentPosition(
      screen.getByText("Attention & recording quality"),
    ) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
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
