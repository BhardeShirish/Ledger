import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import SpendReview from "./SpendReview";

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("../api/client", () => ({ api: { get: mocks.get, post: mocks.post } }));

const REVIEW = {
  month: "2025-08",
  prev_month: "2025-07",
  period: { partial: false },
  data_quality: { notes: [] },
  findings: [
    { severity: "act", title: "Rent is up ₹5,000",
      detail: "This is a fixed cost, so it repeats every month." },
    { severity: "info", title: "Biggest cost: Vegetables",
      detail: "₹20,400 — 38% of everything you spent." },
  ],
};

function renderReview() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <SpendReview month="2025-08" outletId={1} />
    </QueryClientProvider>,
  );
}

describe("SpendReview", () => {
  beforeEach(() => {
    mocks.get.mockReset();
    mocks.post.mockReset();
  });

  it("shows each finding with the month it covers", async () => {
    mocks.get.mockImplementation((p: string) =>
      Promise.resolve(p.startsWith("/advisor") ? REVIEW : { configured: false }));
    renderReview();
    expect(await screen.findByText("Rent is up ₹5,000")).toBeInTheDocument();
    expect(screen.getByText(/repeats every month/)).toBeInTheDocument();
    expect(screen.getByText(/August 2025/)).toBeInTheDocument();
    expect(screen.getByText(/vs July 2025/)).toBeInTheDocument();
  });

  it("hides the AI button until a model is configured", async () => {
    mocks.get.mockImplementation((p: string) =>
      Promise.resolve(p.startsWith("/advisor") ? REVIEW : { configured: false }));
    renderReview();
    await screen.findByText("Rent is up ₹5,000");
    expect(screen.queryByRole("button", { name: /Explain this in words/ }))
      .not.toBeInTheDocument();
    expect(screen.getByText(/Settings → Scan bills/)).toBeInTheDocument();
  });

  it("asks for the written summary only when told to", async () => {
    mocks.get.mockImplementation((p: string) =>
      Promise.resolve(p.startsWith("/advisor")
        ? REVIEW : { configured: true, model: "gemini-2.0-flash" }));
    mocks.post.mockResolvedValue({ text: "Cut vegetables.", model: "gemini-2.0-flash" });
    renderReview();

    const btn = await screen.findByRole("button", { name: /Explain this in words/ });
    expect(mocks.post).not.toHaveBeenCalled();   // nothing sent on page load

    await userEvent.click(btn);
    await waitFor(() => expect(screen.getByText("Cut vegetables.")).toBeInTheDocument());
    expect(mocks.post).toHaveBeenCalledWith("/advisor/advice",
      { month: "2025-08", outlet_id: 1 });
    expect(screen.getByText(/no bills, no names/)).toBeInTheDocument();
  });

  it("shows the server's reason when the AI call fails", async () => {
    mocks.get.mockImplementation((p: string) =>
      Promise.resolve(p.startsWith("/advisor")
        ? REVIEW : { configured: true, model: "m" }));
    mocks.post.mockRejectedValue(new Error("AI API said 429: slow down"));
    renderReview();
    await userEvent.click(
      await screen.findByRole("button", { name: /Explain this in words/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/429/);
  });

  it("says so plainly when there is nothing to report", async () => {
    mocks.get.mockImplementation((p: string) =>
      Promise.resolve(p.startsWith("/advisor")
        ? { ...REVIEW, findings: [] } : { configured: false }));
    renderReview();
    expect(await screen.findByText(/no expenses logged yet/)).toBeInTheDocument();
  });
});
