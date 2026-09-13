import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("../api/client", () => ({ api: { get: mocks.get } }));
vi.mock("react-router-dom", () => ({ useOutletContext: () => ({ outletId: 1 }) }));
vi.mock("../components/DataButtons", () => ({ ExportButton: () => null }));

import UnitPrices from "./UnitPrices";

describe("Unit Prices", () => {
  it("uses the real final day of the selected month", async () => {
    mocks.get.mockResolvedValue([]);
    const now = new Date();
    const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const last = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();

    render(
      <QueryClientProvider client={new QueryClient({
        defaultOptions: { queries: { retry: false } },
      })}>
        <UnitPrices />
      </QueryClientProvider>,
    );

    await screen.findByText(/No quantity-tracked purchases this month/i);
    expect(mocks.get).toHaveBeenCalledWith(
      `/insights/unit-economics?start=${period}-01&end=${period}-${String(last).padStart(2, "0")}&outlet_id=1`,
    );
  });

  it("keeps the desktop table and adds a narrow-screen card per purchase", async () => {
    mocks.get.mockResolvedValue([{
      item: "Tomato", category: "Vegetables", unit: "kg", trend_percent: 3,
      avg_unit_price: 30, purchases_count: 2, cheapest_unit_price: 25,
      purchases: [
        { date: "2026-09-02", vendor: "Mart A", qty: 10, unit: "kg", total_rupees: 350, unit_price_rupees: 35 },
        { date: "2026-09-05", vendor: "Mart B", qty: 4, unit: "kg", total_rupees: 100, unit_price_rupees: 25 },
      ],
    }]);

    const { container } = render(
      <QueryClientProvider client={new QueryClient({
        defaultOptions: { queries: { retry: false } },
      })}>
        <UnitPrices />
      </QueryClientProvider>,
    );

    // The table survives at sm+ ...
    const table = await screen.findByRole("table");
    expect(table.className).toContain("sm:table");
    expect(table.className).toContain("hidden");

    // ... and below sm every purchase is a readable two-line card that still
    // names the quantity, the total, and the per-unit price it was bought at.
    const cards = container.querySelectorAll("ul.sm\\:hidden > li");
    expect(cards).toHaveLength(2);
    const cheapest = cards[1] as HTMLElement;
    expect(within(cheapest).getByText("Mart B")).toBeInTheDocument();
    expect(within(cheapest).getByText("4 kg")).toBeInTheDocument();
    expect(within(cheapest).getByText("total ₹100")).toBeInTheDocument();
    expect(within(cheapest).getByText("₹25/kg")).toBeInTheDocument();
    // The cheapest cue survives the collapse.
    expect(within(cheapest).getByText("cheapest")).toBeInTheDocument();
    expect(within(cards[0] as HTMLElement).queryByText("cheapest")).toBeNull();
  });
});
