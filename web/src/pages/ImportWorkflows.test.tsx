import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import BankImport from "./BankImport";
import ImportWizard from "./ImportWizard";

const mocks = vi.hoisted(() => ({
  del: vi.fn(),
  get: vi.fn(),
  post: vi.fn(),
}));

vi.mock("../api/client", () => ({ api: mocks }));
vi.mock("../lib/auth", () => ({
  useGuarded: () => (fn: () => unknown) => fn(),
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

const preview = {
  batch_id: 42, rows_ok: 1, rows_skipped: 0, part_payments_unresolved: 0,
  date_from: "2026-09-01", date_to: "2026-09-01", meta: {}, preview: [],
};

beforeEach(() => {
  mocks.get.mockReset();
  mocks.post.mockReset();
  mocks.del.mockReset();
  mocks.get.mockResolvedValue([]);
});

describe("import file choosers", () => {
  it("exposes a keyboard-reachable Bank statement chooser and associates a new supplier field", async () => {
    const user = userEvent.setup();
    mocks.post.mockImplementation((path: string) => {
      if (path.startsWith("/bank/upload")) {
        return Promise.resolve({
          batch_id: 11, source: "bank", filename: "statement.csv",
          debits: 1, new_rows: 1, already_imported: 0, credits: 0,
          date_from: "2026-09-01", date_to: "2026-09-01", transactions: [],
          payees: [{
            match_key: "market", label: "Market", channel: "upi", mode: "upi",
            count: 1, new_count: 1, total_paise: 10000, total_rupees: 100,
            date_from: "2026-09-01", date_to: "2026-09-01", category_id: null,
            vendor_id: null, skip: false, known: false, possible_duplicate_count: 0,
            possible_duplicates: [], previous_count: 0, previous_matches: [],
            suggested_category_id: null, suggested_vendor_id: null,
            suggested_mode: null, suggested_from_count: 0, detected_modes: ["upi"],
          }],
        });
      }
      return Promise.resolve({});
    });
    const { container } = renderPage(<BankImport />);
    const chooser = screen.getByRole("button", { name: "Choose statement file" });
    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const click = vi.spyOn(fileInput, "click");

    await user.click(chooser);
    expect(click).toHaveBeenCalledTimes(1);

    await user.upload(fileInput, new File(["statement"], "statement.csv", { type: "text/csv" }));
    await user.click(await screen.findByRole("button", { name: "Review" }));
    await user.selectOptions(screen.getByLabelText("Vendor for Market"), "new");
    expect(screen.getByLabelText("New supplier")).toBeInTheDocument();
  });

  it("exposes a POS chooser and discards the staged batch remotely while the request is pending", async () => {
    const user = userEvent.setup();
    let resolveDiscard!: () => void;
    mocks.post.mockImplementation((path: string) =>
      path.startsWith("/imports/upload") ? Promise.resolve(preview) : Promise.resolve({}));
    mocks.del.mockImplementation(() => new Promise<void>((resolve) => { resolveDiscard = resolve; }));
    const { container } = renderPage(<ImportWizard />);
    const chooser = screen.getByRole("button", { name: "Choose Excel file" });
    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const click = vi.spyOn(fileInput, "click");

    await user.click(chooser);
    expect(click).toHaveBeenCalledTimes(1);
    await user.upload(fileInput, new File(["report"], "report.xlsx"));
    await user.click(await screen.findByRole("button", { name: "Discard" }));
    await user.click(screen.getByRole("button", { name: "Discard batch" }));

    expect(mocks.del).toHaveBeenCalledWith("/imports/42");
    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: "Discarding…" })
        .every((button) => button.hasAttribute("disabled"))).toBe(true);
    });

    resolveDiscard();
    expect(await screen.findByRole("button", { name: "Choose Excel file" })).toBeInTheDocument();
  });

  it("describes a repeat POS commit as a replacement, because that is what the server does", async () => {
    const user = userEvent.setup();
    mocks.get.mockImplementation((path: string) =>
      Promise.resolve(path === "/imports"
        ? [
          { id: 8, filename: "orders.xlsx", status: "committed", rows_ok: 12 },
          { id: 9, filename: "orders.xlsx", status: "validated", rows_ok: 12 },
        ]
        : []));
    renderPage(<ImportWizard />);

    expect(await screen.findByText(/a file with this name is already committed/i))
      .toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "commit now" }));

    const warning = await screen.findByText(/does not count these bills twice/i);
    expect(warning).toHaveTextContent("replaces the imported sales for every date in this file");
    expect(warning).toHaveTextContent("missing from this file are deleted");
    expect(warning).toHaveTextContent("splits you already resolved on those dates go back to unresolved");
    expect(screen.queryByText(/count those bills twice/i)).toBeNull();
  });
});
