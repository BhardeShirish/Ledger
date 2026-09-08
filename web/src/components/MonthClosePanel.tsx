import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { useState } from "react";
import { api } from "../api/client";
import { useGuarded } from "../lib/auth";
import { fmtDateShort, inr } from "../lib/format";
import { Badge, Button, Card, ErrorNote, Input } from "./ui";

export function MonthClosePanel({ outletId, month }: { outletId: number; month: string }) {
  const guarded = useGuarded();
  const qc = useQueryClient();
  const [force, setForce] = useState(false);
  const [reopen, setReopen] = useState(false);
  const [reason, setReason] = useState("");
  const q = useQuery({
    queryKey: ["close-inbox", outletId, month],
    queryFn: () => api.get(`/control/close-inbox?outlet_id=${outletId}&month=${month}`),
  });
  const action = useMutation({
    mutationFn: () => guarded(() => api.post(
      reopen ? "/control/month/reopen" : "/control/month/close",
      { outlet_id: outletId, month, force, reason },
    )),
    onSuccess: () => {
      setReason(""); setForce(false); setReopen(false);
      qc.invalidateQueries({ queryKey: ["close-inbox", outletId, month] });
    },
  });
  const data = q.data;
  if (q.isLoading || !data) return null;
  const items: any[] = data.items ?? [];

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-rule px-4 py-3">
        <div>
          <h2 className="font-semibold">Month close</h2>
          <p className="mt-0.5 text-sm text-ink-faint">
            {data.locked ? "This period is locked against financial changes."
              : data.blockers ? `${data.blockers} blocker${data.blockers === 1 ? "" : "s"} before close.`
              : "This period is ready to close."}
          </p>
        </div>
        <Badge tone={data.locked ? "good" : data.blockers ? "bad" : "accent"}>
          {data.locked ? "closed" : data.blockers ? "needs action" : "ready"}
        </Badge>
      </div>
      {items.length > 0 && (
        <div className="divide-y divide-rule">
          {items.map((item) => (
            <Link key={item.id} to={`${item.link}${item.link.includes("?") ? "&" : "?"}date=${item.date}`}
                  className="flex items-center gap-3 px-4 py-2.5 hover:bg-paper-3/50">
              <Badge tone={item.severity === "blocker" ? "bad" : "warn"}>
                {item.severity === "blocker" ? "blocker" : "review"}
              </Badge>
              <span className="min-w-0 flex-1 text-sm">{item.title}</span>
              {item.amount_paise != null && (
                <span className="num shrink-0 text-sm">{inr(item.amount_paise, { sign: item.kind === "cash_variance" })}</span>
              )}
              <span className="shrink-0 text-xs text-ink-faint">{fmtDateShort(item.date)}</span>
            </Link>
          ))}
        </div>
      )}
      <div className="space-y-2 border-t border-rule px-4 py-3">
        {(force || reopen) && (
          <Input value={reason} onChange={(event) => setReason(event.target.value)}
                 placeholder={reopen ? "Why is this period being reopened?" : "Why are blockers being overridden?"}
                 aria-label="Month close reason" />
        )}
        <div className="flex flex-wrap justify-end gap-2">
          {!data.locked && data.blockers > 0 && !force && (
            <Button variant="outline" size="sm" onClick={() => setForce(true)}>
              Close with explanation
            </Button>
          )}
          {data.locked ? (
            <Button variant="outline" size="sm" onClick={() => setReopen(!reopen)}
                    disabled={action.isPending}>
              Reopen month
            </Button>
          ) : (
            <Button size="sm" disabled={action.isPending || (force && !reason.trim())}
                    onClick={() => action.mutate()}>
              {action.isPending ? "Saving…" : force ? "Close despite blockers" : "Close month"}
            </Button>
          )}
          {data.locked && reopen && (
            <Button size="sm" disabled={action.isPending || !reason.trim()} onClick={() => action.mutate()}>
              {action.isPending ? "Reopening…" : "Confirm reopen"}
            </Button>
          )}
        </div>
        <ErrorNote msg={action.error?.message ?? ""} />
      </div>
    </Card>
  );
}
