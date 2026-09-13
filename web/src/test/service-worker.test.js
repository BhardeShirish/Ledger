// @vitest-environment node
/* global URL, Request, Response */
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const source = readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8");

function worker(response) {
  const handlers = new Map();
  const put = vi.fn().mockResolvedValue(undefined);
  const offline = new Response("<html>Ledger offline</html>", {
    headers: { "Content-Type": "text/html" },
  });
  const fetch = response instanceof Error
    ? vi.fn().mockRejectedValue(response)
    : vi.fn().mockResolvedValue(response);
  runInNewContext(source, {
    self: {
      location: { origin: "https://ledger.example" },
      addEventListener: (name, handler) => handlers.set(name, handler),
    },
    caches: {
      open: vi.fn().mockResolvedValue({ put }),
      match: vi.fn().mockResolvedValue(offline),
    },
    URL, Request, Response, fetch,
  });
  return {
    put, offline, fetch,
    navigate: (path = "/reports") => {
      let result;
      handlers.get("fetch")({
        request: { method: "GET", url: `https://ledger.example${path}`, mode: "navigate" },
        respondWith: (promise) => { result = promise; },
      });
      return result;
    },
  };
}

describe("offline app shell", () => {
  it("updates the cached shell only with a successful app page", async () => {
    const response = new Response("<html>Ledger</html>", { headers: { "Content-Type": "text/html" } });
    const sw = worker(response);
    expect(await sw.navigate()).toBe(response);
    expect(sw.put).toHaveBeenCalledOnce();
  });

  it("does not poison the shell with a gateway error", async () => {
    const response = new Response("<html>Bad gateway</html>", {
      status: 502, headers: { "Content-Type": "text/html" },
    });
    const sw = worker(response);
    expect(await sw.navigate()).toBe(response);
    expect(sw.put).not.toHaveBeenCalled();
  });

  it("does not cache a redirected network sign-in page", async () => {
    const response = new Response("<html>Access login</html>", {
      headers: { "Content-Type": "text/html" },
    });
    Object.defineProperty(response, "redirected", { value: true });
    const sw = worker(response);
    await sw.navigate();
    expect(sw.put).not.toHaveBeenCalled();
  });

  it("opens the last good shell when the host is unreachable", async () => {
    const sw = worker(new TypeError("Offline"));
    expect(await sw.navigate()).toBe(sw.offline);
  });

  it.each(["/api", "/api/sales"])("never intercepts financial data at %s", (path) => {
    const sw = worker(new Error("Should not fetch"));
    expect(sw.navigate(path)).toBeUndefined();
    expect(sw.fetch).not.toHaveBeenCalled();
  });
});
