import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), navigate: vi.fn() }));
vi.mock("../api/client", () => ({ api: { get: mocks.get, post: mocks.post } }));
vi.mock("../lib/auth", () => ({ useAuth: () => ({ me: { role: "owner" } }) }));
vi.mock("react-router-dom", () => ({
  Link: ({ children, ...props }: any) => <a {...props}>{children}</a>,
  useNavigate: () => mocks.navigate,
  useOutletContext: () => ({ outletId: 1 }),
}));

import InventoryOrder from "./InventoryOrder";

const recommendation = {
  stock_item_id: 8, item: "Rice", base_unit: "kg", current_qty: 2, min_qty: 3, par_qty: 10,
  expected_consumption_qty: 5, velocity_per_day: 0.33, days_of_cover: 6,
  reorder_recommendation_qty: 8, reorder_eligible: true, risk: "at_or_below_minimum",
  confidence: "high", caveats: ["Current stock is a live snapshot, not historical evidence for this window."],
  coverage: {},
  last_purchase_unit_cost_rupees: 80,
};

describe("Inventory order evidence", () => {
  it("separates withheld coaching and creates an owner purchase draft from selected evidence", async () => {
    mocks.get.mockImplementation((path: string) => {
      if (path.startsWith("/inventory/intelligence")) {
        return Promise.resolve({ items: [
          recommendation,
          { ...recommendation, stock_item_id: 9, item: "Unlinked oil",
            reorder_eligible: false, reorder_recommendation_qty: null,
            expected_consumption_qty: null, velocity_per_day: null, days_of_cover: null,
            risk: null, coverage: { recipes: { status: "insufficient" } } },
        ] });
      }
      if (path === "/vendors") return Promise.resolve([{ id: 4, name: "Rice supplier", is_active: true }]);
      if (path === "/lists/categories") return Promise.resolve([{ id: 5, name: "Raw materials" }]);
      return Promise.resolve([]);
    });
    mocks.post.mockResolvedValue({ id: 12, status: "draft" });
    const user = userEvent.setup();

    render(<QueryClientProvider client={new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })}><InventoryOrder /></QueryClientProvider>);

    await screen.findByText("Rice");
    expect(screen.getByText("Incomplete-data coaching")).toBeInTheDocument();
    expect(screen.getByText("Unlinked oil")).toBeInTheDocument();
    await user.click(screen.getByLabelText("Select Rice for draft"));
    await user.selectOptions(screen.getByLabelText("Supplier"), "4");
    await user.selectOptions(screen.getByLabelText("Expense category"), "5");
    await user.click(screen.getByRole("button", { name: "Create draft for 1 item" }));

    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith(
      "/purchases/orders/from-inventory-intelligence",
      expect.objectContaining({ outlet_id: 1, vendor_id: 4, category_id: 5, stock_item_ids: [8] }),
    ));
  });
});
