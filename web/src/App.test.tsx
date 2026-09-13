import { render, screen } from "@testing-library/react";
import {
  createMemoryRouter, createRoutesFromElements, Outlet, Route, RouterProvider, useOutletContext,
} from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RequireOwner } from "./App";

const mocks = vi.hoisted(() => ({ role: "owner" }));

vi.mock("./lib/auth", () => ({
  useAuth: () => ({ me: { role: mocks.role } }),
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
}));

function Shell() {
  return (
    <div>
      <div>Ledger shell</div>
      <Outlet context={{ outletId: 7 }} />
    </div>
  );
}

function OutletProbe() {
  const { outletId } = useOutletContext<{ outletId: number }>();
  return <div>Selected outlet: {outletId}</div>;
}

function renderOwnerRoute(role: "owner" | "manager", path = "/owner-only") {
  mocks.role = role;
  const router = createMemoryRouter(
    createRoutesFromElements(
      <Route element={<Shell />}>
        <Route element={<RequireOwner />}>
          <Route path="/owner-only" element={<div>Owner-only page</div>} />
          <Route path="/owner-context" element={<OutletProbe />} />
        </Route>
      </Route>,
    ),
    { initialEntries: [path] },
  );
  render(<RouterProvider router={router} future={{ v7_startTransition: true }} />);
}

function renderSettingsRoute(role: "owner" | "manager", path: string) {
  mocks.role = role;
  const router = createMemoryRouter(
    createRoutesFromElements(
      <Route element={<Shell />}>
        <Route path="/settings/account" element={<div>Account page</div>} />
        <Route element={<RequireOwner />}>
          <Route path="/settings/*" element={<div>Owner settings page</div>} />
        </Route>
      </Route>,
    ),
    { initialEntries: [path] },
  );
  render(<RouterProvider router={router} future={{ v7_startTransition: true }} />);
}

beforeEach(() => {
  mocks.role = "owner";
});

describe("RequireOwner", () => {
  it("renders an owner-only direct route for the owner", () => {
    renderOwnerRoute("owner");

    expect(screen.getByText("Ledger shell")).toBeInTheDocument();
    expect(screen.getByText("Owner-only page")).toBeInTheDocument();
  });

  it("keeps the shell but denies a manager's direct owner-only route", () => {
    renderOwnerRoute("manager");

    expect(screen.getByText("Ledger shell")).toBeInTheDocument();
    expect(screen.getByRole("alert", { name: "Owner access required" })).toBeInTheDocument();
    expect(screen.queryByText("Owner-only page")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Return home" })).toHaveAttribute("href", "/");
  });

  it("keeps the active outlet available to owner-only pages", () => {
    renderOwnerRoute("owner", "/owner-context");

    expect(screen.getByText("Selected outlet: 7")).toBeInTheDocument();
  });

  it("leaves the nested account route available to a signed-in manager", () => {
    renderSettingsRoute("manager", "/settings/account");

    expect(screen.getByText("Ledger shell")).toBeInTheDocument();
    expect(screen.getByText("Account page")).toBeInTheDocument();
    expect(screen.queryByRole("alert", { name: "Owner access required" })).not.toBeInTheDocument();
  });
});
