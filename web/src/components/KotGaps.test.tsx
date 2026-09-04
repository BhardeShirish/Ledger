import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { KotGaps } from "./KotGaps";

const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("../api/client", () => ({ api: { get: mocks.get } }));

function day(date: string, over: Record<string, unknown> = {}) {
  return {
    date, bills: 100, tickets_seen: 90, unnumbered_bills: 5,
    first: 1, last: 95, missing_at_most: 10, missing_at_least: 5,
    missing_numbers: ["12", "40-43"], value_at_least_rupees: 2500,
    measurable: true, ...over,
  };
}

function report(over: Record<string, unknown> = {}) {
  const days = (over.days as any[]) ?? [day("2026-08-02")];
  return {
    period: { start: "2026-08-01", end: "2026-08-31" },
    totals: {
      days: days.length, days_measurable: days.length, bills: 100,
      tickets_seen: 90, unnumbered_bills: 5, missing_at_most: 10,
      missing_at_least: 5, value_at_least_rupees: 2500,
      typical_per_day: 5, ...(over.totals as object ?? {}),
    },
    days,
    worst_days: (over.worst_days as any[]) ?? days,
    findings: (over.findings as any[]) ?? [
      { severity: "act", title: "5 kitchen tickets never became a bill",
        detail: "About 5 a day." },
    ],
    how: "Bills that arrived without a ticket number are credited first.",
  };
}

function show(data: unknown) {
  mocks.get.mockResolvedValue(data);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <KotGaps start="2026-08-01" end="2026-08-31" outletId={1} />
    </QueryClientProvider>,
  );
}

describe("KotGaps", () => {
  // No shared mock reset here on purpose: every test sets its own
  // implementation, and resetting or clearing the mock loses Vitest's
  // tracking of a returned rejected promise, which then gets reported as
  // an error escaping the failure test below.

  it("leads with the cautious figure, not the flattering one", async () => {
    show(report());
    expect(await screen.findByText("Unaccounted for")).toBeInTheDocument();
    expect(screen.getByText("at least")).toBeInTheDocument();
  });

  it("still admits the upper end of the range", async () => {
    show(report());
    expect(await screen.findByText("Could be as high as")).toBeInTheDocument();
    expect(screen.getByText("10")).toBeInTheDocument();
  });

  it("prints the missing ticket numbers so they can be looked up", async () => {
    show(report());
    expect(await screen.findByText("12, 40-43")).toBeInTheDocument();
  });

  it("names the day each set of numbers belongs to", async () => {
    show(report());
    expect(await screen.findByText("2026-08-02")).toBeInTheDocument();
    expect(screen.getByText("5 of 90 raised")).toBeInTheDocument();
  });

  it("shows what the finding says in plain words", async () => {
    show(report());
    expect(await screen.findByText("5 kitchen tickets never became a bill"))
      .toBeInTheDocument();
  });

  it("says how the figure was reached, so it can be argued with", async () => {
    show(report());
    expect(await screen.findByText(/credited first/)).toBeInTheDocument();
  });

  it("keeps quiet rather than guessing when no ticket numbers arrived", async () => {
    show(report({
      days: [], worst_days: [],
      totals: { days: 3, days_measurable: 0, bills: 40, tickets_seen: 0,
                unnumbered_bills: 40, missing_at_most: 0, missing_at_least: 0,
                value_at_least_rupees: 0, typical_per_day: 0 },
    }));
    expect(await screen.findByText(/didn't carry kitchen ticket numbers/))
      .toBeInTheDocument();
    expect(screen.queryByText("Unaccounted for")).not.toBeInTheDocument();
  });

  it("does not list days to look into when nothing is missing", async () => {
    show(report({
      days: [day("2026-08-02", { missing_at_least: 0, missing_at_most: 0,
                                 missing_numbers: [] })],
      totals: { days: 1, days_measurable: 1, bills: 100, tickets_seen: 90,
                unnumbered_bills: 5, missing_at_most: 0, missing_at_least: 0,
                value_at_least_rupees: 0, typical_per_day: 0 },
      findings: [{ severity: "good", title: "Every kitchen ticket reached a bill",
                   detail: "No unexplained gaps." }],
    }));
    expect(await screen.findByText("Every kitchen ticket reached a bill"))
      .toBeInTheDocument();
    expect(screen.queryByText("Days worth looking into")).not.toBeInTheDocument();
  });

  it("shows only the worst few days until asked for the rest", async () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      day(`2026-08-0${i + 1}`, { missing_at_least: 9 - i }));
    show(report({ days: many, worst_days: many }));
    expect(await screen.findByText("2026-08-01")).toBeInTheDocument();
    expect(screen.queryByText("2026-08-09")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Show all 9 days/ }));
    expect(screen.getByText("2026-08-09")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Show fewer days/ }));
    expect(screen.queryByText("2026-08-09")).not.toBeInTheDocument();
  });

  it("offers no expander when every day already fits", async () => {
    show(report());
    await screen.findByText("2026-08-02");
    expect(screen.queryByRole("button", { name: /Show all/ })).not.toBeInTheDocument();
  });

  it("values the loss in rupees the owner can read", async () => {
    show(report());
    expect(await screen.findByText("₹2,500")).toBeInTheDocument();
    expect(screen.getByText("at your own average bill")).toBeInTheDocument();
  });

  it("asks the server only for the period and outlet it was given", async () => {
    show(report());
    await screen.findByText("Unaccounted for");
    expect(mocks.get).toHaveBeenCalledWith(
      "/patterns/kot-gaps?start=2026-08-01&end=2026-08-31&outlet_id=1");
  });

  it("asks across every outlet when none is chosen", async () => {
    mocks.get.mockResolvedValue(report());
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <KotGaps start="2026-08-01" end="2026-08-31" outletId={null} />
      </QueryClientProvider>,
    );
    await screen.findByText("Unaccounted for");
    expect(mocks.get).toHaveBeenCalledWith(
      "/patterns/kot-gaps?start=2026-08-01&end=2026-08-31");
  });

  it("says so when the books can't be read", async () => {
    mocks.get.mockImplementation(() => Promise.reject(new Error("nope")));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <KotGaps start="2026-08-01" end="2026-08-31" outletId={1} />
      </QueryClientProvider>,
    );
    expect(await screen.findByText(/Couldn't read your kitchen tickets/))
      .toBeInTheDocument();
  });
});
