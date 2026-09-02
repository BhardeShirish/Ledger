import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AuthProvider, useAuth } from "./auth";

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("../api/client", () => ({ api: { get: mocks.get, post: mocks.post } }));

const OWNER = {
  id: 1, username: "owner", full_name: "Owner", role: "owner",
  outlet_ids: [7], elevated_until: null,
};

function Probe() {
  const { me, ready, offline } = useAuth();
  if (!ready) return <div>loading</div>;
  return (
    <div>
      <span data-testid="who">{me ? me.username : "signed-out"}</span>
      <span data-testid="offline">{offline ? "offline" : "online"}</span>
    </div>
  );
}

const renderAuth = () =>
  render(<AuthProvider><Probe /></AuthProvider>);

/** Mirrors the shape api/client.ts throws: status 0 means "no network". */
function apiError(status: number) {
  return Object.assign(new Error(`fail ${status}`), { status });
}

beforeEach(() => {
  localStorage.clear();
  mocks.get.mockReset();
});

describe("auth while offline", () => {
  it("keeps the signed-in user when the server is unreachable", async () => {
    // First load online: identity gets remembered.
    mocks.get.mockResolvedValueOnce(OWNER);
    const first = renderAuth();
    await waitFor(() => expect(screen.getByTestId("who")).toHaveTextContent("owner"));
    first.unmount();

    // Reopening the app with no network must NOT look like a sign-out,
    // otherwise the offline queue can never be reached.
    mocks.get.mockRejectedValueOnce(apiError(0));
    renderAuth();
    await waitFor(() => expect(screen.getByTestId("who")).toHaveTextContent("owner"));
    expect(screen.getByTestId("offline")).toHaveTextContent("offline");
  });

  it("signs out when the server actually rejects the session", async () => {
    mocks.get.mockResolvedValueOnce(OWNER);
    const first = renderAuth();
    await waitFor(() => expect(screen.getByTestId("who")).toHaveTextContent("owner"));
    first.unmount();

    // A real 401 must clear the cache, or a revoked session would live on.
    mocks.get.mockRejectedValueOnce(apiError(401));
    renderAuth();
    await waitFor(() => expect(screen.getByTestId("who")).toHaveTextContent("signed-out"));
    expect(screen.getByTestId("offline")).toHaveTextContent("online");
    expect(localStorage.getItem("ledger_me")).toBeNull();
  });

  it("stays signed out offline when nobody ever signed in here", async () => {
    mocks.get.mockRejectedValueOnce(apiError(0));
    renderAuth();
    await waitFor(() => expect(screen.getByTestId("who")).toHaveTextContent("signed-out"));
    // No cached identity means no offline mode to announce.
    expect(screen.getByTestId("offline")).toHaveTextContent("online");
  });
});
