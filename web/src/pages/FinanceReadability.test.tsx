/**
 * Money screens have to say what a figure *means*, not just print it.
 *
 * The bugs these guard: a closed-day history that showed bare rupee columns
 * (counted? taken home? left behind?), a bank page that printed ninety days of
 * identical unmatchable deposit rows, a vendor row with no visible sign it
 * navigated anywhere, and sales inputs whose only clue they held rupees was a
 * placeholder that vanished the moment a figure was typed.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import axe from "axe-core";
import type { ReactNode } from "react";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import BankImport from "./BankImport";
import Bills from "./Bills";
import CashRegister from "./CashRegister";
import SalesSheet from "./SalesSheet";
import UnitPrices from "./UnitPrices";
import VendorsList from "./VendorsList";

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn() }));

vi.mock("../api/client", () => ({ api: mocks }));
vi.mock("../components/DataButtons", () => ({
  ExportButton: () => null,
  ImportButtons: () => null,
}));
vi.mock("../components/Layout", () => ({
  useDraftGuard: () => ({ registerDirtyDraft: vi.fn(), requestDiscard: (fn: () => void) => fn() }),
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
  mocks.del.mockReset();
});

describe("cash register recent days", () => {
  it("labels what every figure in a closed day means", async () => {
    mocks.get.mockImplementation((path: string) => {
      if (path.startsWith("/cash/day")) return Promise.resolve({
        opening_paise: 0, cash_sales_paise: 0, cash_expenses_paise: 0,
        advances_given_paise: 0, expected_paise: 500000, variance_alert_paise: 10000,
        closure: null,
      });
      if (path.startsWith("/cash/closures")) return Promise.resolve({
        alert_paise: 10000,
        rows: [{
          id: 4, date: "2026-09-12", counted_paise: 512000, taken_home_paise: 400000,
          left_in_drawer_paise: 112000, variance_paise: 12000, reopened: false,
          note: "extra chit found",
        }],
      });
      return Promise.resolve([]);
    });

    renderPage(<CashRegister />);

    const history = (await screen.findByText("Recent days")).closest(".card") as HTMLElement;
    const row = within(history).getByText("12 Sep").closest("div")!.parentElement!;
    for (const [label, value] of [
      ["Counted", "₹5,120"],
      ["Taken home", "₹4,000"],
      ["Left in drawer", "₹1,120"],
      ["Variance", "+₹120"],
    ] as const) {
      const term = within(row).getByText(label);
      expect(term.tagName).toBe("DT");
      expect(term.nextElementSibling).toHaveTextContent(value);
    }
  });
});

describe("bank import cash deposits", () => {
  const recon = {
    closures: [
      { id: 10, date: "2026-09-10", expected_paise: 20000, remaining_paise: 20000, suggested_credit_id: 99 },
      { id: 11, date: "2026-06-04", expected_paise: 100000, remaining_paise: 100000, suggested_credit_id: null },
      { id: 12, date: "2026-07-02", expected_paise: 50000, remaining_paise: 50000, suggested_credit_id: null },
      { id: 13, date: "2026-08-19", expected_paise: 25000, remaining_paise: 25000, suggested_credit_id: null },
    ],
    credits: [
      { id: 99, date: "2026-09-11", amount_paise: 20000, remaining_paise: 20000, narration: "CASH DEP" },
    ],
  };

  it("keeps the matchable deposit actionable and compacts the unmatchable history", async () => {
    mocks.get.mockImplementation((path: string) =>
      Promise.resolve(path.startsWith("/bank/cash-reconciliation") ? recon : []));

    const { container } = renderPage(<BankImport />);

    // Only the close a statement credit can actually settle is offered.
    expect(await screen.findByRole("button", { name: "Confirm match" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Confirm match" })).toHaveLength(1);

    // The remaining 90 days become one honest summary, not a wall of rows.
    const summary = screen.getByText(/earlier cash removals/).textContent ?? "";
    expect(summary).toContain("3 earlier cash removals");
    expect(summary).toContain("₹1,750");
    expect(summary).toContain("4 Jun → 19 Aug");

    // Acting on them is still possible: they fold, they do not disappear.
    const details = container.querySelector("details") as HTMLDetailsElement;
    expect(details).toBeTruthy();
    expect(within(details).getByText("Show the 3 waiting days")).toBeInTheDocument();
    expect(within(details).getAllByText("no exact bank credit found")).toHaveLength(3);
  });
});

describe("vendor list navigation", () => {
  it("names each row as a link and shows a chevron affordance", async () => {
    mocks.get.mockImplementation((path: string) =>
      Promise.resolve(path.startsWith("/vendors/aging") ? [] : [
        { id: 3, name: "Mart A", phone: "9000000000", is_active: true, balance_paise: 120000 },
      ]));

    renderPage(<VendorsList />);

    const row = await screen.findByRole("link", { name: "Open Mart A — ₹1,200 due" });
    expect(row).toHaveAttribute("href", "/money/vendors/3");
    expect(row.querySelector("svg")).toBeTruthy();
    // The due figure and its caption still read normally inside the link.
    expect(row).toHaveTextContent("₹1,200");
    expect(row).toHaveTextContent("due");
  });
});

describe("manual sales money inputs", () => {
  it("keeps the rupee marker visible while a figure is being edited", async () => {
    mocks.get.mockResolvedValue({
      rows: [{ channel_kind: "cash", manual_amount_rupees: 500, effective_rupees: 500 }],
      total_rupees: 500, losses_rupees: 0, losses: [], loss_kinds: [],
    });

    renderPage(<SalesSheet />);

    const input = await screen.findByLabelText("Sales amount for Cash");
    // A placeholder would be gone by now; the adornment is not.
    expect(input).toHaveValue("500");
    expect(input.parentElement).toHaveTextContent("₹");
    expect(input.className).toContain("pl-6");

    const loss = screen.getByLabelText("Loss or refund amount");
    expect(loss.parentElement).toHaveTextContent("₹");
  });
});

describe("finance screen accessible names", () => {
  /**
   * Compact toolbars carry no visible <label>, so every filter, date box and
   * mode picker on these pages has to name itself. This runs the real axe
   * rules that catch a control with no accessible name at all.
   */
  const pages: Array<[string, ReactNode, (path: string) => unknown]> = [
    ["Bills", <Bills />, () => []],
    ["Cash register", <CashRegister />, (path) => path.startsWith("/cash/day")
      ? { opening_paise: 0, cash_sales_paise: 0, cash_expenses_paise: 0,
          advances_given_paise: 0, expected_paise: 0, variance_alert_paise: 10000,
          closure: null }
      : path.startsWith("/cash/closures") ? { alert_paise: 10000, rows: [] } : []],
    ["Sales sheet", <SalesSheet />, () => ({
      rows: [{ channel_kind: "cash", manual_amount_rupees: null, effective_rupees: null }],
      total_rupees: 0, losses_rupees: 0, losses: [],
      loss_kinds: [{ kind: "refund", label: "Refund", cash_capable: true }],
    })],
    ["Unit prices", <UnitPrices />, () => []],
    ["Vendors", <VendorsList />, () => []],
    ["Bank import", <BankImport />, () => []],
  ];

  it.each(pages)("names every control on %s", async (_name, page, respond) => {
    mocks.get.mockImplementation((path: string) => Promise.resolve(respond(path)));
    const { container } = renderPage(page);
    await screen.findByRole("heading", { level: 1 });

    const result = await axe.run(container, {
      runOnly: ["cat.forms", "cat.name-role-value"],
      rules: { "color-contrast": { enabled: false } },
    });
    expect(result.violations.map((violation) => violation.id)).toEqual([]);
  });
});
