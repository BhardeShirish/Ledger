/**
 * Turns a failed API call into the banner the user actually sees.
 *
 * A few statuses are already handled elsewhere and must stay quiet, but
 * everything else has to be shown: a mutation that fails without a message
 * looks to the user like a button that simply does nothing.
 */
export function notifyError(error: unknown, kind: "query" | "mutation") {
  const status = (error as any)?.status;
  // 0 = offline (the outbox retries it), 401 = session expired (the app
  // redirects to login), 428 = owner step-up (the modal handles it).
  if ([0, 401, 428].includes(status)) return;
  // useGuarded marks the errors it has already dealt with, such as an owner
  // who cancelled the password prompt on purpose.
  if ((error as any)?.handled) return;
  const message = error instanceof Error ? error.message : "Something went wrong";
  window.dispatchEvent(new CustomEvent("ledger:api-error", {
    // A failed load leaves the page looking merely empty, which reads as
    // "no data" rather than "not loaded", so that banner stays put and
    // offers a retry. A failed action is transient and may time out.
    detail: { message, sticky: kind === "query" },
  }));
}
