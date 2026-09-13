import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import InventoryCounts from "./InventoryCounts";

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));

vi.mock("../api/client", () => ({ api: mocks }));
vi.mock("../lib/auth", () => ({
  useGuarded: () => (fn: () => unknown) => fn(),
}));

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <Routes>
          <Route element={<Outlet context={{ outletId: 7 }} />}>
            <Route index element={<InventoryCounts />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mocks.get.mockReset();
  mocks.post.mockReset();
  mocks.get.mockResolvedValue({
    counts: [{
      id: 1, date: "2026-09-01", variance_value_paise: -1500,
      lines: [{ stock_item_id: 3, name: "Tomato", theoretical_qty: 5, physical_qty: 4, variance_qty: -1 }],
    }],
  });
  mocks.post.mockResolvedValue({ count_id: 12 });
});

describe("inventory count history", () => {
  it("shows completed counts before a new count is started", async () => {
    renderPage();
    expect(await screen.findByRole("heading", { name: "Count variance history" })).toBeInTheDocument();
    expect(screen.getByText("Tomato")).toBeInTheDocument();
  });

  it("uses a non-future count date and names each stock input", async () => {
    const user = userEvent.setup();
    mocks.get.mockImplementation((path: string) => Promise.resolve(
      path.startsWith("/inventory/count/12")
        ? {
          business_date: "2026-09-13", status: "draft",
          lines: [{ stock_item_id: 3, name: "Tomato", base_unit: "kg", system_qty: 5 }],
        }
        : { counts: [] },
    ));
    renderPage();

    expect(screen.getByLabelText("Count date")).toHaveAttribute("max");
    await user.click(screen.getByRole("button", { name: "Start a count" }));
    expect(mocks.post).toHaveBeenCalledWith(
      expect.stringContaining("business_date="),
    );
    expect(await screen.findByLabelText("Counted kg for Tomato")).toBeInTheDocument();
  });

  it("still lists a count taken just after midnight in Kolkata", async () => {
    // 19:00 UTC is already 00:30 the next day in Asia/Kolkata. A UTC "today"
    // ends the history a day early, hiding the count just finished.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-09-13T19:00:00Z"));
    try {
      renderPage();
      await waitFor(() => expect(mocks.get).toHaveBeenCalledWith(
        expect.stringContaining("end=2026-09-14")));
    } finally {
      vi.useRealTimers();
    }
  });
});
