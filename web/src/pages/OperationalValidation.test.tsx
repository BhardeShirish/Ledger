import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import CashRegister from "./CashRegister";
import InventoryWastage from "./InventoryWastage";
import PayrollRunDetail from "./PayrollRunDetail";
import VendorDetail from "./VendorDetail";

const mocks = vi.hoisted(() => ({
  del: vi.fn(), get: vi.fn(), patch: vi.fn(), post: vi.fn(), put: vi.fn(),
}));

vi.mock("../api/client", () => ({ api: mocks }));
vi.mock("../components/DataButtons", () => ({ ExportButton: () => null }));
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
            <Route path="/vendors/:id" element={page} />
            <Route path="/staff/payroll/:id" element={page} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mocks.del.mockReset();
  mocks.get.mockReset();
  mocks.patch.mockReset();
  mocks.post.mockReset();
  mocks.put.mockReset();
  mocks.post.mockResolvedValue({});
});

describe("operational numeric safety", () => {
  it("blocks non-finite and over-count cash closures", async () => {
    const user = userEvent.setup();
    mocks.get.mockImplementation((path: string) => Promise.resolve(
      path.startsWith("/cash/day")
        ? {
          opening_paise: 0, opening_source: "default", cash_sales_paise: 0,
          cash_expenses_paise: 0, advances_given_paise: 0, cash_losses_paise: 0,
          split_unknown_paise: 0, expected_paise: 0, variance_alert_paise: 1000,
          closure: null,
        }
        : { rows: [], alert_paise: 1000 },
    ));
    renderPage(<CashRegister />);
    await user.click(await screen.findByRole("button", { name: "Count & close the day" }));

    await user.type(screen.getByPlaceholderText("₹ counted"), "Infinity");
    expect(screen.getByText("Counted cash must be a finite amount of ₹0 or more.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Close \d{4}/ })).toBeDisabled();

    await user.clear(screen.getByPlaceholderText("₹ counted"));
    await user.type(screen.getByPlaceholderText("₹ counted"), "10");
    await user.type(screen.getByPlaceholderText("₹ taking home"), "11");
    expect(screen.getByText("Cash taken home cannot exceed the counted cash.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Close \d{4}/ })).toBeDisabled();
  });

  it("requires a variance reason before closing and keeps the count in the sheet", async () => {
    const user = userEvent.setup();
    mocks.get.mockImplementation((path: string) => Promise.resolve(
      path.startsWith("/cash/day")
        ? {
          opening_paise: 0, opening_source: "default", cash_sales_paise: 0,
          cash_expenses_paise: 0, advances_given_paise: 0, cash_losses_paise: 0,
          split_unknown_paise: 0, expected_paise: 0, variance_alert_paise: 1000,
          closure: null,
        }
        : { rows: [], alert_paise: 1000 },
    ));
    renderPage(<CashRegister />);
    await user.click(await screen.findByRole("button", { name: "Count & close the day" }));
    await user.type(screen.getByPlaceholderText("₹ counted"), "10");

    const reason = await screen.findByPlaceholderText("e.g., ₹200 chit pending with Ramesh");
    expect(screen.getByText("Variance reason (required)")).toBeInTheDocument();
    expect(reason).toBeRequired();
    expect(reason).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: /^Close \d{4}/ })).toBeDisabled();
    expect(screen.getByPlaceholderText("₹ counted")).toHaveValue("10");

    await user.type(reason, "cash left with courier");
    expect(screen.getByRole("button", { name: /^Close \d{4}/ })).toBeEnabled();
  });

  it("blocks non-finite wastage quantities before submitting", async () => {
    const user = userEvent.setup();
    mocks.get.mockImplementation((path: string) => Promise.resolve(
      path.startsWith("/inventory/overview") ? { items: [{ id: 3, name: "Tomato" }] } : [],
    ));
    renderPage(<InventoryWastage />);
    await user.click(screen.getByRole("button", { name: "+ Log wastage" }));
    await user.selectOptions(screen.getByLabelText("Item"), "3");
    await user.type(screen.getByLabelText("Quantity"), "Infinity");

    expect(screen.getByText("Quantity must be a finite number greater than 0.")).toBeInTheDocument();
    expect(screen.getByLabelText("Date")).toHaveAttribute("max");
    expect(screen.getByRole("button", { name: "Log wastage" })).toBeDisabled();
  });

  it("blocks non-finite vendor entries before submitting", async () => {
    const user = userEvent.setup();
    mocks.get.mockResolvedValue({
      vendor: { id: 9, name: "Market", balance_paise: 0 },
      rows: [],
    });
    renderPage(<VendorDetail />, "/vendors/9");
    await user.click(await screen.findByRole("button", { name: "Record payment" }));
    await user.type(screen.getByLabelText("Amount"), "Infinity");

    expect(screen.getByText("Amount must be a finite amount greater than ₹0.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save entry" })).toBeDisabled();
  });

  it("requires a finite, positive payroll adjustment and reason", async () => {
    const user = userEvent.setup();
    mocks.get.mockResolvedValue({
      id: 9, year: 2026, month: 9, status: "draft",
      payslips: [{
        id: 5, name: "Asha", designation: "Cook", gross_rupees: 1000,
        advance_recovery_rupees: 0, net_rupees: 1000, credited_days: 26,
        presents: 26, doubles: 0, halves: 0, per_day_rupees: 100,
        bonus_rupees: 0, deduction_rupees: 0, lates_count: 0, adjustments: [],
      }],
    });
    renderPage(<PayrollRunDetail />, "/staff/payroll/9");
    await user.click(await screen.findByRole("button", { name: "Bonus / deduction" }));
    await user.type(screen.getByLabelText(/^Days/), "Infinity");

    expect(screen.getByText("Days must be a finite value greater than 0.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Apply to salary" })).toBeDisabled();
  });
});
