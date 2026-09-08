import { fireEvent, render, screen } from "@testing-library/react";
import axe from "axe-core";
import { describe, expect, it, vi } from "vitest";

import { Input, Sheet } from "./ui";

describe("Sheet", () => {
  it("traps focus, closes with Escape and restores prior focus", () => {
    const onClose = vi.fn();
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();
    const { rerender } = render(
      <Sheet open onClose={onClose} title="Edit expense">
        <button>First action</button>
        <button>Last action</button>
      </Sheet>,
    );

    const closeButtons = screen.getAllByRole("button", { name: "Close Edit expense" });
    const first = closeButtons[closeButtons.length - 1];
    const last = screen.getByRole("button", { name: "Last action" });
    expect(first).toHaveFocus();

    last.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(first).toHaveFocus();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();

    rerender(
      <Sheet open={false} onClose={onClose} title="Edit expense">
        <button>First action</button>
      </Sheet>,
    );
    expect(trigger).toHaveFocus();
    trigger.remove();
  });

  it("has no automated accessibility violations", async () => {
    const { container } = render(
      <Sheet open onClose={() => undefined} title="Edit expense">
        <label>
          Amount
          <input />
        </label>
      </Sheet>,
    );
    const result = await axe.run(container, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(result.violations).toEqual([]);
  });
});

describe("Input", () => {
  it("still runs a caller's own onFocus after selecting", () => {
    const spy = vi.fn();
    render(<Input inputMode="decimal" defaultValue="450" onFocus={spy} aria-label="Amount" />);
    const box = screen.getByLabelText("Amount") as HTMLInputElement;

    fireEvent.focus(box);

    // Input destructures onFocus out of the spread, so pass-through is the
    // only thing keeping a caller's handler alive.
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
