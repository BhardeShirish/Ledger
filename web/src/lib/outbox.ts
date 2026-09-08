/** Offline-tolerant outbox: queues daily-entry POSTs while the LAN is down
 *  and flushes them automatically when connectivity returns. */
import { csrfToken } from "./csrf";

export type OutboxItem = {
  id: string;
  url: string;          // API path beginning /api
  method: "POST" | "PUT";
  body: any;
  summary: string;      // immutable, human-readable record of what will sync
  ts: number;
  userId: number | null;
  outletId: number | null;
  error?: string;
};

const KEY = "ledger_outbox";
const IDENTITY_KEY = "ledger_outbox_user";
const listeners = new Set<() => void>();

export function getOutbox(): OutboxItem[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "[]");
    const items = raw.map((item: any) => ({
      ...item,
      // Upgrade old entries on read so queued financial work is never shown
      // as an opaque endpoint name.
      summary: item.summary ?? fallbackSummary(item.url, item.body),
    }));
    if (items.some((item: any, index: number) => !raw[index].summary)) {
      localStorage.setItem(KEY, JSON.stringify(items));
    }
    return items;
  } catch {
    return [];
  }
}

function save(items: OutboxItem[]) {
  localStorage.setItem(KEY, JSON.stringify(items));
  listeners.forEach((fn) => fn());
}

export function subscribeOutbox(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function removeOutbox(id: string) {
  save(getOutbox().filter((item) => item.id !== id));
}

export function setOutboxIdentity(userId: number | null) {
  if (userId == null) sessionStorage.removeItem(IDENTITY_KEY);
  else sessionStorage.setItem(IDENTITY_KEY, String(userId));
}

function currentUserId() {
  const value = sessionStorage.getItem(IDENTITY_KEY);
  return value ? Number(value) : null;
}

function fallbackSummary(url: string, body: any) {
  const amount = Number(body?.amount_rupees);
  const rupees = Number.isFinite(amount) ? `₹${amount}` : "amount not specified";
  const date = body?.business_date ?? "date not specified";
  if (url === "/api/sales/manual") {
    return `Sale · ${body?.channel_kind ?? "channel"} · ${rupees} · ${date}`;
  }
  if (url === "/api/expenses") {
    return `Expense · ${body?.category_name ?? (body?.category_id ? `category #${body.category_id}` : "category")} · ${rupees} · ${body?.mode ?? "mode"} · ${date}`;
  }
  return url.replace("/api/", "") || "Queued entry";
}

export function enqueue(url: string, method: "POST" | "PUT",
                        body: any, summary?: string) {
  const items = getOutbox();
  items.push({
    id: crypto.randomUUID(), url, method, body,
    summary: summary || fallbackSummary(url, body), ts: Date.now(),
    userId: currentUserId(),
    outletId: Number.isFinite(Number(body?.outlet_id))
      ? Number(body.outlet_id) : null,
  });
  save(items);
}

let inFlight: Promise<number> | null = null;

/** Flushing twice at once sends every queued item twice and, worse, lets one
 *  flush's final save() clobber the other's. Callers all share one flush. */
export function flushOutbox(): Promise<number> {
  if (!inFlight) {
    inFlight = runFlush().finally(() => { inFlight = null; });
  }
  return inFlight;
}

async function runFlush(): Promise<number> {
  const items = getOutbox();
  if (!items.length) return 0;
  const done = new Set<string>();
  const errors = new Map<string, string | undefined>();
  let flushed = 0;
  const userId = currentUserId();
  for (const it of items) {
    if (it.userId !== userId) continue;   // another user's entry: leave it queued
    try {
      const csrf = csrfToken();
      const res = await fetch(it.url, {
        method: it.method ?? "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          ...(csrf ? { "X-CSRF-Token": csrf } : {}),
          "X-Idempotency-Key": it.id,
        },
        body: JSON.stringify(it.body),
      });
      if (res.ok) {
        flushed += 1;
        done.add(it.id);
      } else {
        let message = `Sync failed (${res.status})`;
        try {
          const body = await res.json();
          message = body.detail || message;
        } catch { }
        errors.set(it.id, message);
      }
    } catch {
      errors.set(it.id, undefined);
    }
  }
  // Re-read rather than saving the list we started with: anything the owner
  // typed while this flush was running is in storage now and saving a stale
  // snapshot would throw that entry away.
  save(getOutbox()
    .filter((it) => !done.has(it.id))
    .map((it) => (errors.has(it.id)
      ? { ...it, error: errors.get(it.id) } : it)));
  return flushed;
}
