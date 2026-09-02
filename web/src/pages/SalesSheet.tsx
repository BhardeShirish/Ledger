import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useOutletContext } from "react-router-dom";
import { useEffect, useRef, useState } from "react";
import { ExportButton, ImportButtons } from "../components/DataButtons";
import { api } from "../api/client";
import { useGuarded } from "../lib/auth";
import { fmtDate, inr, todayISO } from "../lib/format";
import { useDateParam } from "../lib/useDateParam";
import { Badge, Button, Card, ErrorNote, Input, SaveBar, SectionLabel, Spinner } from "../components/ui";

type Ctx = { outletId: number };
type Row = {
  channel_kind: string;
  manual_amount_rupees: number | null;
  imported?: { bills: number; total_paise: number; tip_paise: number; tax_paise: number; net_paise: number; discount_paise: number } | null;
  effective_rupees: number | null;
};

const CHANNEL_LABEL: Record<string, string> = {
  cash: "Cash", upi: "UPI", card: "Card", wallet: "Wallet",
  aggregator: "Delivery apps", split: "Split bills", due: "Credit (due)", other: "Other",
};

export default function SalesSheet() {
  const { outletId } = useOutletContext<Ctx>();
  const [date, setDate] = useDateParam();
  const qc = useQueryClient();
  const guarded = useGuarded();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [err, setErr] = useState("");
  // beforeunload fires outside the render cycle, so it reads the latest
  // dirty set through a ref rather than a stale closure.
  const dirtyRef = useRef<string[]>([]);
  const inFlight = useRef<Set<string>>(new Set());

  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current.length > 0) { e.preventDefault(); e.returnValue = ""; }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  const q = useQuery({
    queryKey: ["sales-sheet", outletId, date],
    queryFn: () => api.get(`/sales/sheet?outlet_id=${outletId}&date=${date}`),
  });

  const save = useMutation({
    mutationFn: async (kind: string) => {
      // Clicking Save blurs the field, so the blur handler and the click can
      // both fire for the same row. Two concurrent writes to one cell race,
      // so let the first one finish and treat the second as a no-op.
      if (inFlight.current.has(kind)) return;
      inFlight.current.add(kind);
      try {
        await guarded(() => api.put("/sales/manual", {
          outlet_id: outletId, business_date: date,
          channel_kind: kind,
          amount_rupees: Number(drafts[kind] ?? "") || 0,
        }));
      } finally {
        inFlight.current.delete(kind);
      }
    },
    onSuccess: async (_data, kind) => {
      setErr("");
      // Wait for the refetch before dropping the draft, otherwise the input
      // briefly falls back to the stale server value and looks like a revert.
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["sales-sheet"] }),
        qc.invalidateQueries({ queryKey: ["home"] }),
      ]);
      setDrafts((d) => {
        const next = { ...d };
        delete next[kind];
        return next;
      });
    },
    onError: (e: any) => setErr(e.message),
  });

  if (q.isLoading) return <Spinner />;
  const rows: Row[] = q.data?.rows ?? [];
  const total = q.data?.total_rupees ?? 0;
  const lossTotal = q.data?.losses_rupees ?? 0;

  // What the server currently holds, as the input would render it.
  const savedText = (r: Row) =>
    r.manual_amount_rupees != null ? String(r.manual_amount_rupees) : "";
  // A row is dirty only if the typed text actually differs from what is saved,
  // so typing a value back to its original clears the Save bar again.
  const dirtyKinds = rows
    .filter((r) => !r.imported
      && drafts[r.channel_kind] !== undefined
      && drafts[r.channel_kind] !== savedText(r))
    .map((r) => r.channel_kind);
  dirtyRef.current = dirtyKinds;

  return (
    <div className="space-y-4">
      <header className="flex items-end justify-between">
        <div>
          <SectionLabel>Sales</SectionLabel>
          <h1 className="text-2xl font-semibold tracking-tight">{fmtDate(date)}</h1>
        </div>
        <div className="flex items-center gap-2">
          <ExportButton entity="sales_sheet"
                        params={{ outlet_id: outletId,
                                  start: `${date.slice(0, 7)}-01`,
                                  end: date }} />
          <ImportButtons entity="sales_manual" outletId={outletId}
                         onDone={() => qc.invalidateQueries({ queryKey: ["sales-sheet"] })} />
          <input type="date" value={date}
                 onChange={(e) => { setDate(e.target.value); setDrafts({}); }}
                 className="rounded-md border border-rule-strong bg-paper px-3 py-1.5 num text-sm" />
        </div>
      </header>
      <ErrorNote msg={err} />

      <Card className="divide-y divide-rule">
        {rows.map((r) => (
          <div key={r.channel_kind} className="flex items-center gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="font-medium">{CHANNEL_LABEL[r.channel_kind] ?? r.channel_kind}</div>
              {r.imported && (
                <div className="mt-0.5 flex items-center gap-2 text-xs text-ink-faint">
                  <Badge tone="accent">Petpooja</Badge>
                  {r.imported.bills} bills · tips {inr(r.imported.tip_paise)}
                </div>
              )}
              {!r.imported && r.manual_amount_rupees != null && (
                <div className="text-xs text-ink-faint">manual entry</div>
              )}
            </div>
            {r.imported ? (
              <div className="num text-right text-lg font-medium">{inr(r.imported.total_paise)}</div>
            ) : (
              <div className="w-32">
                <Input
                  inputMode="decimal" placeholder="₹"
                  value={drafts[r.channel_kind] ?? (r.manual_amount_rupees != null ? String(r.manual_amount_rupees) : "")}
                  onChange={(e) => setDrafts((d) => ({ ...d, [r.channel_kind]: e.target.value }))}
                  onBlur={() => dirtyKinds.includes(r.channel_kind) && save.mutate(r.channel_kind)}
                  onKeyDown={(e) => e.key === "Enter"
                    && dirtyKinds.includes(r.channel_kind)
                    && save.mutate(r.channel_kind)}
                  className="text-right" />
              </div>
            )}
          </div>
        ))}
      </Card>

      <LossesCard outletId={outletId} date={date}
                  rows={q.data?.losses ?? []}
                  kinds={q.data?.loss_kinds ?? []}
                  onChange={() => {
                    qc.invalidateQueries({ queryKey: ["sales-sheet"] });
                    qc.invalidateQueries({ queryKey: ["cash-day"] });
                    qc.invalidateQueries({ queryKey: ["home"] });
                  }} />

      {/* The total comes last so the page reads as the sum it is:
          takings, then what was lost, then what is actually left. */}
      <Card className="px-4 py-3.5">
        <div className="flex items-center justify-between">
          <SectionLabel>Total for the day</SectionLabel>
          <div className="num text-2xl font-semibold">{inr(Math.round(total * 100))}</div>
        </div>
        {lossTotal > 0 && (
          <div className="mt-2 space-y-1 border-t border-rule pt-2 text-sm">
            <div className="flex items-center justify-between text-ink-faint">
              <span>Less losses</span>
              <span className="num">− {inr(Math.round(lossTotal * 100))}</span>
            </div>
            <div className="flex items-center justify-between font-medium">
              <span>Net for the day</span>
              <span className="num">{inr(Math.round((q.data?.net_rupees ?? total - lossTotal) * 100))}</span>
            </div>
          </div>
        )}
      </Card>

      <p className="px-1 text-xs leading-relaxed text-ink-faint">
        Petpooja numbers win when both exist. Import the day's report from{" "}
        <Link className="underline" to="/sales/import">Sales → Import</Link> or type totals here.
        Today's rows stay editable; older ones need the owner password.
      </p>

      <SaveBar show={dirtyKinds.length > 0}>
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-ink-soft">
            {dirtyKinds.length} change{dirtyKinds.length > 1 ? "s" : ""} to save
          </span>
          <Button onClick={() => dirtyKinds.forEach((k) => save.mutate(k))}
                  disabled={save.isPending}>
            {save.isPending ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </SaveBar>
    </div>
  );
}

type LossRow = {
  id: number; kind: string; label: string;
  amount_rupees: number; from_drawer: boolean; note: string;
};
type LossKind = { kind: string; label: string; cash_capable: boolean };

function LossesCard({ outletId, date, rows, kinds, onChange }: {
  outletId: number; date: string; rows: LossRow[];
  kinds: LossKind[]; onChange: () => void;
}) {
  const guarded = useGuarded();
  const [kind, setKind] = useState("refund");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [fromDrawer, setFromDrawer] = useState(true);
  const [err, setErr] = useState("");

  const spec = kinds.find((k) => k.kind === kind);
  const canBeCash = spec?.cash_capable ?? false;

  const add = useMutation({
    mutationFn: () => guarded(() => api.post("/losses", {
      outlet_id: outletId, business_date: date, kind,
      amount_rupees: Number(amount), note,
      from_drawer: canBeCash && fromDrawer,
    })),
    onSuccess: () => { setAmount(""); setNote(""); setErr(""); onChange(); },
    onError: (e: any) => setErr(e.message),
  });
  const remove = useMutation({
    mutationFn: (id: number) => guarded(() => api.del(`/losses/${id}`)),
    onSuccess: () => { setErr(""); onChange(); },
    onError: (e: any) => setErr(e.message),
  });

  return (
    <Card className="overflow-hidden">
      <div className="border-b border-rule px-4 py-2.5">
        <SectionLabel>Losses &amp; refunds</SectionLabel>
      </div>

      {rows.length === 0 ? (
        <p className="px-4 py-3 text-sm text-ink-faint">No losses recorded for this day.</p>
      ) : (
        <div className="divide-y divide-rule">
          {rows.map((r) => (
            <div key={r.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
              <div className="min-w-0 flex-1">
                <div className="font-medium">{r.label}</div>
                {(r.note || r.from_drawer) && (
                  <div className="mt-0.5 flex items-center gap-2 text-xs text-ink-faint">
                    {r.from_drawer && <Badge tone="warn">out of drawer</Badge>}
                    {r.note && <span className="truncate">{r.note}</span>}
                  </div>
                )}
              </div>
              <div className="num font-medium">{inr(Math.round(r.amount_rupees * 100))}</div>
              <button aria-label={`Remove ${r.label}`}
                      onClick={() => confirm(
                        `Remove ${r.label} of ${inr(Math.round(r.amount_rupees * 100))}?`,
                      ) && remove.mutate(r.id)}
                      disabled={remove.isPending}
                      className="rounded px-1.5 text-ink-faint hover:text-bad disabled:opacity-40">
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="border-t border-rule bg-paper-3/30 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <select value={kind}
                  onChange={(e) => {
                    setKind(e.target.value);
                    const next = kinds.find((k) => k.kind === e.target.value);
                    setFromDrawer(next?.cash_capable ?? false);
                  }}
                  className="rounded-md border border-rule-strong bg-paper px-2 py-1.5 text-sm">
            {kinds.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}
          </select>
          <Input inputMode="decimal" placeholder="₹" value={amount}
                 onChange={(e) => setAmount(e.target.value)}
                 className="w-24 text-right" />
          <Input placeholder="Note (optional)" value={note}
                 onChange={(e) => setNote(e.target.value)}
                 className="min-w-0 flex-1" />
          <Button size="sm" disabled={!(Number(amount) > 0) || add.isPending}
                  onClick={() => add.mutate()}>
            {add.isPending ? "Adding…" : "Add"}
          </Button>
        </div>
        {canBeCash ? (
          <label className="mt-2 flex items-center gap-1.5 text-xs text-ink-soft">
            <input type="checkbox" checked={fromDrawer}
                   onChange={(e) => setFromDrawer(e.target.checked)} />
            Paid out of the cash drawer (lowers the cash expected at closing)
          </label>
        ) : (
          <p className="mt-2 text-xs text-ink-faint">
            {kind === "cash_short"
              ? "Recorded for the record only. A shortage stays visible as the day-close variance — it is not cancelled out."
              : "No effect on the cash drawer."}
          </p>
        )}
        <ErrorNote msg={err} />
      </div>
    </Card>
  );
}
