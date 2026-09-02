import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import Login from "./Login";

const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  setMe: vi.fn(),
}));

vi.mock("../api/client", () => ({
  api: { post: mocks.post },
}));
vi.mock("../lib/auth", () => ({
  useAuth: () => ({ setMe: mocks.setMe }),
}));
vi.mock("../lib/money", () => ({
  useMoney: () => ({ config: { restaurant_name: "Test Ledger" } }),
}));

function renderLogin() {
  return render(
    <MemoryRouter
      initialEntries={["/login"]}
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/" element={<div>Home screen</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mocks.post.mockReset();
  mocks.setMe.mockReset();
});

describe("login workflow", () => {
  it("submits credentials, stores the user and navigates home", async () => {
    const user = userEvent.setup();
    const me = { id: 1, username: "owner", role: "owner" };
    mocks.post.mockResolvedValue({ user: me });
    renderLogin();

    await user.type(screen.getByLabelText("Username"), "owner");
    await user.type(screen.getByLabelText("Password"), "correct horse battery staple");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(mocks.post).toHaveBeenCalledWith("/auth/login", {
      username: "owner",
      password: "correct horse battery staple",
      remember: true,
    });
    expect(mocks.setMe).toHaveBeenCalledWith(me);
    expect(await screen.findByText("Home screen")).toBeInTheDocument();
  });

  it("announces authentication failures without leaving the form", async () => {
    const user = userEvent.setup();
    mocks.post.mockRejectedValue(new Error("Incorrect username or password"));
    renderLogin();

    await user.type(screen.getByLabelText("Username"), "owner");
    await user.type(screen.getByLabelText("Password"), "wrong-password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Incorrect username or password",
    );
    expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
  });

  it("has no automated accessibility violations", async () => {
    const { container } = renderLogin();
    const result = await axe.run(container, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(result.violations).toEqual([]);
  });
});
