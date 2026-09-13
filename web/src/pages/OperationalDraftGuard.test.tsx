import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import AttendanceGrid from "./AttendanceGrid";
import InventoryCounts from "./InventoryCounts";
import InventoryItems from "./InventoryItems";
import PurchaseOrders from "./PurchaseOrders";
import VendorsList from "./VendorsList";

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn() }));

// A stand-in for the Layout draft guard that records what pages register and
// answers requestDiscard the way the real "Keep unsaved work?" sheet does.
const guard = vi.hoisted(() => ({
  draft: null as null | { label: string; discard: () => void },
  asked: 0,
  keepWorking: false,
  reset() { guard.draft = null; guard.asked = 0; guard.keepWorking = false; },
}));

vi.mock("../api/client", () => ({ api: mocks, downloadFile: vi.fn() }));
vi.mock("../components/DataButtons", () => ({
  ExportButton: () => null,
  ImportButtons: () => null,
}));
vi.mock("../components/Layout", () => ({
  useDraftGuard: () => ({
    registerDirtyDraft: (draft: null | { label: string; discard: () => void }) => {
      guard.draft = draft;
    },
    requestDiscard: (action: () => void) => {
      if (!guard.draft) { action(); return; }
      guard.asked += 1;
      if (guard.keepWorking) return;
      guard.draft.discard();
      guard.draft = null;
      action();
    },
  }),
}));
vi.mock("../lib/auth", () => ({
  useAuth: () => ({ me: { role: "owner" } }),
  useGuarded: () => (fn: () => unknown) => fn(),
}));
vi.mock("../lib/useDateParam", () => ({
  useDateParam: () => ["2026-09-13", vi.fn()],
}));

function renderPage(page: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <Routes>
          <Route element={<Outlet context={{ outletId: 7 }} />}>
            <Route index element={page} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mocks.get.mockReset();
  mocks.post.mockReset();
  mocks.put.mockReset();
  mocks.patch.mockReset();
  guard.reset();
});

describe("unsaved drafts in operational sheets", () => {
  it("guards a typed vendor, and clears the guard once it saves", async () => {
    const user = userEvent.setup();
    mocks.get.mockResolvedValue([]);
    mocks.post.mockResolvedValue({ id: 1 });
    renderPage(<VendorsList />);

    await user.click(await screen.findByRole("button", { name: "+ Vendor" }));
    expect(guard.draft).toBeNull();                  // untouched form never warns

    await user.type(screen.getByLabelText("Name"), "Green Mart");
    expect(guard.draft?.label).toBe("new vendor");

    await user.click(screen.getByRole("button", { name: "Save vendor" }));
    await waitFor(() => expect(guard.draft).toBeNull());
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("asks before closing a typed vendor and keeps the draft on 'keep working'", async () => {
    const user = userEvent.setup();
    mocks.get.mockResolvedValue([]);
    renderPage(<VendorsList />);

    await user.click(await screen.findByRole("button", { name: "+ Vendor" }));
    await user.type(screen.getByLabelText("Name"), "Green Mart");

    guard.keepWorking = true;
    await user.click(screen.getAllByRole("button", { name: "Close New vendor" })[0]);
    expect(guard.asked).toBe(1);
    expect(screen.getByLabelText("Name")).toHaveValue("Green Mart");

    guard.keepWorking = false;
    await user.click(screen.getAllByRole("button", { name: "Close New vendor" })[0]);
    expect(guard.asked).toBe(2);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(guard.draft).toBeNull();

    await user.click(screen.getByRole("button", { name: "+ Vendor" }));
    expect(screen.getByLabelText("Name")).toHaveValue("");   // discard really emptied it
  });

  it("leaves a prefilled stock-item edit clean until a field actually changes", async () => {
    const user = userEvent.setup();
    mocks.get.mockResolvedValue([{
      id: 4, name: "Onion", base_unit: "kg", current_qty: 10, min_qty: 2, par_qty: 20,
      yield_percent: 85, last_unit_price_rupees: 30, value_rupees: 300,
    }]);
    renderPage(<InventoryItems />);

    await user.click(await screen.findByRole("button", { name: "Edit Onion" }));
    expect(await screen.findByRole("dialog", { name: "Edit Onion" })).toBeInTheDocument();
    expect(guard.draft).toBeNull();

    const par = screen.getByLabelText("Par (order to)");
    await user.clear(par);
    await user.type(par, "25");
    expect(guard.draft?.label).toBe("edit of Onion");

    // Typing it back to the saved value is not a draft worth keeping.
    await user.clear(par);
    await user.type(par, "20");
    await waitFor(() => expect(guard.draft).toBeNull());
  });

  it("guards a half-entered purchase order and empties it on discard", async () => {
    const user = userEvent.setup();
    mocks.get.mockImplementation((path: string) => Promise.resolve(
      path.startsWith("/purchases/orders") ? [] : [],
    ));
    renderPage(<PurchaseOrders />);

    await user.click(await screen.findByRole("button", { name: "New order" }));
    expect(guard.draft).toBeNull();

    await user.type(screen.getByLabelText("Item 1"), "Tomato");
    expect(guard.draft?.label).toBe("purchase order draft");

    await user.click(screen.getAllByRole("button", { name: "Close Plan purchase order" })[0]);
    expect(guard.asked).toBe(1);
    await waitFor(() => expect(guard.draft).toBeNull());

    await user.click(screen.getByRole("button", { name: "New order" }));
    expect(screen.getByLabelText("Item 1")).toHaveValue("");
  });

  it("guards a half-walked shelf count until it is finished", async () => {
    const user = userEvent.setup();
    mocks.get.mockImplementation((path: string) => Promise.resolve(
      path.startsWith("/inventory/counts") ? { counts: [] }
        : { count_id: 9, business_date: "2026-09-13", status: "open",
            lines: [{ stock_item_id: 3, name: "Onion", base_unit: "kg", system_qty: 12 }] },
    ));
    mocks.post.mockImplementation((path: string) => Promise.resolve(
      path.includes("/count/start") ? { count_id: 9 } : { shrinkage_rupees: 0 },
    ));
    renderPage(<InventoryCounts />);

    await user.click(await screen.findByRole("button", { name: "Start a count" }));
    expect(await screen.findByLabelText("Counted kg for Onion")).toBeInTheDocument();
    expect(guard.draft).toBeNull();

    await user.type(screen.getByLabelText("Counted kg for Onion"), "11");
    expect(guard.draft?.label).toBe("stock count");

    await user.click(screen.getByRole("button", { name: "Finish count & true-up stock" }));
    await waitFor(() => expect(guard.draft).toBeNull());
  });

  it("guards unsaved attendance cells and drops them on discard", async () => {
    const user = userEvent.setup();
    mocks.get.mockImplementation((path: string) => Promise.resolve(
      path === "/staff/shifts"
        ? [{ id: 1, name: "Shift 1", start: "07:00", end: "15:00", start_min: 420, end_min: 900 },
           { id: 2, name: "Shift 2", start: "15:00", end: "23:00", start_min: 900, end_min: 1380 }]
        : path.startsWith("/attendance/grid")
          ? { employees: [{
              id: 5, name: "Ramesh", designation: "Chef",
              cells: [{ date: "2026-09-13", dow: 6, off_day: false, shift_name: "Shift 1",
                        scheduled_in: "07:00", row: null }],
            }] }
          : { rows: [] },
    ));
    renderPage(<AttendanceGrid />);

    expect(await screen.findAllByText("Ramesh")).not.toHaveLength(0);
    expect(guard.draft).toBeNull();

    await user.click(screen.getAllByRole("button", { name: /Ramesh/ })[0]);
    await waitFor(() => expect(guard.draft?.label).toBe("attendance changes"));

    const discard = guard.draft!.discard;
    discard();
    await waitFor(() => expect(guard.draft).toBeNull());
    expect(screen.queryByText(/change to save/)).toBeNull();
  });
});
