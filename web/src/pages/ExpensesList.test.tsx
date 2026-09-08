/**
 * Multi-item expense entry.
 *
 * The reported problem: "+ add line" sat above the rows, so entering a bill
 * meant scrolling up to add, down to type, and up again for the next item.
 * A twenty-line vegetable bill was twenty round trips. These tests hold the
 * fixed shape — the button follows the last row, the cursor lands in the new
 * row, and Enter at the end of a row starts the next one.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("../api/client", () => ({
  api: { get: mocks.get, post: mocks.post },
}));
vi.mock("../lib/money", () => ({
  useMoney: () => ({ config: { symbol: "₹" } }),
}));

import { AddExpenseSheet } from "./ExpensesList";

function show() {
  mocks.get.mockResolvedValue({ configured: false });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AddExpenseSheet
        open onClose={() => {}} outletId={1}
        cats={[{ id: 1, name: "Vegetables", is_active: true }]}
        vendors={[]} busy={false} err=""
        onSubmit={() => {}} onSubmitBulk={() => {}} />
    </QueryClientProvider>,
  );
}

/** Switch the sheet into multi-item mode, which seeds one empty row. */
async function intoMultiItem(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByText("Multiple items from a bill"));
}

const itemBoxes = () => screen.queryAllByLabelText(/^Item \d+$/);

describe("expense item lines", () => {
  it("puts the add button after the rows, not before them", async () => {
    const user = userEvent.setup();
    show();
    await intoMultiItem(user);

    const addBtn = screen.getByText("＋ add line");
    const firstRow = itemBoxes()[0];
    expect(firstRow).toBeDefined();
    // Node.compareDocumentPosition: FOLLOWING (4) means the button comes
    // after the row in document order, which is where the thumb already is.
    const rel = firstRow.compareDocumentPosition(addBtn);
    expect(rel & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("adds a row and puts the cursor straight into it", async () => {
    const user = userEvent.setup();
    show();
    await intoMultiItem(user);
    expect(itemBoxes()).toHaveLength(1);

    await user.click(screen.getByText("＋ add line"));
    const boxes = itemBoxes();
    expect(boxes).toHaveLength(2);
    expect(document.activeElement).toBe(boxes[1]);
  });

  it("starts the next row when Enter is pressed on the amount", async () => {
    const user = userEvent.setup();
    show();
    await intoMultiItem(user);

    await user.type(itemBoxes()[0], "Tomato");
    await user.type(screen.getByLabelText("Amount for item 1"), "120{Enter}");

    const boxes = itemBoxes();
    expect(boxes).toHaveLength(2);
    expect(document.activeElement).toBe(boxes[1]);
    // The first row must survive being used as a springboard.
    expect(boxes[0]).toHaveValue("Tomato");
  });

  it("removes the row that was actually asked for", async () => {
    const user = userEvent.setup();
    show();
    await intoMultiItem(user);
    await user.click(screen.getByText("＋ add line"));
    await user.click(screen.getByText("＋ add line"));

    await user.type(itemBoxes()[0], "Onion");
    await user.type(itemBoxes()[1], "Tomato");
    await user.type(itemBoxes()[2], "Chilli");

    await user.click(screen.getByLabelText("Remove line 2"));

    const left = itemBoxes().map((b) => (b as HTMLInputElement).value);
    expect(left).toEqual(["Onion", "Chilli"]);
  });

  it("counts the lines so a long bill can be checked against the paper", async () => {
    const user = userEvent.setup();
    show();
    await intoMultiItem(user);
    expect(screen.getByText("1 line")).toBeInTheDocument();
    await user.click(screen.getByText("＋ add line"));
    expect(screen.getByText("2 lines")).toBeInTheDocument();
  });
});

describe("money fields", () => {
  it("selects an amount on focus so it can be typed straight over", async () => {
    const user = userEvent.setup();
    show();
    await intoMultiItem(user);

    const amount = screen.getByLabelText("Amount for item 1") as HTMLInputElement;
    await user.type(amount, "450");
    // Leave and come back, the way correcting a figure actually happens.
    await user.click(itemBoxes()[0]);
    await user.click(amount);
    expect(amount.selectionStart).toBe(0);
    expect(amount.selectionEnd).toBe(3);
  });

  it("leaves text fields alone", async () => {
    const user = userEvent.setup();
    show();
    await intoMultiItem(user);

    const item = itemBoxes()[0] as HTMLInputElement;
    await user.type(item, "Tomato");
    await user.click(screen.getByLabelText("Amount for item 1"));
    await user.click(item);
    // Selecting the whole name would fight someone fixing one letter of it.
    expect(item.selectionStart).toBe(item.selectionEnd);
  });
});
