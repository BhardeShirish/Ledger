/* Ootaa Ledger service worker.
 *
 * Its only jobs are: let the app OPEN without a network, and serve the static
 * bundle fast. It deliberately does NOT cache /api responses — a stale sales
 * figure or cash balance shown as if it were current is worse than an honest
 * error. Offline writes are handled by the outbox in the app, not here.
 */
const VERSION = "v1";
const SHELL = `ledger-shell-${VERSION}`;
const ASSETS = `ledger-assets-${VERSION}`;
const OFFLINE_URL = "/index.html";

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      // cache: "reload" so a refresh can never re-cache a stale shell from
      // the HTTP cache, which is how PWAs get stuck on an old build.
      await cache.add(new Request(OFFLINE_URL, { cache: "reload" }));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL, ASSETS]);
      await Promise.all(
        (await caches.keys())
          .filter((k) => k.startsWith("ledger-") && !keep.has(k))
          .map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

// Lets the app trigger an immediate update instead of waiting for every tab
// to close.
self.addEventListener("message", (event) => {
  if (event.data === "skip-waiting") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Never cache the API. Money must be read live or not at all.
  if (url.pathname.startsWith("/api/")) return;

  // Navigations: network first so a deployed update is picked up straight
  // away, falling back to the cached shell when there is no network.
  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(request);
          const cache = await caches.open(SHELL);
          cache.put(OFFLINE_URL, fresh.clone());
          return fresh;
        } catch {
          const cached = await caches.match(OFFLINE_URL, { cacheName: SHELL });
          return cached ?? Response.error();
        }
      })(),
    );
    return;
  }

  // Built assets carry a content hash in the filename, so a cached copy can
  // never be the wrong version — cache-first is safe and makes the app open
  // instantly on a phone.
  if (url.pathname.startsWith("/assets/") || /\.(png|svg|woff2?|ico)$/.test(url.pathname)) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(request, { cacheName: ASSETS });
        if (cached) return cached;
        const fresh = await fetch(request);
        if (fresh.ok && fresh.status === 200) {
          const cache = await caches.open(ASSETS);
          cache.put(request, fresh.clone());
        }
        return fresh;
      })(),
    );
  }
});
