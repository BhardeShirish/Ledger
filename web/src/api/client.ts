import { csrfToken } from "../lib/csrf";
import { createWriteId, enqueue, isWriteAcknowledgement } from "../lib/outbox";

export type QueuedResult = { queued: true };

export class ApiError extends Error {
  status: number;
  detail: unknown;
  constructor(message: string, status: number, detail: unknown = null) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

/** Daily-entry endpoints safe to queue while offline. */
const OFFLINE_OK = new Set([
  "/attendance/bulk", "/attendance/mark", "/sales/manual", "/expenses",
]);

type RequestOptions = RequestInit & { outboxSummary?: string };

function queueRequest(path: string, method: "POST" | "PUT",
                      opts: RequestOptions, id: string | undefined): QueuedResult {
  try {
    enqueue(`/api${path}`, method, JSON.parse(String(opts.body)), opts.outboxSummary, id);
    return { queued: true };
  } catch {
    throw new ApiError(
      "Connection lost and this entry could not be saved on this device. Keep this form open, reconnect, and check your records before retrying.",
      0,
    );
  }
}

export async function request(path: string, opts: RequestOptions = {}): Promise<any> {
  const { outboxSummary, ...fetchOptions } = opts;
  const method = (opts.method ?? "GET").toUpperCase();
  const queueable = (method === "POST" || method === "PUT") &&
    OFFLINE_OK.has(path) && typeof opts.body === "string";
  const headers = new Headers(opts.headers);
  if (!(opts.body instanceof FormData)) headers.set("Content-Type", "application/json");
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    const csrf = csrfToken();
    if (csrf) headers.set("X-CSRF-Token", csrf);
  }
  // The server may save a write even when its response never reaches the phone.
  // The first attempt and every offline retry must identify the same write.
  const idempotencyKey = queueable
    ? headers.get("X-Idempotency-Key") || createWriteId()
    : undefined;
  if (idempotencyKey) headers.set("X-Idempotency-Key", idempotencyKey);
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      credentials: "include",
      ...fetchOptions,
      method,
      headers,
    });
  } catch (netErr) {
    if (opts.signal?.aborted || (netErr instanceof DOMException && netErr.name === "AbortError")) {
      throw netErr;
    }
    // Network unreachable → queue daily-entry writes so nothing is lost.
    if (queueable) {
      return queueRequest(path, method, opts, idempotencyKey);
    }
    throw new ApiError(
      "Cannot reach Ledger. Check this device's internet or private-network connection and make sure the Ledger computer is on. Keep this page open and try again.",
      0,
    );
  }
  const isJson = res.headers.get("content-type")?.includes("json");
  if (queueable && (res.redirected || res.status >= 500 || res.status === 408 ||
      (res.ok && !isJson))) {
    return queueRequest(path, method, opts, idempotencyKey);
  }
  if (res.status === 204) return null;
  if (!isJson && res.headers.get("content-type")?.includes("text/html")) {
    throw new ApiError(
      "The connection returned a sign-in or gateway page instead of Ledger data. Reconnect to your private network or complete its sign-in, then try again.",
      res.ok ? 502 : res.status,
    );
  }
  let data: unknown;
  try {
    data = isJson ? await res.json() : await res.blob();
  } catch (error) {
    if (opts.signal?.aborted) throw error;
    if (queueable) return queueRequest(path, method, opts, idempotencyKey);
    throw new ApiError("Ledger's response was interrupted or unreadable. Keep this page open and try again.", 502);
  }
  if (!res.ok) {
    if (res.status === 401) {
      window.dispatchEvent(new Event("ledger:session-expired"));
    }
    const detail = (data as any)?.detail ?? `Request failed (${res.status})`;
    throw new ApiError(
      typeof detail === "string" ? detail : detail?.message ?? JSON.stringify(detail),
      res.status, detail,
    );
  }
  if (queueable && !isWriteAcknowledgement(`/api${path}`, data)) {
    return queueRequest(path, method, opts, idempotencyKey);
  }
  return data;
}

export const api = {
  get: (path: string) => request(path),
  post: (path: string, body?: unknown, outboxSummary?: string) =>
    request(path, { method: "POST", body: body instanceof FormData ? body : JSON.stringify(body ?? {}), outboxSummary }),
  put: (path: string, body?: unknown, outboxSummary?: string) =>
    request(path, { method: "PUT", body: JSON.stringify(body ?? {}), outboxSummary }),
  patch: (path: string, body?: unknown) =>
    request(path, { method: "PATCH", body: JSON.stringify(body ?? {}) }),
  del: (path: string) => request(path, { method: "DELETE" }),
};

const DOWNLOAD_GATEWAY_ERROR =
  "The download returned a sign-in or gateway page instead of a file, so nothing was saved. Reconnect to your private network or complete its sign-in, then try again.";
const DOWNLOAD_CONTENT_ERROR =
  "Ledger did not send a usable file, so nothing was saved. Check the Ledger server, then try the download again.";

/** First bytes a real file of each kind must start with. */
const SIGNATURES: Record<string, number[]> = {
  zip: [0x50, 0x4b, 0x03, 0x04],   // "PK\x03\x04"
  xlsx: [0x50, 0x4b, 0x03, 0x04],  // .xlsx is a zip container
  db: [..."SQLite format 3\0"].map((c) => c.charCodeAt(0)),
};

/** The server's own explanation, when the body carries one. */
async function errorDetail(res: Response): Promise<string | null> {
  try {
    const detail = (JSON.parse(await res.text()) as any)?.detail;
    return typeof detail === "string" && detail.trim() ? detail : null;
  } catch {
    return null;
  }
}

/**
 * Save a download only once the response really is the file that was asked for.
 *
 * A captive portal or reverse proxy answers with 200 and an HTML sign-in page,
 * and an API error answers with JSON. Written straight to disk under a .zip
 * name, either one looks like a backup until the night the owner tries to
 * restore from it. Refusing to save, and saying why, keeps that discovery out
 * of the emergency.
 */
export async function downloadFile(path: string, filename: string) {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { credentials: "include" });
  } catch {
    throw new ApiError(
      "Cannot reach Ledger. Check this device's connection and make sure the Ledger computer is on, then try the download again.",
      0,
    );
  }
  const type = res.headers.get("content-type") ?? "";
  if (!res.ok) {
    if (res.status === 401) window.dispatchEvent(new Event("ledger:session-expired"));
    // Status is preserved so an owner step-up (403/428) can still be offered.
    throw new ApiError(
      (await errorDetail(res)) ?? `Download failed (${res.status}). Nothing was saved.`,
      res.status,
    );
  }
  if (type.includes("html") || type.includes("json")) {
    throw new ApiError((await errorDetail(res)) ?? DOWNLOAD_GATEWAY_ERROR, 502);
  }
  let blob: Blob;
  try {
    blob = await res.blob();
  } catch {
    throw new ApiError("The download was interrupted, so nothing was saved. Try it again.", 502);
  }
  const signature = SIGNATURES[filename.split(".").pop()?.toLowerCase() ?? ""];
  if (!blob.size || (signature && !(await startsWith(blob, signature)))) {
    throw new ApiError(DOWNLOAD_CONTENT_ERROR, 502);
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

async function startsWith(blob: Blob, signature: number[]): Promise<boolean> {
  const head = new Uint8Array(await blob.slice(0, signature.length).arrayBuffer());
  return head.length === signature.length && signature.every((byte, i) => head[i] === byte);
}
