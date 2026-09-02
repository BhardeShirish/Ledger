import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { monthLabel } from "../lib/format";

/**
 * An all-zero month reads as "my data is gone" when the real cause is simply
 * that the page opened on the current month and the work was logged earlier.
 * This says where the data actually is, and offers one click to get there.
 */
export function EmptyMonthHint({ month, outletId, onJump, what = "recorded" }: {
  month: string;
  outletId: number | null;
  onJump?: (month: string) => void;
  what?: string;
}) {
  const q = useQuery({
    queryKey: ["last-activity", outletId],
    queryFn: () => api.get(`/stats/last-activity${outletId ? `?outlet_id=${outletId}` : ""}`),
    staleTime: 60_000,
  });

  const last: string | null = q.data?.month ?? null;
  if (!last || last >= month) return null;

  return (
    <div className="rounded-lg border border-rule bg-paper-2 px-4 py-3 text-sm">
      <span className="text-ink-soft">
        Nothing {what} in {monthLabel(month)}. Your last activity was{" "}
        <span className="font-medium text-ink">{monthLabel(last)}</span>.
      </span>
      {onJump && (
        <button onClick={() => onJump(last)}
                className="ml-2 font-medium text-accent underline underline-offset-2">
          View {monthLabel(last)} →
        </button>
      )}
    </div>
  );
}
