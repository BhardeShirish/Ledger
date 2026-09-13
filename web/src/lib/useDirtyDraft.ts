import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { useDraftGuard } from "../components/Layout";

type DirtyDraftOptions = {
  /** True while the form is on screen. A closed form never holds a draft. */
  open: boolean;
  /** Reads inside "Your {label} has unsaved changes." — keep it a noun phrase. */
  label: string;
  /** What the person can see in the form right now. */
  values: unknown;
  /** The same shape with nothing entered: a blank add form, or the saved record. */
  pristine: unknown;
  /** Put the form back on `pristine` and close it. Runs on an intentional discard. */
  discard: () => void;
};

/**
 * Protects one form's unsaved draft with the Layout draft guard.
 *
 * Dirty means the form differs from `pristine`, so an untouched form — blank or
 * prefilled — never warns, and a save that refreshes the record clears the guard
 * on its own. Typing a value back to what it was clears it too.
 */
export function useDirtyDraft({ open, label, values, pristine, discard }: DirtyDraftOptions) {
  const { registerDirtyDraft, requestDiscard } = useDraftGuard();
  const dirty = open && JSON.stringify(values) !== JSON.stringify(pristine);
  const discardRef = useRef(discard);
  discardRef.current = discard;

  useLayoutEffect(() => {
    registerDirtyDraft(dirty ? { label, discard: () => discardRef.current() } : null);
    return () => registerDirtyDraft(null);
  }, [dirty, label, registerDirtyDraft]);

  // Closing the tab is outside the router, so it needs the browser's own prompt.
  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  /** Closes the form, asking first when there is something to lose. */
  const close = useCallback(
    () => requestDiscard(() => discardRef.current()),
    [requestDiscard],
  );
  /** Runs any other draft-losing action behind the same question. */
  const guard = useCallback(
    (action: () => void) => requestDiscard(action),
    [requestDiscard],
  );

  return { dirty, close, guard };
}
