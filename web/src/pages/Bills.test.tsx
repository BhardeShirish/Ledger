import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import Bills from "./Bills";

const mocks = vi.hoisted(() => ({
  get: vi.fn(), post: vi.fn(),
}));

vi.mock("../api/client", () => ({ api: mocks }));
vi.mock("../components/DataButtons", () => ({
  ExportButton: () => null,
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

const BILLS = [
  {
    id: 1, invoice_no: "11", business_date: "2026-09-01",
    bill_ts: "2026-09-01T12:00:00", channel_kind: "cash", order_type: "Dine in",
    persons: 2, discount_paise: 0, total_paise: 5000, total_rupees: 50,
  },
  {
    id: 2, invoice_no: "22", business_date: "2026-09-01",
    bill_ts: "2026-09-01T12:30:00", channel_kind: "split", order_type: "Dine in",
    persons: 2, discount_paise: 0, total_paise: 10000, total_rupees: 100,
  },
];
const SECOND_PAGE = [{
  id: 3, invoice_no: "33", business_date: "2026-08-31",
  bill_ts: "2026-08-31T21:00:00", channel_kind: "upi", order_type: "Delivery",
  persons: 0, discount_paise: 0, total_paise: 7000, total_rupees: 70,
}];

beforeEach(() => {
  mocks.get.mockReset();
  mocks.post.mockReset();
  mocks.get.mockImplementation((path: string) => {
    if (path.startsWith("/sales/bills")) {
      const page = Number(new URLSearchParams(path.split("?")[1]).get("page") ?? 1);
      return Promise.resolve({
        rows: page === 1 ? BILLS : SECOND_PAGE, total: 3, page, per_page: 2,
      });
    }
    return Promise.resolve([]);
  });
  mocks.post.mockResolvedValue({});
});

describe("bill rows and split validation", () => {
  it("offers importing the POS report as the primary way out of an empty result", async () => {
    mocks.get.mockImplementation((path: string) =>
      Promise.resolve(path.startsWith("/sales/bills")
        ? { rows: [], total: 0, page: 1, per_page: 100 } : []));
    renderPage(<Bills />);

    const importLink = await screen.findByRole("link", { name: /Import POS report/i });
    expect(importLink).toHaveAttribute("href", "/sales/import");
    // The primary action must carry the accent; Export stays a secondary
    // outline button beside it.
    expect(importLink.className).toContain("bg-accent");
  });

  it("keeps ordinary bill rows non-interactive and exposes split resolution as an action", async () => {
    renderPage(<Bills />);

    const ordinary = await screen.findByText("#11");
    expect(ordinary.closest("button")).toBeNull();
    expect(screen.getByRole("button", { name: "Resolve split for bill #22" })).toBeInTheDocument();
    expect(screen.getByText("Resolve split")).toBeInTheDocument();
  });

  it("only sends finite, positive allocations whose displayed total is the payload total", async () => {
    const user = userEvent.setup();
    renderPage(<Bills />);
    await user.click(await screen.findByRole("button", { name: "Resolve split for bill #22" }));

    await user.type(screen.getByLabelText("Cash"), "-1");
    expect(screen.getByText("Each entered split amount must be a finite amount greater than ₹0.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Allocate & resolve" })).toBeDisabled();

    await user.clear(screen.getByLabelText("Cash"));
    await user.type(screen.getByLabelText("Cash"), "40");
    await user.type(screen.getByLabelText("UPI"), "60");
    expect(screen.getByText("Distributed").parentElement).toHaveTextContent("₹100");
    await user.click(screen.getByRole("button", { name: "Allocate & resolve" }));

    expect(mocks.post).toHaveBeenCalledWith("/sales/bills/2/allocate-split", {
      allocations: [
        { channel_kind: "cash", amount_rupees: 40 },
        { channel_kind: "upi", amount_rupees: 60 },
      ],
    });
  });
});

describe("a bill history too large to download", () => {
  const lastBillsCall = () => [...mocks.get.mock.calls]
    .reverse()
    .map((args: unknown[]) => String(args[0]))
    .find((path) => path.startsWith("/sales/bills"));

  it("asks the server for one filtered page instead of trimming a full download", async () => {
    const user = userEvent.setup();
    renderPage(<Bills />);
    await screen.findByText("#11");
    expect(lastBillsCall()).toBe("/sales/bills?outlet_id=7&page=1&per_page=100");

    await user.selectOptions(
      screen.getByLabelText("Filter bills by payment mode"), "cash");
    await waitFor(() => expect(lastBillsCall())
      .toBe("/sales/bills?outlet_id=7&page=1&per_page=100&kind=cash"));
    // The page never hides rows the server already filtered.
    expect(screen.getByText("#22")).toBeInTheDocument();
  });

  it("searches on submit, not on every keystroke", async () => {
    const user = userEvent.setup();
    renderPage(<Bills />);
    await screen.findByText("#11");

    await user.type(
      screen.getByLabelText("Search bills by invoice number or area"), "terrace");
    expect(lastBillsCall()).toBe("/sales/bills?outlet_id=7&page=1&per_page=100");

    await user.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(lastBillsCall())
      .toBe("/sales/bills?outlet_id=7&page=1&per_page=100&q=terrace"));

    await user.click(screen.getByRole("button", { name: "Clear search" }));
    await waitFor(() => expect(lastBillsCall())
      .toBe("/sales/bills?outlet_id=7&page=1&per_page=100"));
  });

  it("pages through the history and says where in it the reader is", async () => {
    const user = userEvent.setup();
    renderPage(<Bills />);
    await screen.findByText("#11");
    expect(screen.getByRole("status")).toHaveTextContent("Showing 1–2 of 3 bills");
    expect(screen.getByRole("button", { name: "Previous page of bills" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Next page of bills" }));
    await waitFor(() => expect(lastBillsCall())
      .toBe("/sales/bills?outlet_id=7&page=2&per_page=100"));
    expect(await screen.findByText("#33")).toBeInTheDocument();
    expect(screen.queryByText("#11")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("status"))
      .toHaveTextContent("Showing 3–3 of 3 bills"));
    expect(screen.getByRole("button", { name: "Next page of bills" })).toBeDisabled();

    // A new filter must not leave the reader stranded on a page that is gone.
    await user.selectOptions(
      screen.getByLabelText("Filter bills by payment mode"), "upi");
    await waitFor(() => expect(lastBillsCall())
      .toBe("/sales/bills?outlet_id=7&page=1&per_page=100&kind=upi"));
  });

  it("separates an empty filter result from an outlet with no bills at all", async () => {
    const user = userEvent.setup();
    mocks.get.mockImplementation((path: string) => {
      if (!path.startsWith("/sales/bills")) return Promise.resolve([]);
      const params = new URLSearchParams(path.split("?")[1]);
      return Promise.resolve(params.get("kind")
        ? { rows: [], total: 0, page: 1, per_page: 100 }
        : { rows: BILLS, total: 2, page: 1, per_page: 100 });
    });
    renderPage(<Bills />);
    await screen.findByText("#11");

    await user.selectOptions(
      screen.getByLabelText("Filter bills by payment mode"), "card");
    expect(await screen.findByText("No bills match these filters")).toBeInTheDocument();
    // Importing is not the answer when bills exist but this filter is empty.
    expect(screen.queryByRole("link", { name: /Import POS report/i })).toBeNull();
  });
});
