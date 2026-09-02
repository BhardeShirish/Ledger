import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notifyError } from "./notifyError";

type Detail = { message: string; sticky: boolean };

let seen: Detail[];
const listener = (e: Event) => seen.push((e as CustomEvent<Detail>).detail);

beforeEach(() => {
  seen = [];
  window.addEventListener("ledger:api-error", listener);
});
afterEach(() => window.removeEventListener("ledger:api-error", listener));

const err = (status: number, message = "boom") =>
  Object.assign(new Error(message), { status });

describe("notifyError", () => {
  it("shows a manager why an old record refused to save", () => {
    // The whole point: a 403 used to be swallowed, so the button looked dead.
    notifyError(err(403, "Only the owner can change records this old."), "mutation");
    expect(seen).toHaveLength(1);
    expect(seen[0].message).toBe("Only the owner can change records this old.");
  });

  it("keeps a failed load on screen, because an empty page looks like no data", () => {
    notifyError(err(500), "query");
    expect(seen[0].sticky).toBe(true);
  });

  it("lets a failed action time out instead of sticking", () => {
    notifyError(err(500), "mutation");
    expect(seen[0].sticky).toBe(false);
  });

  it.each([
    [0, "offline, the outbox retries"],
    [401, "session expired, the app redirects to login"],
    [428, "owner step-up, the modal handles it"],
  ])("stays quiet on %i (%s)", (status) => {
    notifyError(err(status), "mutation");
    expect(seen).toHaveLength(0);
  });

  it("stays quiet when useGuarded already handled it", () => {
    // An owner who cancelled the password prompt chose this outcome.
    notifyError(Object.assign(err(403), { handled: true }), "mutation");
    expect(seen).toHaveLength(0);
  });

  it("still says something when the failure is not an Error", () => {
    notifyError("weird", "mutation");
    expect(seen[0].message).toBe("Something went wrong");
  });
});

describe("useGuarded marking", () => {
  it("is the contract notifyError relies on", async () => {
    // Mirrors lib/auth.tsx: a cancelled step-up marks the error handled.
    const e = err(403);
    const requireStepUp = vi.fn().mockResolvedValue(false);
    try {
      try {
        throw e;
      } catch (caught: any) {
        if (caught.status === 403) {
          const ok = await requireStepUp();
          if (!ok) caught.handled = true;
        }
        throw caught;
      }
    } catch {
      /* expected */
    }
    expect((e as any).handled).toBe(true);
    notifyError(e, "mutation");
    expect(seen).toHaveLength(0);
  });
});
