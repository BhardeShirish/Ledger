/**
 * The Daily Brief's month-projection tile.
 *
 * The bug this guards: on the 4th of a month, before that month's sales have
 * been imported, the tile printed a confident "₹0" as the projected month
 * end. An owner reads that as a forecast of ruin. The truth is only that the
 * sales are not in yet, so the projection must be withheld and said plainly.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("../api/client", () => ({ api: { get: mocks.get } }));
vi.mock("../lib/auth", () => ({ useAuth: () => ({ me: { role: "owner" } }) }));
vi.mock("react-router-dom", async () => {
  const real = await vi.importActual<any>("react-router-dom");
  return { ...real, useOutletContext: () => ({ outletId: 1 }) };
});

import DailyBrief from "./DailyBrief";

function show(forecast: Record<string, unknown>, intelligence: Record<string, unknown> = {
  health: { status: "provisional", overall_score: null, eligible_dimensions: 2 },
  feed: [], ai: { configured: false },
}) {
  mocks.get.mockImplementation((url: string) => {
    if (url.startsWith("/intelligence/brief")) return Promise.resolve(intelligence);
    if (url.startsWith("/insights/forecast")) return Promise.resolve(forecast);
    if (url.startsWith("/stats/home"))
      return Promise.resolve({ outlets: [{
        closed: false,
        attendance: { done: false, marked: 0, total: 4 },
        sales: { done: false, rupees_paise: 0 },
        expenses: { count: 0 },
      }] });
    if (url.startsWith("/cash/day")) return Promise.resolve({ expected_paise: 0 });
    if (url.startsWith("/cash/closures")) return Promise.resolve({ rows: [] });
    if (url.startsWith("/inventory/overview")) return Promise.resolve({});
    return Promise.resolve([]);
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter><DailyBrief /></MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Daily Brief month projection", () => {
  it("says nothing is recorded rather than projecting zero", async () => {
    show({ month: "2026-09", has_basis: false, so_far_rupees: 0,
           projected_rupees: null, target_rupees: null });
    expect(await screen.findByText("no sales recorded yet this month"))
      .toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("never prints a rupee projection when there is no basis", async () => {
    show({ month: "2026-09", has_basis: false, so_far_rupees: 0,
           projected_rupees: null, target_rupees: 50000,
           percent_of_target: null, on_track: null });
    const label = await screen.findByText("Month projection");
    const tile = label.parentElement!;
    // The old bug rendered ₹0 here; any rupee figure is a claim we can't make.
    expect(tile.textContent).not.toMatch(/₹/);
    expect(tile.textContent).toContain("—");
    expect(screen.queryByText(/% of target/)).not.toBeInTheDocument();
  });

  it("shows the projection once the month has sales in it", async () => {
    show({ month: "2026-09", has_basis: true, so_far_rupees: 40000,
           projected_rupees: 300000, target_rupees: null });
    expect(await screen.findByText("₹3,00,000")).toBeInTheDocument();
    expect(screen.queryByText("no sales recorded yet this month"))
      .not.toBeInTheDocument();
  });

  it("still shows target progress when there is a basis", async () => {
    show({ month: "2026-09", has_basis: true, so_far_rupees: 40000,
           projected_rupees: 300000, target_rupees: 400000,
           percent_of_target: 75, on_track: false });
    expect(await screen.findByText("75% of target")).toBeInTheDocument();
  });

  it("shows a linked evidence-backed owner priority in the daily brief", async () => {
    show({ month: "2026-09", has_basis: false, so_far_rupees: 0, projected_rupees: null }, {
      health: { status: "provisional", overall_score: 62, eligible_dimensions: 5 },
      ai: { configured: false },
      feed: [{
        id: "control.cash_close:2026-09-01", bucket: "act_today", kind: "risk",
        severity: "critical", title: "Drawer has not been closed",
        detail: "This is blocking a controlled month close.",
        action: { label: "Review and resolve", href: "/money/cash" },
        confidence: { level: "high", reason: "Computed from recorded Ledger facts." },
      }],
    });
    expect(await screen.findByText("Drawer has not been closed")).toBeInTheDocument();
    expect(screen.getByText("What deserves attention next")).toBeInTheDocument();
    expect(screen.getByText("Act today")).toBeInTheDocument();
    expect(screen.getByText("Drawer has not been closed").closest("a"))
      .toHaveAttribute("href", "/money/cash");
    expect(screen.getByText(/high confidence/)).toBeInTheDocument();
  });
});
