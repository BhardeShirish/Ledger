import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PurchasePatterns, TradePatterns } from "./Patterns";

const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("../api/client", () => ({ api: { get: mocks.get } }));

const BILLS = {
  totals: { bills: 8425, rupees: 2086625, days_open: 86,
            avg_ticket_rupees: 248, bills_without_a_time: 0 },
  hours: [
    { hour: 10, bills: 787, rupees: 231372 },
    { hour: 16, bills: 300, rupees: 78587 },
    { hour: 20, bills: 700, rupees: 217553 },
    { hour: 3, bills: 0, rupees: 0 },
  ],
  weekdays: [
    { dow: 0, name: "Monday", days_open: 12, bills: 600,
      bills_per_day: 50, rupees_per_day: 16945, rupees: 203340 },
    { dow: 6, name: "Sunday", days_open: 12, bills: 1800,
      bills_per_day: 150, rupees_per_day: 61725, rupees: 740700 },
    { dow: 3, name: "Thursday", days_open: 0, bills: 0,
      bills_per_day: 0, rupees_per_day: 0, rupees: 0 },
  ],
  months: [],
  tickets: [{ label: "Under ₹100", bills: 2600, rupees: 130000, share_percent: 31 }],
  order_types: [{ name: "Dine In", bills: 8366, rupees: 2079397,
                  avg_ticket_rupees: 248, share_percent: 99.7 }],
  channels: [],
  leakage: { discounted_bills: 0, discount_rupees: 0,
             discount_percent_of_gross: 0, tipped_bills: 0, tip_rupees: 0 },
  forecast: {
    days: [
      { date: "2026-08-26", weekday: "Wednesday", rupees: 20335, based_on_days: 8 },
      { date: "2026-08-27", weekday: "Thursday", rupees: null, based_on_days: 1 },
    ],
    week_rupees: 217017,
    unforecastable_weekdays: ["Thursday"],
    method: "median of the last 8 same weekdays",
  },
  findings: [
    { severity: "watch", title: "Sunday is worth 3.1× a Monday",
      detail: "Buy and roster for the day, not the week." },
  ],
};

const PURCHASES = {
  totals: { rupees: 18475, entries: 28, items_price_tracked: 22 },
  categories: [{ name: "Vegetables", rupees: 9000, entries: 12, share_percent: 48.7 }],
  vendors: [{ name: "Sharma Kirana", rupees: 9800, orders: 15,
              days_ordered_on: 9, share_percent: 53 }],
  items: [
    { item: "Rice", unit: "kg", also_written_as: [], times_bought: 3,
      days_bought_on: 3, avg_days_between: 7, qty: 90, rupees: 11200,
      avg_unit_price_rupees: 124, first_unit_price_rupees: 100,
      last_unit_price_rupees: 160, min_unit_price_rupees: 100,
      max_unit_price_rupees: 160, change_percent: 60, history: [] },
    { item: "Onion", unit: "kg", also_written_as: [], times_bought: 2,
      days_bought_on: 2, avg_days_between: 4, qty: 20, rupees: 800,
      avg_unit_price_rupees: 40, first_unit_price_rupees: 50,
      last_unit_price_rupees: 40, min_unit_price_rupees: 40,
      max_unit_price_rupees: 50, change_percent: -20, history: [] },
    { item: "Gas", unit: "", also_written_as: [], times_bought: 1,
      days_bought_on: 1, avg_days_between: null, qty: 1, rupees: 1100,
      avg_unit_price_rupees: 1100, first_unit_price_rupees: 1100,
      last_unit_price_rupees: 1100, min_unit_price_rupees: 1100,
      max_unit_price_rupees: 1100, change_percent: null, history: [] },
  ],
  untracked: { entries: 6, rupees: 5400 },
  name_collisions: [],
  findings: [
    { severity: "act", title: "Rice is 60% dearer than your first price",
      detail: "₹100.00/kg then, ₹160.00/kg now." },
  ],
};

function draw(node: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

beforeEach(() => mocks.get.mockReset());

describe("TradePatterns", () => {
  const show = () =>
    draw(<TradePatterns start="2026-06-01" end="2026-08-25" outletId={1} />);

  it("shows the findings and the trading shape", async () => {
    mocks.get.mockResolvedValue(BILLS);
    show();
    expect(await screen.findByText("Sunday is worth 3.1× a Monday")).toBeInTheDocument();
    expect(screen.getByText("10:00")).toBeInTheDocument();
    expect(screen.getByText("Sunday")).toBeInTheDocument();
  });

  it("hides hours and weekdays the shop was shut", async () => {
    mocks.get.mockResolvedValue(BILLS);
    show();
    await screen.findByText("10:00");
    expect(screen.queryByText("03:00")).not.toBeInTheDocument();
    expect(screen.queryByText("Thursday")).not.toBeInTheDocument();
  });

  it("shows a weekday-by-weekday forecast, not one flat number", async () => {
    mocks.get.mockResolvedValue(BILLS);
    show();
    expect(await screen.findByText("₹2,17,017")).toBeInTheDocument();
    expect(screen.getByText("Wed")).toBeInTheDocument();
    expect(screen.getByText("₹20,335")).toBeInTheDocument();
  });

  it("says nothing rather than guessing where history is thin", async () => {
    mocks.get.mockResolvedValue(BILLS);
    show();
    await screen.findByText("Thu");
    // the Thursday forecast is null and must render as a dash, not ₹0
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.queryByText("₹0")).not.toBeInTheDocument();
  });

  it("asks for the range it was given", async () => {
    mocks.get.mockResolvedValue(BILLS);
    show();
    await screen.findByText("10:00");
    expect(mocks.get).toHaveBeenCalledWith(
      "/patterns/bills?start=2026-06-01&end=2026-08-25&outlet_id=1");
  });

  it("drops the outlet filter when every outlet is in scope", async () => {
    mocks.get.mockResolvedValue(BILLS);
    draw(<TradePatterns start="2026-06-01" end="2026-08-25" outletId={null} />);
    await screen.findByText("10:00");
    expect(mocks.get).toHaveBeenCalledWith(
      "/patterns/bills?start=2026-06-01&end=2026-08-25");
  });

  it("says so plainly when there are no bills", async () => {
    mocks.get.mockResolvedValue({ ...BILLS, totals: { ...BILLS.totals, bills: 0 } });
    show();
    expect(await screen.findByText(/No bills in this period/)).toBeInTheDocument();
  });
});

describe("PurchasePatterns", () => {
  const show = () =>
    draw(<PurchasePatterns start="2026-06-01" end="2026-08-25" outletId={1} />);

  it("puts the first price beside the latest one", async () => {
    mocks.get.mockResolvedValue(PURCHASES);
    show();
    expect(await screen.findByText("Rice")).toBeInTheDocument();
    expect(screen.getByText("₹100")).toBeInTheDocument();
    expect(screen.getByText("₹160")).toBeInTheDocument();
    expect(screen.getByText("60%")).toBeInTheDocument();
  });

  it("shows a price fall as a fall, not as a rise", async () => {
    mocks.get.mockResolvedValue(PURCHASES);
    const { container } = show();
    await screen.findByText("Onion");
    const move = screen.getByText("20%").closest("span")!;
    expect(move.className).toContain("text-good");
    expect(screen.getByText("60%").closest("span")!.className).toContain("text-bad");
    expect(container.querySelectorAll("tbody tr")).toHaveLength(3);
  });

  it("leaves the price move blank for a one-off purchase", async () => {
    mocks.get.mockResolvedValue(PURCHASES);
    show();
    const gas = (await screen.findByText("Gas")).closest("tr")!;
    // the last cell is the price move; a single purchase has no move to show,
    // and "0%" would read as a price that held steady
    const move = gas.querySelectorAll("td")[6];
    expect(move.textContent).toBe("—");
    expect(gas.textContent).not.toContain("0%");
  });

  it("ranks categories and suppliers", async () => {
    mocks.get.mockResolvedValue(PURCHASES);
    show();
    expect(await screen.findByText("Vegetables")).toBeInTheDocument();
    expect(screen.getByText("Sharma Kirana")).toBeInTheDocument();
    expect(screen.getByText(/₹9,800 · 15 orders/)).toBeInTheDocument();
  });

  it("only offers 'show all' when the list is actually longer", async () => {
    mocks.get.mockResolvedValue(PURCHASES);
    show();
    await screen.findByText("Rice");
    expect(screen.queryByText(/Show all/)).not.toBeInTheDocument();

    mocks.get.mockResolvedValue({
      ...PURCHASES,
      items: Array.from({ length: 12 }, (_, i) => ({
        ...PURCHASES.items[0], item: `Item ${i}` })),
    });
    draw(<PurchasePatterns start="2026-06-01" end="2026-08-25" outletId={2} />);
    const more = await screen.findByText("Show all 12 items");
    expect(screen.queryByText("Item 11")).not.toBeInTheDocument();
    await userEvent.click(more);
    expect(screen.getByText("Item 11")).toBeInTheDocument();
  });

  it("says so plainly when nothing was bought", async () => {
    mocks.get.mockResolvedValue({
      ...PURCHASES, totals: { rupees: 0, entries: 0, items_price_tracked: 0 } });
    show();
    expect(await screen.findByText(/No purchases logged/)).toBeInTheDocument();
  });
});
