/** The outbox holds money the owner has already typed but that has not
 *  reached the server yet. Losing an item here loses a sale or an expense
 *  with no error and no trace, so these guard the two ways that can happen:
 *  a flush overlapping itself, and a flush overwriting an entry that was
 *  added while it was running. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { enqueue, flushOutbox, getOutbox, setOutboxIdentity } from "./outbox";

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
      return { ok: true, status: 201, json: async () => ({}) };
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
      return { ok: true, status: 201, json: async () => ({}) };
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
});
