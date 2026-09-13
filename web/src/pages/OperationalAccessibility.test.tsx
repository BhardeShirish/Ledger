import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import AttendanceGrid from "./AttendanceGrid";
import SalesSheet from "./SalesSheet";

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn() }));

vi.mock("../api/client", () => ({ api: mocks }));
vi.mock("../components/DataButtons", () => ({
  ExportButton: () => null,
  ImportButtons: () => null,
}));
vi.mock("../components/Layout", () => ({
  useDraftGuard: () => ({ registerDirtyDraft: vi.fn(), requestDiscard: (fn: () => void) => fn() }),
}));
vi.mock("../lib/auth", () => ({
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
});

describe("daily operations accessibility labels", () => {
  it("names sales numeric inputs by their payment channel", async () => {
    mocks.get.mockResolvedValue({
      rows: [
        { channel_kind: "cash", manual_amount_rupees: null, effective_rupees: null },
        { channel_kind: "upi", manual_amount_rupees: null, effective_rupees: null },
      ],
      total_rupees: 0, losses_rupees: 0, losses: [], loss_kinds: [],
    });
    renderPage(<SalesSheet />);

    expect(await screen.findByLabelText("Sales amount for Cash")).toBeInTheDocument();
    expect(screen.getByLabelText("Sales amount for UPI")).toBeInTheDocument();
    expect(screen.getByLabelText("Loss or refund amount")).toBeInTheDocument();
  });

  it("names week navigation controls for screen-reader users", async () => {
    mocks.get.mockImplementation((path: string) => Promise.resolve(
      path === "/staff/shifts" ? [] : { employees: [] },
    ));
    renderPage(<AttendanceGrid />);

    expect(await screen.findByRole("button", { name: "Show previous week" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show next week" })).toBeInTheDocument();
  });
});
