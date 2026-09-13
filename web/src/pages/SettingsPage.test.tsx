import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import SettingsPage from "./SettingsPage";

const mocks = vi.hoisted(() => ({
  del: vi.fn(), get: vi.fn(), patch: vi.fn(), post: vi.fn(), put: vi.fn(),
  downloadFile: vi.fn(),
}));

vi.mock("../api/client", () => ({ api: mocks, downloadFile: mocks.downloadFile }));
vi.mock("../lib/auth", () => ({
  useAuth: () => ({ me: {
    role: "owner", username: "owner", full_name: "Owner",
    outlet_ids: [1], elevated_until: null,
  } }),
  useGuarded: () => (fn: () => unknown) => fn(),
}));
vi.mock("../lib/money", () => ({ useMoney: () => ({ refresh: vi.fn() }) }));
vi.mock("../components/StandingCosts", () => ({
  CostGroupsCard: () => null,
  HealthyBandsCard: () => null,
  StandingCostsCard: () => null,
}));

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <Routes>
          <Route element={<Outlet context={{ outletId: 1 }} />}>
            <Route index element={<SettingsPage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mocks.get.mockReset();
  mocks.del.mockReset();
  mocks.patch.mockReset();
  mocks.post.mockReset();
  mocks.put.mockReset();
  mocks.downloadFile.mockReset();
  mocks.downloadFile.mockResolvedValue(undefined);
  mocks.get.mockImplementation((path: string) => {
    if (path === "/users") return Promise.resolve([{
      id: 3, username: "manager", full_name: "Test manager", role: "manager",
      is_active: true, outlet_ids: [1],
    }]);
    if (path === "/outlets") return Promise.resolve([{ id: 1, name: "Kitchen", opening_float_rupees: 0 }]);
    if (path === "/sales/channels") return Promise.resolve([]);
    if (path === "/admin/settings") return Promise.resolve({
      restaurant_name: "My restaurant", currency_code: "INR", currency_symbol: "₹",
      currency_locale: "en-IN", timezone_name: "Asia/Kolkata",
      denominations: [500, 200, 100, 50, 20, 10, 5, 2, 1],
      edit_cutoff_hours: 48, salary_divisor_default: 26,
    });
    if (path.startsWith("/admin/audit")) return Promise.resolve({ rows: [], total: 0 });
    if (path === "/admin/backup/status") return Promise.resolve({
      directory: "C:\\Ledger Backups", retention_days: 30, latest: null,
    });
    if (path === "/ocr/status") return Promise.resolve({
      configured: false, enabled: false, provider: "openai_compat", model: "", has_key: false,
    });
    if (path.startsWith("/owner/system-health")) {
      return Promise.resolve({
        database: { size_bytes: null },
        disk: { free_bytes: null },
        last_automatic_backup: { name: null, integrity: { status: "unavailable" } },
        restore_playbook: [],
      });
    }
    return Promise.resolve({});
  });
});

describe("administrative passwords", () => {
  it("keeps add and reset password inputs concealed and marked as new passwords", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole("button", { name: "Add login" }));
    const addPassword = screen.getByLabelText("Password");
    expect(addPassword).toHaveAttribute("type", "password");
    expect(addPassword).toHaveAttribute("autocomplete", "new-password");

    await user.click(screen.getAllByRole("button", { name: "Close Add a login" }).at(-1)!);
    await user.click(await screen.findByRole("button", { name: /manager Test manager manager/ }));
    const resetPassword = screen.getAllByLabelText(/^New password/).at(-1)!;
    expect(resetPassword).toHaveAttribute("type", "password");
    expect(resetPassword).toHaveAttribute("autocomplete", "new-password");
  });
});

describe("Settings response resilience", () => {
  it("uses safe settings and health defaults when successful responses are malformed", async () => {
    mocks.get.mockImplementation((path: string) => {
      if (path === "/admin/settings") return Promise.resolve({
        restaurant_name: null, currency_code: "INR", currency_symbol: "₹",
        currency_locale: "en-IN", timezone_name: "Asia/Kolkata",
        denominations: "500, 200", edit_cutoff_hours: "48", salary_divisor_default: 26,
      });
      if (path.startsWith("/owner/system-health")) return Promise.resolve({
        database: null, disk: [], last_automatic_backup: { integrity: null },
        restore_playbook: {},
      });
      if (path === "/users") return Promise.resolve([]);
      if (path === "/outlets") return Promise.resolve([]);
      if (path === "/sales/channels") return Promise.resolve([]);
      if (path.startsWith("/admin/audit")) return Promise.resolve({ rows: [], total: 0 });
      if (path === "/admin/backup/status") return Promise.resolve({
        directory: "C:\\Ledger Backups", retention_days: 30, latest: null,
      });
      if (path === "/ocr/status") return Promise.resolve({
        configured: false, enabled: false, provider: "openai_compat", model: "", has_key: false,
      });
      return Promise.resolve({});
    });

    renderPage();

    expect(await screen.findByText(/Some business settings were unreadable/)).toBeInTheDocument();
    expect(await screen.findByText(/Some system-health details were unreadable/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Note \/ coin denominations/)).toHaveValue("500, 200, 100, 50, 20, 10, 5, 2, 1");
    expect(screen.getByRole("heading", { name: "House rules" })).toBeInTheDocument();
  });

  it("shows a local channel error without discarding the entered channel name", async () => {
    mocks.post.mockRejectedValueOnce(new Error("Channel name already exists"));
    const user = userEvent.setup();
    renderPage();

    const input = screen.getByPlaceholderText("New channel (Zomato, Swiggy…)");
    await user.type(input, "Zomato");
    await user.click(screen.getByRole("button", { name: "Add" }));

    expect(await screen.findByText("Channel name already exists")).toBeInTheDocument();
    expect(input).toHaveValue("Zomato");
  });

  it("shows a local outlet error without discarding the new outlet name", async () => {
    mocks.post.mockRejectedValueOnce(new Error("Outlet name already exists"));
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole("button", { name: "+ Outlet" }));
    const input = screen.getByLabelText("Name");
    await user.type(input, "Terrace");
    await user.click(screen.getByRole("button", { name: "Create outlet" }));

    expect(await screen.findByText("Outlet name already exists")).toBeInTheDocument();
    expect(input).toHaveValue("Terrace");
  });

  it("blocks an invalid edit-window value locally and clears its field error while editing", async () => {
    const user = userEvent.setup();
    renderPage();

    const input = screen.getByLabelText(/Edit window \(hours\)/);
    await user.clear(input);
    await user.type(input, "NaN");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(screen.getByText("Enter a whole number from 0 to 8,760 hours.")).toBeInTheDocument();
    expect(mocks.put).not.toHaveBeenCalled();
    await user.clear(input);
    await user.type(input, "24");
    expect(screen.queryByText("Enter a whole number from 0 to 8,760 hours.")).not.toBeInTheDocument();
  });

  it("communicates the selected outlet assignment state", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole("button", { name: "Add login" }));
    const assignment = within(screen.getByRole("dialog", { name: "Add a login" }))
      .getByRole("button", { name: "Kitchen" });
    expect(assignment).toHaveAttribute("aria-pressed", "false");
    await user.click(assignment);
    expect(assignment).toHaveAttribute("aria-pressed", "true");
  });
});


describe("backup download", () => {
  it("tells the owner why a backup was refused instead of failing silently", async () => {
    const user = userEvent.setup();
    mocks.downloadFile.mockRejectedValue(new Error(
      "The download returned a sign-in or gateway page instead of a file, so nothing was saved."));
    renderPage();

    await user.click(await screen.findByRole("button", { name: /Download backup/ }));
    expect(await screen.findByText(/nothing was saved/)).toBeInTheDocument();
    expect(mocks.downloadFile).toHaveBeenCalledWith(
      "/admin/backup/download", expect.stringMatching(/^ledger-backup-\d{4}-\d{2}-\d{2}\.zip$/));
  });
});
