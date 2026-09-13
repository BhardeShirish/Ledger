import { clsx } from "clsx";
import { X } from "lucide-react";
import React, { useEffect, useRef } from "react";

export const Button = ({
  variant = "primary", size = "md", className, ...p
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "ghost" | "outline" | "danger";
  size?: "sm" | "md" | "lg";
}) => (
  <button
    {...p}
    className={clsx(
      "inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-md font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
      size === "sm" && "px-2.5 py-1.5 text-sm",
      size === "md" && "px-4 py-2.5 text-sm",
      size === "lg" && "px-5 py-3 text-base",
      variant === "primary" && "bg-accent text-white hover:bg-accent/90",
      variant === "outline" && "border border-rule-strong bg-paper hover:bg-paper-3",
      variant === "ghost" && "hover:bg-paper-3",
      variant === "danger" && "bg-bad text-white hover:bg-bad/90",
      className,
    )}
  />
);

export const Card = ({ className, children, ...rest }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={clsx("card", className)} {...rest}>{children}</div>
);

export const SectionLabel = ({ children, as: Tag = "div", className, ...rest }: {
  children: React.ReactNode; as?: "div" | "h2"; className?: string;
} & React.HTMLAttributes<HTMLElement>) => (
  <Tag className={clsx("label-caps", className)} {...rest}>{children}</Tag>
);

export const Field = ({ label, hint, children, className }: {
  label: string; hint?: string; children: React.ReactNode; className?: string;
}) => (
  <label className={clsx("block", className)}>
    <div className="mb-1 text-sm font-medium text-ink-soft">{label}</div>
    {children}
    {hint && <div className="mt-1 text-xs text-ink-faint">{hint}</div>}
  </label>
);

export const inputCls =
  "rounded-md border border-rule-strong bg-paper text-ink outline-none focus:border-accent focus-visible:ring-2 focus-visible:ring-accent/30 disabled:cursor-not-allowed disabled:opacity-50";

const fieldSizeCls = {
  md: "px-3 py-2.5 text-sm",
  compact: "px-2 py-1.5 text-sm",
};
type FieldSize = keyof typeof fieldSizeCls;

/**
 * A number field selects its contents when focused.
 *
 * Correcting 450 to 540 otherwise means backspacing the old figure first,
 * every time, on every money field in the app. Text fields keep the normal
 * caret behaviour — selecting a whole note or item name on tap would fight
 * the person editing one word of it.
 */
export const Input = ({ onFocus, size = "md", fullWidth = true, className, ...p }: Omit<
  React.InputHTMLAttributes<HTMLInputElement>, "size"
> & {
  size?: FieldSize;
  fullWidth?: boolean;
}) => {
  const numeric = p.inputMode === "decimal" || p.inputMode === "numeric"
    || p.type === "number";
  return (
    <input
      {...p}
      onFocus={(e) => {
        if (numeric) e.currentTarget.select();
        onFocus?.(e);
      }}
      className={clsx(inputCls, fullWidth && "w-full", fieldSizeCls[size], numeric && "num", className)}
    />
  );
};

export const Select = ({ size = "md", className, ...p }: Omit<
  React.SelectHTMLAttributes<HTMLSelectElement>, "size"
> & {
  size?: FieldSize;
}) => (
  <select {...p} className={clsx(inputCls, fieldSizeCls[size], className)} />
);

export const Badge = ({ tone = "neutral", children }: {
  tone?: "neutral" | "good" | "bad" | "warn" | "accent"; children: React.ReactNode;
}) => (
  <span className={clsx(
    "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold",
    tone === "neutral" && "bg-paper-3 text-ink-soft",
    tone === "good" && "bg-good/10 text-green-800",
    tone === "bad" && "bg-bad/10 text-bad",
    tone === "warn" && "bg-amber-100 text-amber-800",
    tone === "accent" && "bg-accent-soft text-accent",
  )}>{children}</span>
);

export function StatTile({ label, value, sub, tone }: {
  label: string; value: string; sub?: string; tone?: "good" | "bad" | "ink";
}) {
  return (
    <Card className="px-4 py-3">
      <SectionLabel>{label}</SectionLabel>
      <div className={clsx("num mt-1 text-lg font-medium sm:text-2xl",
        tone === "good" && "text-good", tone === "bad" && "text-bad")}>
        {value}
      </div>
      {sub && <div className="mt-0.5 text-xs text-ink-faint">{sub}</div>}
    </Card>
  );
}

export function Sheet({ open, onClose, title, children, wide, side, disableClose = false }: {
  open: boolean; onClose: () => void; title: string;
  children: React.ReactNode; wide?: boolean; side?: boolean; disableClose?: boolean;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    const dialog = dialogRef.current;
    document.body.style.overflow = "hidden";
    const focusable = () => Array.from(
      dialog?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    );
    focusable()[0]?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !disableClose) {
        event.preventDefault();
        onCloseRef.current();
      }
      if (event.key === "Tab") {
        const items = focusable();
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      previous?.focus();
    };
  }, [open, disableClose]);
  if (!open) return null;
  return (
    <div className={clsx(
      "fixed inset-0 z-40 flex items-end justify-center",
      side ? "sm:items-stretch sm:justify-end" : "sm:items-center",
    )}>
      <button type="button" aria-label={`Close ${title}`}
              className="absolute inset-0 h-full w-full cursor-default bg-ink/40"
              onClick={onClose} disabled={disableClose} />
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label={title}
           className={clsx(
          "relative max-h-[92vh] w-full overflow-y-auto rounded-t-xl border border-rule-strong bg-paper shadow-sheet sm:rounded-xl",
          side ? "sm:max-h-none sm:max-w-lg sm:rounded-none sm:border-y-0 sm:border-r-0"
            : wide ? "sm:max-w-2xl" : "sm:max-w-md")}
      >
        <div className="sticky top-0 flex items-center justify-between border-b border-rule bg-paper px-5 py-3.5">
          <h2 className="font-semibold">{title}</h2>
          <button onClick={onClose} disabled={disableClose} aria-label={`Close ${title}`}
                  className="flex min-h-11 min-w-11 items-center justify-center rounded-full hover:bg-paper-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50">
            <X size={18} />
          </button>
        </div>
        <div className="sheet-content px-5 py-4">{children}</div>
      </div>
    </div>
  );
}

export function ConfirmSheet({ open, onClose, onConfirm, title, description,
  confirmLabel = "Confirm", cancelLabel = "Cancel", variant = "danger",
  pending = false, disabled = false, pendingLabel = "Working…",
}: {
  open: boolean; onClose: () => void; onConfirm: () => void;
  title: string; description: string; confirmLabel?: string; cancelLabel?: string;
  variant?: "primary" | "danger"; pending?: boolean; disabled?: boolean;
  pendingLabel?: string;
}) {
  const close = () => { if (!pending) onClose(); };
  return (
    <Sheet open={open} onClose={close} title={title} disableClose={pending}>
      <div className="space-y-4">
        <p className="whitespace-pre-line text-sm leading-relaxed text-ink-soft">{description}</p>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="outline" disabled={pending} onClick={close}>{cancelLabel}</Button>
          <Button variant={variant} disabled={disabled || pending} onClick={onConfirm}>
            {pending ? pendingLabel : confirmLabel}
          </Button>
        </div>
      </div>
    </Sheet>
  );
}

export function EmptyState({ icon, title, hint, action }: {
  icon?: React.ReactNode; title: string; hint?: string; action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-14 text-center">
      {icon && <div className="text-ink-faint">{icon}</div>}
      <div className="font-medium">{title}</div>
      {hint && <p className="max-w-xs text-sm text-ink-faint">{hint}</p>}
      {action}
    </div>
  );
}

export const Spinner = ({ label }: { label?: string }) => (
  <div role="status" className="flex items-center justify-center gap-3 py-16 text-ink-faint">
    <span className="spinner-mark h-4 w-4 animate-spin rounded-full border-2 border-rule-strong border-t-accent" />
    {label ?? "Loading…"}
  </div>
);

export function ErrorNote({ msg }: { msg: string }) {
  if (!msg) return null;
  return <div role="alert" className="rounded-md border border-bad/30 bg-bad/10 px-3 py-2 text-sm text-bad">{msg}</div>;
}

/** Sticky bottom action bar used by grid/day-sheet style pages. */
export const SaveBar = ({ show, children }: { show: boolean; children: React.ReactNode }) =>
  show ? (
    <div className="save-bar sticky z-20 -mx-4 mt-4 border-t border-rule-strong bg-paper px-4 py-3 sm:-mx-6 sm:px-6">
      {children}
    </div>
  ) : null;
