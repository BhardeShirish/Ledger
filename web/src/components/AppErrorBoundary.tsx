import React from "react";

const RELOAD_KEY = "ledger:chunk-reloaded-at";
// Long enough that a genuinely broken chunk cannot spin, short enough that a
// second real update later in the day still gets its own automatic recovery.
const RELOAD_COOLDOWN_MS = 30_000;

/**
 * A page is code-split, so after an update the browser may still hold an old
 * index.html that asks for chunk files which no longer exist. The import then
 * rejects, React unmounts the tree, and the user sees a blank page that only a
 * manual refresh fixes. Reload once automatically instead.
 *
 * The cooldown is the whole safety mechanism: the reload re-mounts this
 * boundary, so anything that clears the marker on mount turns a blank page
 * into an infinite reload loop.
 */
function isStaleChunkError(error: unknown): boolean {
  const msg = String((error as any)?.message ?? error ?? "");
  return /dynamically imported module|Loading chunk|Importing a module script failed|Failed to fetch/i
    .test(msg);
}

function reloadedRecently(now: number = Date.now()): boolean {
  const at = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0);
  return at > 0 && now - at < RELOAD_COOLDOWN_MS;
}

type Props = { children: React.ReactNode };
type State = { error: Error | null };

export default class AppErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    if (isStaleChunkError(error) && !reloadedRecently()) {
      sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
      window.location.reload();
    }
  }

  private retry = (to?: string) => {
    // An explicit click is the user telling us to try again, so it clears the
    // cooldown that the automatic path relies on.
    sessionStorage.removeItem(RELOAD_KEY);
    if (to) window.location.assign(to);
    else window.location.reload();
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    const stale = isStaleChunkError(error);
    return (
      <main className="mx-auto max-w-md p-10 text-center">
        <h1 className="text-xl font-semibold">
          {stale ? "Ledger was updated" : "Something went wrong"}
        </h1>
        <p className="mt-2 text-sm text-ink-faint">
          {stale
            ? "This page changed while it was open. Reload to get the new version."
            : "This page could not be displayed. Your saved data is not affected."}
        </p>
        <div className="mt-5 flex justify-center gap-2">
          <button onClick={() => this.retry()}
                  className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white">
            Reload
          </button>
          <button onClick={() => this.retry("/")}
                  className="rounded-md border border-rule-strong px-3 py-1.5 text-sm">
            Go home
          </button>
        </div>
      </main>
    );
  }
}

export const __test = { isStaleChunkError, reloadedRecently, RELOAD_KEY, RELOAD_COOLDOWN_MS };
