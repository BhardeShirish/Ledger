import { fireEvent, render, screen } from "@testing-library/react";
import axe from "axe-core";
import { describe, expect, it, vi } from "vitest";

import { Badge, Button, ConfirmSheet, Input, SaveBar, SectionLabel, Select, Sheet, Spinner } from "./ui";

describe("SectionLabel", () => {
  it("can provide a semantic section heading without changing label styling", () => {
    render(<SectionLabel as="h2" id="report-heading">Report section</SectionLabel>);
    expect(screen.getByRole("heading", { level: 2, name: "Report section" }))
      .toHaveClass("label-caps");
  });
});

describe("Badge", () => {
  it("uses the darker good-state foreground required for small status text", () => {
    render(<Badge tone="good">Recorded</Badge>);
    expect(screen.getByText("Recorded")).toHaveClass("bg-good/10", "text-green-800");
  });
});

describe("SaveBar", () => {
  it("uses the shared navigation-safe position only while work is unsaved", () => {
    const { rerender } = render(<SaveBar show><button>Save changes</button></SaveBar>);
    expect(screen.getByRole("button", { name: "Save changes" }).parentElement).toHaveClass("save-bar");
    rerender(<SaveBar show={false}><button>Save changes</button></SaveBar>);
    expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
  });
});

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

  it("uses tabular figures only for numeric inputs, never selects", () => {
    render(
      <>
        <Input aria-label="Description" />
        <Input inputMode="decimal" aria-label="Amount" />
        <Select aria-label="Payment mode"><option>UPI</option></Select>
      </>,
    );

    expect(screen.getByLabelText("Description")).not.toHaveClass("num");
    expect(screen.getByLabelText("Amount")).toHaveClass("num");
    expect(screen.getByLabelText("Payment mode")).not.toHaveClass("num");
  });

  it("gives disabled shared controls the standard unavailable treatment", () => {
    render(
      <>
        <Button disabled>Save</Button>
        <Input disabled aria-label="Disabled input" />
        <Select disabled aria-label="Disabled select"><option>Cash</option></Select>
      </>,
    );

    for (const control of [
      screen.getByRole("button", { name: "Save" }),
      screen.getByLabelText("Disabled input"),
      screen.getByLabelText("Disabled select"),
    ]) {
      expect(control).toHaveClass("disabled:opacity-50", "disabled:cursor-not-allowed");
    }
  });
});

describe("Spinner", () => {
  it("keeps a marked loading indicator when motion is reduced", () => {
    render(<Spinner label="Loading outlets…" />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading outlets…");
    expect(screen.getByRole("status").querySelector(".spinner-mark")).toBeInTheDocument();
  });
});

describe("ConfirmSheet", () => {
  it("keeps cancellation and confirmation as distinct actions", () => {
    const onClose = vi.fn();
    const onConfirm = vi.fn();
    render(
      <ConfirmSheet open onClose={onClose} onConfirm={onConfirm}
                    title="Delete entry?" description="This cannot be undone."
                    confirmLabel="Delete entry" />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Delete entry" }));
    expect(onConfirm).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("uses explicit outline cancel and disables both actions while pending", () => {
    const onClose = vi.fn();
    const onConfirm = vi.fn();
    render(
      <ConfirmSheet open onClose={onClose} onConfirm={onConfirm}
                    title="Delete entry?" description="This cannot be undone."
                    confirmLabel="Delete entry" pending />,
    );

    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect(cancel).toHaveClass("border-rule-strong");
    expect(cancel).toBeDisabled();
    expect(screen.getByRole("button", { name: "Working…" })).toBeDisabled();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
