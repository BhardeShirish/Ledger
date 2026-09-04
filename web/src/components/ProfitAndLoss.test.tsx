import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ProfitAndLoss } from "./ProfitAndLoss";

const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("../api/client", () => ({ api: { get: mocks.get } }));

function line(key: string, label: string, rupees: number,
              pct: number | null, status: string,
              low = 28, high = 35) {
  return { key, label, rupees, percent_of_net: pct, band_low: low,
           band_high: high, status };
}

/** A shop with every cost logged and every ratio inside its band. */
const HEALTHY = {
  month: "2026-04",
  period: { start: "2026-04-01", end: "2026-04-30", partial: false,
            days_counted: 30, days_in_month: 30 },
  sales: { net_paise: 30000000, total_paise: 31500000, tax_paise: 1500000,
           bills: 600, days_open: 30, net_rupees: 300000, total_rupees: 315000,
           avg_ticket_net_rupees: 500 },
  measured_on: "net sales, excluding GST",
  payroll: { headcount: 6, monthly_rupees: 66000, period_paise: 6600000,
             prorated: false, days_counted: 30, days_in_month: 30 },
  cogs: { rupees: 90000, percent_of_net: 30, band_low: 28, band_high: 35,
          status: "good", food_share_percent: 100 },
  prime_cost: { rupees: 156000, percent_of_net: 52, band_low: 55,
                band_high: 60, danger_above: 65, status: "good" },
  lines: [
    line("cogs_food", "Food cost", 90000, 30, "good"),
    line("cogs_bev", "Beverage cost", 0, 0, "unlogged"),
    line("labour", "Labour", 66000, 22, "good", 20, 25),
    line("occupancy", "Rent & occupancy", 24000, 8, "good", 6, 10),
    line("operating", "Running costs", 30000, 10, "good", 8, 14),
    line("admin", "Other", 6000, 2, "good", 1, 3),
  ],
  totals: { cost_rupees: 216000, cost_percent_of_net: 72,
            profit_known: true, profit_unknown_why: null,
            profit_rupees: 84000, profit_percent_of_net: 28 },
  per_bill: { bills: 600, net_rupees: 500, cost_rupees: 360,
              food_cost_rupees: 150, profit_rupees: 140,
              contribution_rupees: 350 },
  breakeven: { possible: true, contribution_margin_percent: 70,
               month_rupees: 180000, day_rupees: 6000, bills_per_day: 12,
               actual_bills_per_day: 20, fixed_costs_rupees: 126000 },
  rolling_food_cost: { days: 28, start: "2026-04-03", end: "2026-04-30",
                       net_rupees: 280000, cogs_rupees: 84000,
                       percent_of_net: 30 },
  sensitivity: [
    { lever: "Serve 5 more bills a day", monthly_rupees: 52500,
      assumed_food_cost_percent: null, how: "At today's ₹500 average bill." },
  ],
  budgets: [],
  data_quality: { missing_groups: [], costs_complete: true, cogs_logged: true,
                  staff_meal_entries: 0, staff_meals_in_food_rupees: 0,
                  possible_double_counted_salary: [], has_sales: true,
                  payroll_from_staff_master: true },
  findings: [
    { severity: "good", title: "Prime cost is 52% — inside the healthy band",
      detail: "Food and labour together are under 60%." },
  ],
};

/** The same shop before it logged its rent — the dangerous case. */
const UNTRUSTWORTHY = {
  ...HEALTHY,
  prime_cost: { ...HEALTHY.prime_cost, rupees: 66000, percent_of_net: 22,
                status: "unlogged" },
  lines: [
    line("cogs_food", "Food cost", 0, 0, "unlogged"),
    line("cogs_bev", "Beverage cost", 0, 0, "unlogged"),
    line("labour", "Labour", 66000, 22, "good", 20, 25),
    line("occupancy", "Rent & occupancy", 0, 0, "unlogged", 6, 10),
    line("operating", "Running costs", 0, 0, "unlogged", 8, 14),
    line("admin", "Other", 0, 0, "unlogged", 1, 3),
  ],
  totals: { cost_rupees: 66000, cost_percent_of_net: 22,
            profit_known: false,
            profit_unknown_why:
              "Not shown: nothing believable is logged for Food cost, " +
              "Rent & occupancy, so any figure here would flatter you " +
              "rather than inform you.",
            profit_rupees: null, profit_percent_of_net: null },
  per_bill: { bills: 600, net_rupees: 500, cost_rupees: 110,
              food_cost_rupees: null, profit_rupees: null,
              contribution_rupees: null },
  breakeven: { possible: false, why: "Not shown: nothing believable is logged." },
  sensitivity: [
    { lever: "Serve 5 more bills a day", monthly_rupees: 51375,
      assumed_food_cost_percent: 31.5,
      how: "At today's ₹500 average bill. Assumes a 31.5% food cost, " +
           "since yours is not logged yet." },
  ],
  data_quality: { ...HEALTHY.data_quality, costs_complete: false,
                  cogs_logged: false,
                  missing_groups: ["Food cost", "Rent & occupancy"] },
  findings: [
    { severity: "act", title: "These figures are not yet trustworthy",
      detail: "Nothing has been logged this month for: Rent & occupancy." },
  ],
};

function show(data: any) {
  mocks.get.mockResolvedValue(data);
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <ProfitAndLoss month="2026-04" outletId={null} />
    </QueryClientProvider>,
  );
}

beforeEach(() => mocks.get.mockReset());

describe("the P&L", () => {
  it("names every cost line with its share of sales", async () => {
    show(HEALTHY);
    const food = (await screen.findByText("Food cost")).closest("tr")!;
    expect(food.querySelectorAll("td")[2].textContent).toBe("30%");
    const labour = screen.getByText("Labour").closest("tr")!;
    expect(labour.querySelectorAll("td")[2].textContent).toBe("22%");
    const prime = screen.getByText("Prime cost").closest("tr")!;
    expect(prime.querySelectorAll("td")[2].textContent).toBe("52%");
  });

  it("says out loud that ratios exclude GST", async () => {
    show(HEALTHY);
    expect(await screen.findByText(/excluding GST/)).toBeInTheDocument();
  });

  it("shows the profit and the break-even once the costs are all in", async () => {
    show(HEALTHY);
    expect(await screen.findByText("₹84,000")).toBeInTheDocument();
    expect(screen.getByText("12 bills/day")).toBeInTheDocument();
    expect(screen.getByText(/you serve 20 a day/)).toBeInTheDocument();
  });

  it("withholds break-even when the food costs more than it sells for", async () => {
    // Reachable and real: every cost is logged, so profit is known and
    // negative, but there is no volume at which this shop breaks even.
    show({
      ...HEALTHY,
      totals: { ...HEALTHY.totals, profit_rupees: -40000,
                profit_percent_of_net: -13.3 },
      breakeven: { possible: false,
                   why: "Ingredients cost more than the food sells for." },
    });
    expect(await screen.findByText("Break even")).toBeInTheDocument();
    const tile = screen.getByText("Break even").closest("div")!;
    expect(tile.textContent).toContain("—");
    expect(tile.textContent).toContain("cost more than the food sells for");
    expect(tile.textContent).not.toMatch(/bills\/day/);
  });

  it("hides the profit while costs are missing", async () => {
    show(UNTRUSTWORTHY);
    expect(await screen.findByText("Not shown yet")).toBeInTheDocument();
    expect(screen.getByText(/flatter you/)).toBeInTheDocument();
    expect(screen.queryByText("Left over")).not.toBeInTheDocument();
  });

  it("hides the break-even while costs are missing", async () => {
    show(UNTRUSTWORTHY);
    await screen.findByText("Not shown yet");
    expect(screen.queryByText("Break even")).not.toBeInTheDocument();
    expect(screen.queryByText(/bills\/day/)).not.toBeInTheDocument();
  });

  it("never colours an unlogged cost as if it were good news", async () => {
    show(UNTRUSTWORTHY);
    const cell = (await screen.findByText("Rent & occupancy"))
      .closest("tr")!.querySelectorAll("td")[2];
    expect(cell.className).toContain("text-ink-faint");
    expect(cell.className).not.toContain("text-good");
  });

  it("calls a healthy cost good and an unlogged one not logged", async () => {
    show(HEALTHY);
    await screen.findByText("Food cost");
    expect(screen.getAllByText("healthy").length).toBeGreaterThan(0);
    expect(screen.getByText("not logged")).toBeInTheDocument();
  });

  it("leads the findings with the loudest one", async () => {
    show(UNTRUSTWORTHY);
    expect(
      await screen.findByText("These figures are not yet trustworthy"),
    ).toBeInTheDocument();
  });

  it("states the assumption behind a lever when food cost is unknown", async () => {
    show(UNTRUSTWORTHY);
    expect(await screen.findByText(/not logged yet/)).toBeInTheDocument();
    expect(screen.getByText("₹51,375")).toBeInTheDocument();
  });

  it("shows a lever with no caveat once food cost is known", async () => {
    show(HEALTHY);
    expect(await screen.findByText("₹52,500")).toBeInTheDocument();
    expect(screen.queryByText(/not logged yet/)).not.toBeInTheDocument();
  });

  it("reports food cost on a rolling window, not just the month", async () => {
    show(HEALTHY);
    const block = (await screen.findByText(/last 28 days/)).parentElement!;
    expect(block.textContent).toContain("30%");
    expect(block.textContent).toContain("₹84,000 of ₹2,80,000");
    expect(block.textContent).toMatch(/one bulk order near a month end/);
  });

  it("says where the wage bill came from", async () => {
    show(HEALTHY);
    expect(await screen.findByText(/6 people/)).toBeInTheDocument();
    expect(screen.getByText(/₹66,000 a month/)).toBeInTheDocument();
  });

  it("flags a part month rather than comparing it to a whole one", async () => {
    show({
      ...HEALTHY,
      period: { ...HEALTHY.period, partial: true, days_counted: 11 },
      payroll: { ...HEALTHY.payroll, prorated: true },
    });
    expect(await screen.findByText(/11 of 30 days/)).toBeInTheDocument();
    expect(screen.getByText(/pro rata/)).toBeInTheDocument();
  });

  it("says so plainly when there are no sales", async () => {
    show({ ...HEALTHY, sales: { ...HEALTHY.sales, bills: 0 } });
    expect(
      await screen.findByText(/No sales recorded for this month/),
    ).toBeInTheDocument();
  });

  it("shows budgets only when some are set", async () => {
    show(HEALTHY);
    await screen.findByText("Food cost");
    expect(screen.queryByText("Against your budgets")).not.toBeInTheDocument();
  });

  it("marks a budget that is already spent", async () => {
    show({
      ...HEALTHY,
      budgets: [{ category: "Vegetables", budget_rupees: 2000,
                  spent_rupees: 3200, left_rupees: -1200,
                  used_percent: 160, over: true }],
    });
    const row = (await screen.findByText("Vegetables")).closest("li")!;
    expect(row.querySelector(".text-bad")).not.toBeNull();
  });
});
