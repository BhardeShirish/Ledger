import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, downloadFile, request } from "./client";
import { flushOutbox, getOutbox, setOutboxIdentity } from "../lib/outbox";

const expenseAck = { id: 1, outlet_id: 1, business_date: "2026-09-09", amount_rupees: 450 };

describe("remote and offline requests", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    setOutboxIdentity(1);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reuses the original write key when a saved expense loses its response", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("Response lost"))
      .mockResolvedValueOnce(new Response(JSON.stringify(expenseAck), {
        status: 201, headers: { "Content-Type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await api.post("/expenses", { outlet_id: 1, amount_rupees: 450 })).toEqual({ queued: true });
    const key = new Headers(fetchMock.mock.calls[0][1].headers).get("X-Idempotency-Key");
    expect(key).toBeTruthy();
    expect(getOutbox()[0].id).toBe(key);
    expect(await flushOutbox()).toBe(1);
    expect(new Headers(fetchMock.mock.calls[1][1].headers).get("X-Idempotency-Key")).toBe(key);
  });

  it("respects an explicitly supplied write key", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Offline")));
    await request("/expenses", {
      method: "POST", body: "{}", headers: { "X-Idempotency-Key": "existing-write" },
    });
    expect(getOutbox()[0].id).toBe("existing-write");
  });

  it("keeps the original key when the response body is lost after headers arrive", async () => {
    const response = new Response("", { headers: { "Content-Type": "application/json" } });
    vi.spyOn(response, "json").mockRejectedValue(new TypeError("Body lost"));
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", fetchMock);
    expect(await api.post("/expenses", {})).toEqual({ queued: true });
    const key = new Headers(fetchMock.mock.calls[0][1].headers).get("X-Idempotency-Key");
    expect(getOutbox()[0].id).toBe(key);
  });

  it.each([408, 500, 502, 503, 504])("retains the original key after an ambiguous HTTP %s", async (status) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("Gateway error", { status }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await api.post("/expenses", {})).toEqual({ queued: true });
    const key = new Headers(fetchMock.mock.calls[0][1].headers).get("X-Idempotency-Key");
    expect(getOutbox()[0].id).toBe(key);
  });

  it("keeps unconfirmed successful responses queued rather than reporting a saved expense", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('{"ok":true}', {
      headers: { "Content-Type": "application/json" },
    })));
    expect(await api.post("/expenses", {})).toEqual({ queued: true });
    expect(getOutbox()).toHaveLength(1);
  });

  it("returns a valid acknowledgement without queuing a confirmed write", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(expenseAck), {
      headers: { "Content-Type": "application/json" },
    })));
    expect(await api.post("/expenses", {})).toEqual(expenseAck);
    expect(getOutbox()).toHaveLength(0);
  });

  it("leaves validation failures with the form instead of queuing them", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('{"detail":"Amount is required"}', {
      status: 422, headers: { "Content-Type": "application/json" },
    })));
    await expect(api.post("/expenses", {})).rejects.toMatchObject({ status: 422 });
    expect(getOutbox()).toHaveLength(0);
  });

  it("does not queue cancelled writes", async () => {
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new DOMException("Cancelled", "AbortError")));
    await expect(request("/expenses", {
      method: "POST", body: "{}", signal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(getOutbox()).toHaveLength(0);
  });

  it("keeps a gateway login page from masquerading as a successful API result", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>Sign in</html>", {
      headers: { "Content-Type": "text/html" },
    })));
    await expect(api.get("/outlets")).rejects.toMatchObject({ status: 502 });
    expect(getOutbox()).toHaveLength(0);
  });

  it("reports device-storage failure rather than claiming the entry was queued", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Offline")));
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Full", "QuotaExceededError");
    });
    await expect(api.post("/expenses", {})).rejects.toThrow("could not be saved on this device");
  });

  it("gives recovery instructions usable from a phone", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Offline")));
    await expect(api.get("/outlets")).rejects.toThrow("Keep this page open");
  });

  it("can record entries over a LAN URL where randomUUID is unavailable", async () => {
    const getRandomValues = crypto.getRandomValues.bind(crypto);
    vi.stubGlobal("crypto", { getRandomValues });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Offline")));
    await api.post("/expenses", {});
    expect(getOutbox()[0].id).toMatch(/^[a-f0-9]{32}$/);
  });
});

describe("file downloads", () => {
  const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x0a, 0x00]);
  let saved: string[] = [];

  beforeEach(() => {
    saved = [];
    (URL as any).createObjectURL = vi.fn(() => "blob:ledger");
    (URL as any).revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      saved.push(this.download);
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("saves a real archive under the requested name", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(ZIP, {
      headers: { "Content-Type": "application/zip" },
    })));
    await downloadFile("/admin/backup/download", "ledger-backup-2026-09-13.zip");
    expect(saved).toEqual(["ledger-backup-2026-09-13.zip"]);
  });

  it("refuses to save a gateway sign-in page as a backup", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>Sign in</html>", {
      headers: { "Content-Type": "text/html" },
    })));
    await expect(downloadFile("/admin/backup/download", "ledger-backup.zip"))
      .rejects.toThrow(/sign-in or gateway page/);
    expect(saved).toEqual([]);
  });

  it("refuses to save an API error body as a backup and repeats what it said", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ detail: "Owner password re-verification required." }),
      { headers: { "Content-Type": "application/json" } },
    )));
    await expect(downloadFile("/admin/backup/download", "ledger-backup.zip"))
      .rejects.toThrow("Owner password re-verification required.");
    expect(saved).toEqual([]);
  });

  it("refuses bytes that are not the kind of file that was asked for", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not an archive", {
      headers: { "Content-Type": "application/octet-stream" },
    })));
    await expect(downloadFile("/admin/backup/download", "ledger-backup.zip"))
      .rejects.toThrow(/did not send a usable file/);
    expect(saved).toEqual([]);
  });

  it("refuses an empty file rather than saving a zero-byte backup", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", {
      headers: { "Content-Type": "application/zip" },
    })));
    await expect(downloadFile("/admin/backup/download", "ledger-backup.zip"))
      .rejects.toThrow(/did not send a usable file/);
    expect(saved).toEqual([]);
  });

  it("keeps the failure status so an owner step-up can still be offered", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ detail: "Password re-verification required" }),
      { status: 428, headers: { "Content-Type": "application/json" } },
    )));
    await expect(downloadFile("/admin/backup/download", "ledger-backup.zip"))
      .rejects.toMatchObject({ status: 428, message: "Password re-verification required" });
    expect(saved).toEqual([]);
  });

  it("reports an unreachable server instead of failing silently", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Offline")));
    await expect(downloadFile("/admin/backup/download", "ledger-backup.zip"))
      .rejects.toMatchObject({ status: 0 });
    expect(saved).toEqual([]);
  });
});