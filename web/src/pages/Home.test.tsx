/**
 * The home page's daily checklist.
 *
 * The page's whole job is to answer one question on a busy morning: what do I
 * do next? So exactly one step is highlighted, it is never an optional one,
 * and once the round is done nothing nags.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";

import Home, { nextStep, steps } from "./Home";

const mocks = vi.hoisted(() => ({ get: vi.fn(), role: "owner" }));
vi.mock("../api/client", () => ({ api: { get: mocks.get } }));
vi.mock("../lib/auth", () => ({
  useAuth: () => ({ me: { role: mocks.role, full_name: "Test Owner", username: "owner" } }),
}));

function renderHome() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <Routes>
          <Route element={<Outlet context={{ outletId: 7 }} />}>
            <Route index element={<Home />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mocks.role = "owner";
  mocks.get.mockReset();
  mocks.get.mockImplementation((url: string) => {
    if (url.startsWith("/stats/home")) return Promise.resolve({ outlets: [{ outlet_id: 7, ...freshDay() }] });
    if (url.startsWith("/insights/missing-logs")) return Promise.resolve([]);
    return Promise.resolve({});
  });
});

/** A day where nothing has been entered yet. */
function freshDay(over: any = {}) {
  return {
    attendance: { done: false, total: 6, marked: 0, open: 0 },
    sales: { done: false, rupees_paise: 0 },
    expenses: { count: 0, total_paise: 0 },
    closed: false,
    ...over,
  };
}

const done = (mine: any) => ({
  ...mine,
  attendance: { ...mine.attendance, done: true },
  sales: { done: true, rupees_paise: 4500000 },
});

describe("the daily round", () => {
  it("points at attendance first thing in the morning", () => {
    expect(nextStep(freshDay())).toBe(1);
  });

  describe("home recovery and prioritization", () => {
    it("puts today's next task before the earlier-day follow-up", async () => {
      renderHome();
      const round = await screen.findByRole("heading", { name: "Your daily round" });
      const followUp = screen.getByRole("heading", { name: "Earlier days & follow-up" });
      expect(round.compareDocumentPosition(followUp) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(screen.getByText("3 of 3 daily tasks left")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: /Mark attendance/ })).toHaveAttribute("aria-current", "step");
      expect(await screen.findByText("No missing logs found in the previous 14 days.")).toBeInTheDocument();
    });

    it("does not show another outlet's figures when the selected outlet is absent", async () => {
      mocks.get.mockImplementation((url: string) => Promise.resolve(
        url.startsWith("/stats/home") ? { outlets: [{ outlet_id: 99, ...freshDay() }] }
          : url.startsWith("/insights/missing-logs") ? [] : {},
      ));
      renderHome();
      expect(await screen.findByText("No progress available for this outlet")).toBeInTheDocument();
      expect(screen.queryByText("Your daily round")).not.toBeInTheDocument();
    });

    it("distinguishes a failed request from no outlet and recovers with retry", async () => {
      mocks.get.mockRejectedValueOnce(new Error("Network error"));
      renderHome();
      expect(await screen.findByText("Couldn't load today's progress")).toBeInTheDocument();
      expect(screen.queryByText("No outlet assigned yet")).not.toBeInTheDocument();
      expect(screen.getByRole("navigation", { name: "Daily tasks" })).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Retry today's progress" }));
      expect(await screen.findByText("Your daily round")).toBeInTheDocument();
    });

    it("does not report healthy inventory while its request is pending or failed", async () => {
      let reject!: (error: Error) => void;
      mocks.get.mockImplementation((url: string) => {
        if (url.startsWith("/stats/home")) return Promise.resolve({ outlets: [{ outlet_id: 7, ...freshDay() }] });
        if (url.startsWith("/inventory/overview")) return new Promise((_, fail) => { reject = fail; });
        return Promise.resolve(url.startsWith("/insights/missing-logs") ? [] : {});
      });
      renderHome();
      expect(await screen.findByText("Checking stock…")).toBeInTheDocument();
      expect(screen.queryByText("no supported reorder risks")).not.toBeInTheDocument();
      reject(new Error("Unavailable"));
      expect(await screen.findByText("Stock check unavailable · open to retry")).toBeInTheDocument();
    });

    it("shows a recoverable past-day error rather than claiming no missing entries", async () => {
      mocks.get.mockImplementation((url: string) => {
        if (url.startsWith("/insights/missing-logs")) return Promise.reject(new Error("Unavailable"));
        return Promise.resolve(url.startsWith("/stats/home") ? { outlets: [{ outlet_id: 7, ...freshDay() }] } : {});
      });
      renderHome();
      expect(await screen.findByRole("button", { name: "Retry earlier days" })).toBeInTheDocument();
      expect(screen.queryByText("No missing logs found in the previous 14 days.")).not.toBeInTheDocument();
    });

    it("keeps owner-only review requests out of the manager dashboard", async () => {
      mocks.role = "manager";
      renderHome();
      await screen.findByText("Your daily round");
      await waitFor(() => expect(mocks.get).toHaveBeenCalled());
      expect(mocks.get.mock.calls.some(([url]) => /\/control\/|\/intelligence\//.test(url))).toBe(false);
    });
  });

  it("moves to sales once the staff are marked in", () => {
    const mine = freshDay({ attendance: { done: true, total: 6, marked: 6, open: 0 } });
    expect(nextStep(mine)).toBe(2);
  });

  it("skips expenses, because a day with no spending is a normal day", () => {
    // Steps 1 and 2 done, expenses untouched: the next prompt must be
    // "close the day", not a nag to invent an expense.
    expect(nextStep(done(freshDay()))).toBe(4);
  });

  it("still skips expenses even when some were logged", () => {
    const mine = done(freshDay({ expenses: { count: 3, total_paise: 120000 } }));
    expect(nextStep(mine)).toBe(4);
  });

  it("goes quiet once the drawer is counted", () => {
    expect(nextStep(done(freshDay({ closed: true })))).toBeNull();
  });

  it("highlights exactly one step, never two", () => {
    const n = nextStep(freshDay());
    expect(steps(freshDay()).filter((s) => s.n === n)).toHaveLength(1);
  });

  it("keeps the round to the four jobs in the bottom bar", () => {
    expect(steps(freshDay()).map((s) => s.title)).toEqual([
      "Mark attendance", "Enter sales", "Log expenses", "Close the day",
    ]);
  });

  it("sends each step somewhere real", () => {
    for (const s of steps(freshDay())) expect(s.to).toMatch(/^\/[a-z]/);
  });
});
