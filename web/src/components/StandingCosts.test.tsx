import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CostGroupsCard, HealthyBandsCard, StandingCostsCard } from "./StandingCosts";

const mocks = vi.hoisted(() => ({
  get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn(),
}));
vi.mock("../api/client", () => ({ api: mocks }));
vi.mock("../lib/auth", () => ({ useGuarded: () => (fn: () => any) => fn() }));

const BANDS = {
  items: [
    { key: "cogs", label: "Food & beverage cost", hint: "Everything you buy to sell.",
      low: 28, high: 35, default_low: 28, default_high: 35, is_custom: false },
    { key: "labour", label: "Labour", hint: "Wages, staff food and welfare.",
      low: 20, high: 25, default_low: 20, default_high: 25, is_custom: false },
    { key: "prime", label: "Prime cost", hint: "Food + labour.",
      low: 55, high: 60, default_low: 55, default_high: 60, is_custom: false },
    { key: "occupancy", label: "Rent & occupancy", hint: "Rent, licences, insurance.",
      low: 6, high: 10, default_low: 6, default_high: 10, is_custom: false },
    { key: "operating", label: "Running costs", hint: "Power, gas, water.",
      low: 8, high: 14, default_low: 8, default_high: 14, is_custom: false },
    { key: "admin", label: "Other", hint: "Anything else.",
      low: 1, high: 3, default_low: 1, default_high: 3, is_custom: false },
  ],
};

const RECURRING = {
  monthly_total_rupees: 46200,
  yearly_total_rupees: 554400,
  items: [
    { id: 1, name: "Shop rent", category: "Rent", category_id: 3,
      amount_rupees: 45000, yearly_rupees: 540000, day_of_month: 5,
      is_active: true, start_month: "2026-01", end_month: null },
    { id: 2, name: "Broadband", category: "Internet & Phone", category_id: 7,
      amount_rupees: 1200, yearly_rupees: 14400, day_of_month: 8,
      is_active: true, start_month: "2026-01", end_month: null },
    { id: 3, name: "Old signboard rent", category: "Rent", category_id: 3,
      amount_rupees: 2000, yearly_rupees: 24000, day_of_month: 1,
      is_active: false, start_month: "2025-01", end_month: "2025-12" },
  ],
};

const CATEGORIES = [
  { id: 3, name: "Rent", is_active: true, cost_group: "occupancy",
    cost_group_label: "Rent & occupancy" },
  { id: 7, name: "Internet & Phone", is_active: true, cost_group: "operating",
    cost_group_label: "Running costs" },
  { id: 9, name: "Vegetables & Fruits", is_active: true, cost_group: "cogs_food",
    cost_group_label: "Food cost" },
];

const GROUPS = [
  { key: "cogs_food", label: "Food cost", hint: "Everything on a plate." },
  { key: "occupancy", label: "Rent & occupancy", hint: "The cost of the address." },
  { key: "operating", label: "Running costs", hint: "Power, gas, water." },
];

function show(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function route(map: Record<string, any>) {
  mocks.get.mockImplementation((url: string) => {
    for (const [key, value] of Object.entries(map)) {
      if (url.startsWith(key)) return Promise.resolve(value);
    }
    return Promise.reject(new Error(`unrouted ${url}`));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.put.mockResolvedValue(BANDS);
  mocks.post.mockResolvedValue({ id: 9, posted_now: 1 });
  mocks.del.mockResolvedValue({ ok: true });
  mocks.patch.mockResolvedValue({ ok: true });
});

describe("standing costs", () => {
  beforeEach(() => route({ "/recurring": RECURRING, "/lists/categories": CATEGORIES }));

  it("shows what repeats every month and what it adds up to", async () => {
    show(<StandingCostsCard />);
    expect(await screen.findByText("Shop rent")).toBeInTheDocument();
    expect(screen.getByText("₹46,200 a month")).toBeInTheDocument();
  });

  it("shows the yearly weight of a monthly cost, which is what stings", async () => {
    show(<StandingCostsCard />);
    expect(await screen.findByText(/₹5,40,000\/year/)).toBeInTheDocument();
  });

  it("does not list a cost the owner already stopped", async () => {
    show(<StandingCostsCard />);
    await screen.findByText("Shop rent");
    expect(screen.queryByText("Old signboard rent")).not.toBeInTheDocument();
  });

  it("says plainly that stopped costs keep the months they paid", async () => {
    show(<StandingCostsCard />);
    expect(await screen.findByText(/keep the months they already posted/))
      .toBeInTheDocument();
  });

  it("warns an empty shop that its rent is missing from every report", async () => {
    route({ "/recurring": { monthly_total_rupees: 0, yearly_total_rupees: 0, items: [] },
            "/lists/categories": CATEGORIES });
    show(<StandingCostsCard />);
    expect(await screen.findByText(/your rent is missing from every report/))
      .toBeInTheDocument();
  });

  it("stops the cost the owner clicked, not merely some cost", async () => {
    show(<StandingCostsCard />);
    fireEvent.click(await screen.findByLabelText("Stop Broadband"));
    await waitFor(() => expect(mocks.del).toHaveBeenCalledWith("/recurring/2"));
  });

  it("says so when the list cannot be loaded rather than showing nothing", async () => {
    route({ "/lists/categories": CATEGORIES });
    show(<StandingCostsCard />);
    expect(await screen.findByText(/Couldn't load your standing costs/))
      .toBeInTheDocument();
  });
});

describe("cost groups", () => {
  beforeEach(() => route({ "/lists/categories": CATEGORIES, "/lists/cost-groups": GROUPS }));

  it("shows which P&L line each category lands on", async () => {
    show(<CostGroupsCard />);
    const row = (await screen.findByText("Rent")).closest("li")!;
    expect(row.querySelector("select")).toHaveValue("occupancy");
  });

  it("retags a category when the owner disagrees", async () => {
    show(<CostGroupsCard />);
    const row = (await screen.findByText("Rent")).closest("li")!;
    fireEvent.change(row.querySelector("select")!, { target: { value: "operating" } });
    await waitFor(() => expect(mocks.patch).toHaveBeenCalled());
    expect(mocks.patch.mock.calls[0][1]).toMatchObject({ cost_group: "operating" });
  });
});

describe("healthy bands", () => {
  beforeEach(() => route({ "/pnl/bands": BANDS }));

  it("shows every line with its band", async () => {
    show(<HealthyBandsCard />);
    expect(await screen.findByText("Prime cost")).toBeInTheDocument();
    expect(screen.getByLabelText("Prime cost low")).toHaveValue("55");
    expect(screen.getByLabelText("Prime cost high")).toHaveValue("60");
  });

  it("explains what each band is for, so the numbers are not naked", async () => {
    show(<HealthyBandsCard />);
    expect(await screen.findByText("Wages, staff food and welfare."))
      .toBeInTheDocument();
  });

  it("will not save until something is actually changed", async () => {
    show(<HealthyBandsCard />);
    expect(await screen.findByText("Save bands")).toBeDisabled();
  });

  it("saves every line, not only the edited one, so nothing drifts", async () => {
    show(<HealthyBandsCard />);
    fireEvent.change(await screen.findByLabelText("Rent & occupancy low"),
                     { target: { value: "12" } });
    fireEvent.change(screen.getByLabelText("Rent & occupancy high"),
                     { target: { value: "20" } });
    fireEvent.click(screen.getByText("Save bands"));
    await waitFor(() => expect(mocks.put).toHaveBeenCalled());
    const [url, body] = mocks.put.mock.calls[0];
    expect(url).toBe("/pnl/bands");
    expect(body.occupancy).toEqual([12, 20]);
    expect(body.labour).toEqual([20, 25]);
  });

  it("refuses a reversed band before it reaches the server", async () => {
    show(<HealthyBandsCard />);
    fireEvent.change(await screen.findByLabelText("Labour low"),
                     { target: { value: "40" } });
    fireEvent.click(screen.getByText("Save bands"));
    expect(await screen.findByText(/Labour: give a low and a high/)).toBeInTheDocument();
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it("refuses a band that is not a share of sales", async () => {
    show(<HealthyBandsCard />);
    fireEvent.change(await screen.findByLabelText("Labour high"),
                     { target: { value: "140" } });
    fireEvent.click(screen.getByText("Save bands"));
    expect(await screen.findByText(/between 0 and 100/)).toBeInTheDocument();
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it("refuses words where a number belongs", async () => {
    show(<HealthyBandsCard />);
    fireEvent.change(await screen.findByLabelText("Labour low"),
                     { target: { value: "abc" } });
    fireEvent.click(screen.getByText("Save bands"));
    expect(await screen.findByText(/Labour: give a low and a high/)).toBeInTheDocument();
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it("offers a way back to standard once a shop has its own bands", async () => {
    route({ "/pnl/bands": { items: BANDS.items.map((b, i) =>
      i === 3 ? { ...b, low: 12, high: 20, is_custom: true } : b) } });
    show(<HealthyBandsCard />);
    fireEvent.click(await screen.findByText("Back to standard"));
    await waitFor(() => expect(mocks.put).toHaveBeenCalled());
    expect(mocks.put.mock.calls[0][1].occupancy).toEqual([6, 10]);
  });

  it("hides the way back when nothing has been changed", async () => {
    show(<HealthyBandsCard />);
    await screen.findByText("Prime cost");
    expect(screen.queryByText("Back to standard")).not.toBeInTheDocument();
  });

  it("passes the server's complaint on instead of swallowing it", async () => {
    mocks.put.mockRejectedValue(new Error("Labour: give a low and a high."));
    show(<HealthyBandsCard />);
    fireEvent.change(await screen.findByLabelText("Labour low"),
                     { target: { value: "21" } });
    fireEvent.click(screen.getByText("Save bands"));
    expect(await screen.findByText(/Labour: give a low and a high/)).toBeInTheDocument();
  });

  it("says so when the bands cannot be loaded", async () => {
    route({});
    show(<HealthyBandsCard />);
    expect(await screen.findByText(/Couldn't load the bands/)).toBeInTheDocument();
  });
});
