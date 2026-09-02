/** Service-worker registration.
 *
 * A PWA that caches its own shell can strand a user on an old build forever,
 * so an update is applied on the next navigation rather than left waiting for
 * every tab to close. Registration is skipped on http:// origins other than
 * localhost because browsers reject it there anyway.
 */
export function registerServiceWorker(): void {
  if (!("serviceWorker" in navigator)) return;

  const secure = window.isSecureContext;
  if (!secure) return;

  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").then((reg) => {
      reg.addEventListener("updatefound", () => {
        const next = reg.installing;
        if (!next) return;
        next.addEventListener("statechange", () => {
          // A previous controller means this is an update, not a first install.
          if (next.state === "installed" && navigator.serviceWorker.controller) {
            next.postMessage("skip-waiting");
          }
        });
      });
    }).catch(() => {
      // An unavailable service worker must never stop the app loading.
    });

    let reloading = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloading) return;
      reloading = true;
      window.location.reload();
    });
  });
}
