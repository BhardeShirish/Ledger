import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import Bills from "./Bills";
import CashRegister from "./CashRegister";
import InventoryOverview from "./InventoryOverview";
import PayrollRunDetail from "./PayrollRunDetail";
import PersonDetail from "./PersonDetail";
import VendorDetail from "./VendorDetail";

const mocks = vi.hoisted(() => ({
  del: vi.fn(), get: vi.fn(), patch: vi.fn(), post: vi.fn(), put: vi.fn(),
}));

vi.mock("../api/client", () => ({ api: mocks }));
vi.mock("../lib/auth", () => ({
  useAuth: () => ({ me: { role: "owner", username: "owner" } }),
  useGuarded: () => (fn: () => unknown) => fn(),
}));

function renderPage(page: ReactNode, path = "/") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <Routes>
          <Route element={<Outlet context={{ outletId: 7 }} />}>
            <Route path="/" element={page} />
            <Route path="/staff/people/:id" element={page} />
            <Route path="/vendors/:id" element={page} />
            <Route path="/staff/payroll/:id" element={page} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  mocks.get.mockReset();
});

describe("required operational data failures", () => {
  it("shows an error and retry instead of an empty bills table", async () => {
    mocks.get.mockRejectedValue(new Error("offline"));
    renderPage(<Bills />);
    expect(await screen.findByRole("button", { name: "Retry bills" })).toBeInTheDocument();
    expect(screen.queryByText("No bills found")).not.toBeInTheDocument();
  });

  it("shows an error and retry instead of healthy stock evidence", async () => {
    mocks.get.mockRejectedValue(new Error("offline"));
    renderPage(<InventoryOverview />);
    expect(await screen.findByRole("button", { name: "Retry stock evidence" })).toBeInTheDocument();
    expect(screen.queryByText("No credible reorder risk is available yet.")).not.toBeInTheDocument();
  });

  it("shows an error and retry instead of an empty cash day", async () => {
    mocks.get.mockRejectedValue(new Error("offline"));
    renderPage(<CashRegister />);
    expect(await screen.findByRole("button", { name: "Retry cash day" })).toBeInTheDocument();
    expect(screen.queryByText("No closed days yet.")).not.toBeInTheDocument();
  });

  it("shows an error and retry instead of crashing on a missing staff member", async () => {
    mocks.get.mockRejectedValue(new Error("offline"));
    renderPage(<PersonDetail />, "/staff/people/9");
    expect(await screen.findByRole("button", { name: "Retry staff member" })).toBeInTheDocument();
  });

  it("shows an error and retry instead of crashing on a missing vendor ledger", async () => {
    mocks.get.mockRejectedValue(new Error("offline"));
    renderPage(<VendorDetail />, "/vendors/9");
    expect(await screen.findByRole("button", { name: "Retry vendor ledger" })).toBeInTheDocument();
  });

  it("shows an error and retry instead of crashing on a missing payroll run", async () => {
    mocks.get.mockRejectedValue(new Error("offline"));
    renderPage(<PayrollRunDetail />, "/staff/payroll/9");
    expect(await screen.findByRole("button", { name: "Retry payroll run" })).toBeInTheDocument();
  });
});
