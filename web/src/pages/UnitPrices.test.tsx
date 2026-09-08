import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
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
});
