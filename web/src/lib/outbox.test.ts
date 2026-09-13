/** The outbox holds money the owner has already typed but that has not
 *  reached the server yet. Losing an item here loses a sale or an expense
 *  with no error and no trace, so these guard the two ways that can happen:
 *  a flush overlapping itself, and a flush overwriting an entry that was
 *  added while it was running. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { enqueue, flushOutbox, getOutbox, isWriteAcknowledgement, setOutboxIdentity } from "./outbox";

const expenseAck = { id: 1, outlet_id: 1, business_date: "2026-09-09", amount_rupees: 500 };

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("offline outbox", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    setOutboxIdentity(1);
    vi.unstubAllGlobals();
  });

  it("does not send the same entry twice when two flushes overlap", async () => {
    enqueue("/api/expenses", "POST", { outlet_id: 1, amount_rupees: 500 },
            "Gas cylinder");
    const gate = deferred<void>();
    const sent: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: any) => {
      sent.push(init.headers["X-Idempotency-Key"]);
      await gate.promise;
      return new Response(JSON.stringify(expenseAck), {
        status: 201, headers: { "Content-Type": "application/json" },
      });
    }));

    // The `online` event and the 60s timer can both fire a flush.
    const a = flushOutbox();
    const b = flushOutbox();
    gate.resolve();
    await Promise.all([a, b]);

    expect(sent).toHaveLength(1);
    expect(getOutbox()).toHaveLength(0);
  });

  it("keeps an entry typed while a sync is already running", async () => {
    enqueue("/api/expenses", "POST", { outlet_id: 1, amount_rupees: 500 },
            "Gas cylinder");
    const gate = deferred<void>();
    vi.stubGlobal("fetch", vi.fn(async () => {
      await gate.promise;
      return new Response(JSON.stringify(expenseAck), {
        status: 201, headers: { "Content-Type": "application/json" },
      });
    }));

    const flush = flushOutbox();
    // Owner records vegetables while the gas cylinder is still in flight.
    enqueue("/api/expenses", "POST", { outlet_id: 1, amount_rupees: 220 },
            "Vegetables");
    gate.resolve();
    await flush;

    const left = getOutbox();
    expect(left.map((i) => i.summary)).toEqual([
      "Vegetables",
    ]);
  });

  it("keeps a failed entry queued with the server's reason", async () => {
    enqueue("/api/expenses", "POST", { outlet_id: 1, amount_rupees: 500 },
            "Gas cylinder");
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false, status: 403,
      json: async () => ({ detail: "The month is closed" }),
    })));

    expect(await flushOutbox()).toBe(0);
    expect(getOutbox()[0].error).toBe("The month is closed");
  });

  it("stores an immutable summary for a queued sale", () => {
    enqueue("/api/sales/manual", "PUT", {
      outlet_id: 1, channel_kind: "cash", amount_rupees: 450,
      business_date: "2026-09-08",
    });

    expect(getOutbox()[0].summary).toBe("Sale · cash · ₹450 · 2026-09-08");
  });

  it("never removes queued money when a remote gateway returns a login page", async () => {
    enqueue("/api/expenses", "POST", { amount_rupees: 500 });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>Sign in</html>", {
      headers: { "Content-Type": "text/html" },
    })));
    expect(await flushOutbox()).toBe(0);
    expect(getOutbox()).toHaveLength(1);
    expect(getOutbox()[0].error).toContain("network sign-in");
  });

  it.each([
    ["text/plain", "Gateway login required"],
    ["application/json", '{"ok":true}'],
    ["application/json", '{"id":'],
    ["", ""],
  ])("keeps queued expenses without a complete Ledger acknowledgement (%s)", async (type, body) => {
    enqueue("/api/expenses", "POST", { amount_rupees: 500 });
    const id = getOutbox()[0].id;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, {
      headers: { "Content-Type": type },
    })));
    expect(await flushOutbox()).toBe(0);
    expect(getOutbox()[0].id).toBe(id);
  });

  it("does not acknowledge redirected responses even with matching JSON", async () => {
    enqueue("/api/expenses", "POST", { amount_rupees: 500 });
    const response = new Response(JSON.stringify(expenseAck), {
      headers: { "Content-Type": "application/json" },
    });
    Object.defineProperty(response, "redirected", { value: true });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    expect(await flushOutbox()).toBe(0);
    expect(getOutbox()).toHaveLength(1);
  });

  it.each([
    ["/api/expenses", expenseAck],
    ["/api/sales/manual", { ok: true, amount_rupees: 500 }],
    ["/api/attendance/mark", { employee_id: 1, date: "2026-09-09", status: "P" }],
    ["/api/attendance/bulk", { saved: 1, rows: [{ employee_id: 1, date: "2026-09-09", status: "P" }] }],
    ["/api/attendance/bulk", { saved: 0, rows: [] }],
  ])("accepts the existing response contract for %s", (path, body) => {
    expect(isWriteAcknowledgement(String(path), body)).toBe(true);
    expect(isWriteAcknowledgement(String(path), { ok: true })).toBe(false);
  });

  it("stops on a lost connection without sending later writes out of order", async () => {
    enqueue("/api/sales/manual", "PUT", { amount_rupees: 500 });
    enqueue("/api/sales/manual", "PUT", { amount_rupees: 700 });
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("Offline"));
    vi.stubGlobal("fetch", fetchMock);
    expect(await flushOutbox()).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getOutbox()).toHaveLength(2);
    expect(getOutbox()[0].error).toContain("saved on this device");
  });

  it("requests sign-in and keeps pending entries when the session expires", async () => {
    enqueue("/api/expenses", "POST", { amount_rupees: 500 });
    enqueue("/api/expenses", "POST", { amount_rupees: 700 });
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"detail":"Sign in"}', {
      status: 401, headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const expired = vi.fn();
    window.addEventListener("ledger:session-expired", expired);
    try {
      expect(await flushOutbox()).toBe(0);
      expect(expired).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(getOutbox()).toHaveLength(2);
    } finally {
      window.removeEventListener("ledger:session-expired", expired);
    }
  });
});
