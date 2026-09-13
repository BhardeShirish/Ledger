import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import AttendanceGrid from "./AttendanceGrid";
import Advances from "./Advances";
import InventoryLayout from "./Inventory";
import InventoryItems from "./InventoryItems";
import InventoryOrder from "./InventoryOrder";
import PayrollRuns from "./PayrollRuns";
import PersonDetail from "./PersonDetail";

const mocks = vi.hoisted(() => ({
  del: vi.fn(), get: vi.fn(), patch: vi.fn(), post: vi.fn(), put: vi.fn(),
  stepUpReasons: [] as any[],
}));

vi.mock("../api/client", () => ({ api: mocks }));
vi.mock("../components/DataButtons", () => ({
  ExportButton: () => null,
  ImportButtons: () => null,
}));
vi.mock("../lib/auth", () => ({
  useAuth: () => ({ me: { role: "owner", username: "owner" } }),
  useGuarded: (reason?: any) => {
    mocks.stepUpReasons.push(reason);
    return (fn: () => unknown) => fn();
  },
}));
vi.mock("../lib/useDateParam", () => ({
  useDateParam: () => ["2026-09-13", vi.fn()],
}));

function renderPage(page: ReactNode, path = "/") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <Routes>
          <Route element={<Outlet context={{ outletId: 7 }} />}>
            <Route path="/" element={page} />
            <Route path="/staff/people/:id" element={page} />
            <Route path="/inventory/*" element={page} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mocks.del.mockReset();
  mocks.get.mockReset();
  mocks.patch.mockReset();
  mocks.post.mockReset();
  mocks.put.mockReset();
  mocks.stepUpReasons.length = 0;
});

const INVENTORY_SECTIONS = [
  "Overview", "Items & ledger", "Auto-recipes", "Counts", "Wastage", "Order list",
];

describe("inventory section navigation on a phone", () => {
  it("names where you are and opens every destination from one picker", async () => {
    const user = userEvent.setup();
    renderPage(<InventoryLayout />, "/inventory/wastage");

    const trigger = screen.getByRole("button", { name: /Inventory section\s*Wastage/ });
    expect(trigger.className).toContain("md:hidden");
    expect(trigger.className).toContain("min-h-11");

    await user.click(trigger);
    const sheet = await screen.findByRole("dialog", { name: "Go to inventory section" });
    for (const label of INVENTORY_SECTIONS) {
      expect(within(sheet).getByRole("link", { name: new RegExp(label) })).toBeInTheDocument();
    }
    expect(within(sheet).getByRole("link", { name: /Wastage/ }))
      .toHaveAttribute("aria-current", "page");
  });

  it("keeps the full tab row for desktop", () => {
    const { container } = renderPage(<InventoryLayout />, "/inventory/items");
    const tabRow = container.querySelector("div.md\\:flex") as HTMLElement;

    expect(tabRow.className).toContain("hidden");
    expect(within(tabRow).getAllByRole("link").map((a) => a.textContent))
      .toEqual(INVENTORY_SECTIONS);
  });
});

describe("inventory zero-data honesty", () => {
  it("does not call an empty reorder list complete evidence", async () => {
    mocks.get.mockImplementation((path: string) => Promise.resolve(
      path.startsWith("/inventory/intelligence") ? { items: [] } : [],
    ));
    renderPage(<InventoryOrder />);

    expect(await screen.findByText("No stock items yet")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Add stock item" }))
      .toHaveAttribute("href", "/inventory/items");
    expect(screen.queryByText(/All tracked items have enough evidence/)).toBeNull();
    expect(screen.queryByText("No supported reorder recommendation")).toBeNull();
  });

  it("explains an empty stock ledger instead of showing bare headers", async () => {
    const user = userEvent.setup();
    mocks.get.mockResolvedValue([]);
    renderPage(<InventoryItems />);

    expect(await screen.findByText("No stock items yet")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Add stock item" }));
    expect(await screen.findByRole("dialog", { name: "Add stock item" })).toBeInTheDocument();
  });
});

const SHIFTS = [
  { id: 1, name: "Shift 1", start: "07:00", end: "16:00", start_min: 420, end_min: 960 },
  { id: 2, name: "Shift 2", start: "15:00", end: "23:00", start_min: 900, end_min: 1380 },
];

const attendanceApi = (path: string) => {
  if (path === "/staff/shifts") return Promise.resolve(SHIFTS);
  if (path.startsWith("/attendance/grid")) {
    return Promise.resolve({
      employees: [{
        id: 3, name: "Asha", designation: "Cook",
        cells: [{
          date: "2026-09-13", dow: 6, off_day: false, shift_name: "Shift 1",
          scheduled_in: "07:00",
          row: {
            status: "P", in_min: 420, out_min: 960, late_min: 0, ot_min: 0,
            double_duty: false, is_open: false, shift_id: 1,
          },
        }],
      }],
    });
  }
  return Promise.resolve({ rows: [] });
};

describe("attendance day card on a phone", () => {
  it("gives every shift and time control a 44px target inside labelled rows", async () => {
    mocks.get.mockImplementation(attendanceApi);
    const { container } = renderPage(<AttendanceGrid />);
    await screen.findAllByText("Asha");

    const mobile = container.querySelector("div.md\\:hidden") as HTMLElement;
    for (const label of ["Shift", "In", "Out", "Shifts worked"]) {
      expect(within(mobile).getByText(label)).toBeInTheDocument();
    }
    const controls = [
      ...within(mobile).getAllByRole("button"),
      ...within(mobile).getAllByRole("textbox"),
    ];
    expect(controls.length).toBeGreaterThan(4);
    for (const control of controls) expect(control.className).toContain("min-h-11");

    // Nothing in the day card may be laid out at a fixed width a 320px
    // screen cannot honour.
    for (const el of Array.from(mobile.querySelectorAll("*"))) {
      expect(el.className.toString()).not.toMatch(/(^|\s)w-\d/);
    }
  });

  it("keeps every status tone readable on its own tint", async () => {
    const statuses = ["P", "A", "H", "L", "WO"];
    mocks.get.mockImplementation((path: string) => {
      if (path === "/staff/shifts") return Promise.resolve(SHIFTS);
      if (path.startsWith("/attendance/grid")) {
        return Promise.resolve({
          employees: statuses.map((status, i) => ({
            id: i + 1, name: `Person ${status}`, designation: "Cook",
            cells: [{
              date: "2026-09-13", dow: 6, off_day: status === "WO",
              shift_name: "Shift 1", scheduled_in: "07:00",
              row: {
                status, in_min: 420, out_min: 960, late_min: 0, ot_min: 0,
                double_duty: false, is_open: false, shift_id: 1,
              },
            }],
          })),
        });
      }
      return Promise.resolve({ rows: [] });
    });
    const { container } = renderPage(<AttendanceGrid />);
    await screen.findAllByText("Person P");

    // good/bad at 10% and paper-3 are too pale for their default ink to reach
    // 4.5:1, so the tone keeps its meaning and darkens its text instead.
    const classes = Array.from(container.querySelectorAll("*"))
      .map((el) => el.className.toString());
    expect(classes.some((c) => c.includes("bg-good/10") && c.includes("text-green-800"))).toBe(true);
    expect(classes.some((c) => c.includes("bg-bad/10") && c.includes("text-red-800"))).toBe(true);
    for (const c of classes) {
      expect(c).not.toMatch(/bg-good\/10 text-good|bg-bad\/10 text-bad/);
      expect(c).not.toMatch(/bg-paper-3 text-ink-faint/);
      expect(c).not.toContain("text-white/80");
    }
  });

  it("still records a shift pick and a typed time", async () => {    const user = userEvent.setup();
    mocks.get.mockImplementation(attendanceApi);
    mocks.post.mockResolvedValue({});
    const { container } = renderPage(<AttendanceGrid />);
    await screen.findAllByText("Asha");

    const mobile = container.querySelector("div.md\\:hidden") as HTMLElement;
    await user.click(within(mobile).getByRole("button", { name: /S2/ }));
    const inTime = within(mobile).getByLabelText("Asha 2026-09-13 arrival time");
    await user.clear(inTime);
    await user.type(inTime, "15:10");

    await user.click(screen.getByRole("button", { name: "Save attendance" }));
    expect(mocks.post).toHaveBeenCalledWith("/attendance/bulk", expect.objectContaining({
      outlet_id: 7, date: "2026-09-13",
      entries: [expect.objectContaining({
        employee_id: 3, status: "P", shift_id: 2, in_time: "15:10",
      })],
    }));
  });
});

const PERSON = {
  id: 5, name: "Asha", designation: "Cook", join_date: "2024-04-01",
  phone: "9999", working_status: "active", off_dow: 2, pref_off_dow: 2,
  backup_employee_id: null, default_shift_id: 1,
  monthly_salary_rupees: 22000, per_day_rupees: 846.15, divisor: 26,
  notes: "", pattern: [{ dow: 0, shift_id: 2 }],
  aadhaar_no: null, pan_no: null, aadhaar_doc_path: null, pan_doc_path: null,
};

describe("person detail on a phone", () => {
  const personApi = (path: string) => Promise.resolve(
    path === "/staff/shifts" ? SHIFTS : PERSON,
  );

  it("shows all seven days and says what each one resolves to", async () => {
    mocks.get.mockImplementation(personApi);
    const { container } = renderPage(<PersonDetail />, "/staff/people/5");
    await screen.findByRole("heading", { name: "Asha" });

    const week = container.querySelector("ul.sm\\:hidden") as HTMLElement;
    expect(week.className).not.toContain("overflow-x-auto");
    const rows = within(week).getAllByRole("listitem");
    expect(rows).toHaveLength(7);
    expect(rows[0]).toHaveTextContent("MonShift 2Set for this day");
    expect(rows[1]).toHaveTextContent("TueShift 1Default shift");
    expect(rows[2]).toHaveTextContent("WedOffWeekly off");

    // No scroll container to trap a keyboard user, and the Off day's grey
    // label is darkened so it clears 4.5:1 on its paper-3 fill.
    for (const el of Array.from(container.querySelectorAll("*"))) {
      const cls = el.className.toString();
      expect(cls).not.toMatch(/overflow-(x-)?(auto|scroll)/);
      expect(cls).not.toMatch(/bg-paper-3 text-ink-faint/);
    }
  });

  it("states an amount per day instead of a bare ÷ divisor", async () => {
    mocks.get.mockImplementation(personApi);
    renderPage(<PersonDetail />, "/staff/people/5");
    await screen.findByRole("heading", { name: "Asha" });

    expect(screen.getByText("₹846.15 / day")).toBeInTheDocument();
    expect(screen.getByText("₹22,000 a month ÷ 26 paid days")).toBeInTheDocument();
    expect(screen.queryByText(/₹846\.15\s*÷26/)).toBeNull();
  });

  it("keeps each document a bounded record with its own controls", async () => {
    mocks.get.mockImplementation(personApi);
    renderPage(<PersonDetail />, "/staff/people/5");
    await screen.findByRole("heading", { name: "Asha" });

    for (const label of ["Aadhaar", "PAN"]) {
      const field = screen.getByLabelText(`${label} number`);
      const record = field.closest("section") as HTMLElement;
      expect(within(record).getByText(label)).toBeInTheDocument();
      expect(within(record).getByText("no image")).toBeInTheDocument();
      expect(within(record).getByRole("button", { name: /Attach image/ })).toBeInTheDocument();
    }
  });

  it("saves a document number without losing the field mid-edit", async () => {
    const user = userEvent.setup();
    mocks.get.mockImplementation(personApi);
    mocks.patch.mockResolvedValue({});
    renderPage(<PersonDetail />, "/staff/people/5");
    await screen.findByRole("heading", { name: "Asha" });

    const pan = screen.getByLabelText("PAN number");
    await user.type(pan, "ABCDE1234F");
    expect(pan).toHaveValue("ABCDE1234F");   // no remount between keystrokes
    await user.tab();
    expect(mocks.patch).toHaveBeenCalledWith("/staff/employees/5/kyc", { pan_no: "ABCDE1234F" });
  });
});

describe("locked owner-only destinations", () => {
  it("keeps payroll's destination on screen and asks for payroll by name", async () => {
    mocks.get.mockReturnValue(new Promise(() => {}));   // still unlocking
    renderPage(<PayrollRuns />);

    expect(screen.getByRole("heading", { name: "Monthly salaries" })).toBeInTheDocument();
    expect(screen.getByText("Staff · Payroll")).toBeInTheDocument();
    expect(screen.getByText("Owner-only screen")).toBeInTheDocument();
    expect(await screen.findByRole("status")).toHaveTextContent("Opening monthly salaries…");
    expect(mocks.stepUpReasons[0]).toMatchObject({
      title: "Payroll is owner-only",
      heading: "Enter your password to open Monthly salaries",
    });
  });

  it("keeps advances' destination on screen and asks for advances by name", async () => {
    mocks.get.mockReturnValue(new Promise(() => {}));
    renderPage(<Advances />);

    expect(screen.getByRole("heading", { name: "Salary advances" })).toBeInTheDocument();
    expect(screen.getByText("Staff · Advances")).toBeInTheDocument();
    expect(await screen.findByRole("status")).toHaveTextContent("Opening salary advances…");
    expect(mocks.stepUpReasons[0]).toMatchObject({
      title: "Advances are owner-only",
      heading: "Enter your password to open Salary advances",
    });
  });
});
