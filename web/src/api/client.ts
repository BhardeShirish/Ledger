import { csrfToken } from "../lib/csrf";
import { enqueue } from "../lib/outbox";

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** Daily-entry endpoints safe to queue while offline. */
const OFFLINE_OK = new Set([
  "/attendance/bulk", "/attendance/mark", "/sales/manual", "/expenses",
]);

export async function request(path: string, opts: RequestInit = {}): Promise<any> {
  let res: Response;
  try {
    const headers = new Headers(opts.headers);
    if (!(opts.body instanceof FormData)) headers.set("Content-Type", "application/json");
    if (opts.method && !["GET", "HEAD", "OPTIONS"].includes(opts.method)) {
      const csrf = csrfToken();
      if (csrf) headers.set("X-CSRF-Token", csrf);
    }
    res = await fetch(`/api${path}`, {
      credentials: "include",
      ...opts,
      headers,
    });
  } catch (netErr) {
    // Network unreachable → queue daily-entry writes so nothing is lost.
    if ((opts.method === "POST" || opts.method === "PUT") &&
        OFFLINE_OK.has(path) && opts.body) {
      enqueue(`/api${path}`, opts.method, JSON.parse(String(opts.body)), path);
      throw new ApiError("Saved offline — it will sync automatically when the connection returns.", 0);
    }
    throw new ApiError(
      "Ledger server is not reachable. Close this tab and open the Ootaa Ledger desktop shortcut.",
      0,
    );
  }
  if (res.status === 204) return null;
  const isJson = res.headers.get("content-type")?.includes("json");
  const data = isJson ? await res.json() : await res.blob();
  if (!res.ok) {
    if (res.status === 401) {
      window.dispatchEvent(new Event("ledger:session-expired"));
    }
    const detail = (data as any)?.detail ?? `Request failed (${res.status})`;
    throw new ApiError(
      typeof detail === "string" ? detail : JSON.stringify(detail),
      res.status,
    );
  }
  return data;
}

export const api = {
  get: (path: string) => request(path),
  post: (path: string, body?: unknown) =>
    request(path, { method: "POST", body: body instanceof FormData ? body : JSON.stringify(body ?? {}) }),
  put: (path: string, body?: unknown) =>
    request(path, { method: "PUT", body: JSON.stringify(body ?? {}) }),
  patch: (path: string, body?: unknown) =>
    request(path, { method: "PATCH", body: JSON.stringify(body ?? {}) }),
  del: (path: string) => request(path, { method: "DELETE" }),
};

export async function downloadFile(path: string, filename: string) {
  const res = await fetch(`/api${path}`, { credentials: "include" });
  if (!res.ok) throw new ApiError("Download failed", res.status);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
