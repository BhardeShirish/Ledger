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

describe("forgotten password recovery", () => {
  it("sends the owner to a file on the PC and never shows the code", async () => {
    const user = userEvent.setup();
    mocks.post.mockResolvedValue({
      ok: true,
      file: "C:\\Ledger\\server\\data\\password-reset.txt",
      expires_minutes: 15,
    });
    renderLogin();

    await user.click(screen.getByRole("button", { name: "Forgot password?" }));
    await user.click(screen.getByRole("button", { name: "Write my reset code" }));

    expect(mocks.post).toHaveBeenCalledWith("/auth/forgot", { username: "owner" });
    expect(
      await screen.findByText("C:\\Ledger\\server\\data\\password-reset.txt"),
    ).toBeInTheDocument();
    expect(screen.getByText(/valid for 15 minutes/i)).toBeInTheDocument();
  });

  it("will not submit a password too short to be accepted", async () => {
    const user = userEvent.setup();
    mocks.post.mockResolvedValue({
      ok: true, file: "C:\\data\\password-reset.txt", expires_minutes: 15,
    });
    renderLogin();

    await user.click(screen.getByRole("button", { name: "Forgot password?" }));
    await user.click(screen.getByRole("button", { name: "Write my reset code" }));
    await user.type(await screen.findByLabelText("Reset code"), "abcd-efgh-ijkl");
    await user.type(screen.getByLabelText("New password"), "short77");

    expect(screen.getByRole("button", { name: "Set new password" })).toBeDisabled();

    await user.type(screen.getByLabelText("New password"), "-but-not-now");
    expect(screen.getByRole("button", { name: "Set new password" })).toBeEnabled();
  });

  it("returns to sign in once the password is changed", async () => {
    const user = userEvent.setup();
    mocks.post
      .mockResolvedValueOnce({
        ok: true, file: "C:\\data\\password-reset.txt", expires_minutes: 15,
      })
      .mockResolvedValueOnce({ ok: true });
    renderLogin();

    await user.click(screen.getByRole("button", { name: "Forgot password?" }));
    await user.click(screen.getByRole("button", { name: "Write my reset code" }));
    await user.type(await screen.findByLabelText("Reset code"), "wxyz-1234-5678");
    await user.type(screen.getByLabelText("New password"), "a-long-enough-one");
    await user.click(screen.getByRole("button", { name: "Set new password" }));

    expect(mocks.post).toHaveBeenLastCalledWith("/auth/reset", {
      username: "owner",
      code: "WXYZ-1234-5678",
      new_password: "a-long-enough-one",
    });
    expect(
      await screen.findByText("Password changed. Sign in with it now."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
  });
});
