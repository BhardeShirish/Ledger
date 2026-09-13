import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useOutletContext } from "react-router-dom";
import { ArrowRight, Calculator, X } from "lucide-react";
import { useMemo, useState } from "react";
import { api } from "../api/client";
import { useAuth, useGuarded } from "../lib/auth";
import { explainedBySplit } from "../lib/cashdoubt";
import { ExportButton } from "../components/DataButtons";
import { fmtDateShort, inr, moneyCfg, todayISO } from "../lib/format";
import { useDateParam } from "../lib/useDateParam";
import { useDirtyDraft } from "../lib/useDirtyDraft";
import {
  Badge, Button, Card, ConfirmSheet, ErrorNote, Field, Input, SectionLabel, Sheet, Spinner,
  StatTile,
} from "../components/ui";

type Ctx = { outletId: number };

export default function CashRegister() {
  const { outletId } = useOutletContext<Ctx>();
  const [date, setDate] = useDateParam();
  const guarded = useGuarded();
  const qc = useQueryClient();

  const day = useQuery({
    queryKey: ["cash-day", outletId, date],
    queryFn: () => api.get(`/cash/day?outlet_id=${outletId}&date=${date}`),
  });
  const history = useQuery({
    queryKey: ["cash-history", outletId],
    queryFn: () => api.get(`/cash/closures?outlet_id=${outletId}&limit=30`),
  });

  if (day.isLoading) return <Spinner />;
  if (day.isError || !day.data) {
    return (
      <div className="space-y-3">
        <ErrorNote msg="Couldn't load this cash day. Check your connection and retry." />
        <Button variant="outline" disabled={day.isFetching} onClick={() => void day.refetch()}>
          {day.isFetching ? "Retrying cash day…" : "Retry cash day"}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <SectionLabel>Money · Cash register</SectionLabel>
          <h1 className="text-2xl font-semibold tracking-tight">{fmtDateShort(date)}</h1>
        </div>
        <Input type="date" size="compact" value={date} max={todayISO()}
               aria-label="Show the cash register for this date"
               onChange={(e) => setDate(e.target.value)} className="!w-auto" />
        <ExportButton entity="closures" params={{ outlet_id: outletId }} />
      </header>

      {(
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-5">
            <StatTile label="Opening float" value={inr(day.data.opening_paise)} sub={day.data.opening_source} />
            <StatTile label="Cash sales" value={inr(day.data.cash_sales_paise)} />
            <StatTile label="Cash expenses" value={`− ${inr(day.data.cash_expenses_paise)}`} />
            <StatTile label="Advances given" value={`− ${inr(day.data.advances_given_paise)}`} />
            {(day.data.cash_losses_paise ?? 0) > 0 && (
              <StatTile label="Refunds paid out"
                        value={`− ${inr(day.data.cash_losses_paise)}`}
                        sub="from the day sheet" />
            )}
            {(day.data.split_unknown_paise ?? 0) > 0 && (
              <StatTile label="Part-paid bills"
                        value={`? ${inr(day.data.split_unknown_paise)}`}
                        sub="cash share unknown" />
            )}
          </div>

          <Card className="flex flex-wrap items-center justify-between gap-3 px-4 py-4">
            <div>
              <SectionLabel>Expected in drawer</SectionLabel>
              <div className="num text-3xl font-semibold">{inr(day.data.expected_paise)}</div>
              {(day.data.split_unknown_paise ?? 0) > 0 && (
                <p className="mt-0.5 max-w-xs text-xs text-ink-faint">
                  Could be up to {inr(day.data.split_unknown_paise)} more —
                  that much was paid part cash, part online, and the report
                  doesn't split it.
                </p>
              )}
            </div>
            {day.data.closure && !day.data.closure.reopened ? (
              <ClosedCard closure={day.data.closure} date={date}
                          onReopened={() => {
                            qc.invalidateQueries({ queryKey: ["cash-day"] });
                            qc.invalidateQueries({ queryKey: ["cash-history"] });
                          }} />
            ) : day.data.closure?.reopened ? (
              <>
                <Badge tone="warn">reopened — recount and save again</Badge>
                <CountSheet outletId={outletId} date={date} dayData={day.data}
                            alertPaise={day.data.variance_alert_paise}
                            prior={day.data.closure}
                            onDone={() => {
                              qc.invalidateQueries({ queryKey: ["cash-day"] });
                              qc.invalidateQueries({ queryKey: ["cash-history"] });
                              qc.invalidateQueries({ queryKey: ["home"] });
                            }} />
              </>
            ) : (
              <CountSheet outletId={outletId} date={date} dayData={day.data}
                          alertPaise={day.data.variance_alert_paise}
                          prior={null}
                          onDone={() => {
                            qc.invalidateQueries({ queryKey: ["cash-day"] });
                            qc.invalidateQueries({ queryKey: ["cash-history"] });
                            qc.invalidateQueries({ queryKey: ["home"] });
                          }} />
            )}
          </Card>
        </>
      )}

      <Card>
        <div className="border-b border-rule px-4 py-2.5"><SectionLabel>Recent days</SectionLabel></div>
        {history.isError ? (
          <div className="space-y-2 px-4 py-3">
            <ErrorNote msg="Couldn't load recent cash closures." />
            <Button size="sm" variant="outline" disabled={history.isFetching}
                    onClick={() => void history.refetch()}>
              {history.isFetching ? "Retrying closures…" : "Retry recent days"}
            </Button>
          </div>
        ) : (
        <div className="divide-y divide-rule">
          {(history.data?.rows ?? []).map((c: any) => {
            const bad = Math.abs(c.variance_paise) > history.data.alert_paise;
            return (
              <div key={c.id} className="px-4 py-2.5 text-sm">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{fmtDateShort(c.date)}</span>
                  {c.reopened && <Badge tone="warn">reopened</Badge>}
                  {c.note && <span className="min-w-0 flex-1 truncate text-xs text-ink-faint">{c.note}</span>}
                </div>
                {/* Every figure carries its own label on both widths: a bare
                    column of rupees here cannot say whether it was counted,
                    carried home, or left behind. */}
                <dl className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-4">
                  <ClosureFigure label="Counted" value={inr(c.counted_paise)} />
                  <ClosureFigure label="Taken home" value={inr(c.taken_home_paise)} />
                  <ClosureFigure label="Left in drawer" value={inr(c.left_in_drawer_paise)} />
                  <ClosureFigure label="Variance" value={inr(c.variance_paise, { sign: true })}
                                 valueClass={c.variance_paise === 0 ? "text-good"
                                   : bad ? "text-bad" : "text-ink"} />
                </dl>
              </div>
            );
          })}
          {(history.data?.rows ?? []).length === 0 && (
            <div className="px-4 py-6 text-center text-sm text-ink-faint">No closed days yet.</div>
          )}
        </div>
        )}
      </Card>
    </div>
  );
}

const DENOMS_FALLBACK = [500, 200, 100, 50, 20, 10, 5, 2, 1];

function ClosureFigure({ label, value, valueClass }: {
  label: string; value: string; valueClass?: string;
}) {
  return (
    <div>
      <dt className="label-caps">{label}</dt>
      <dd className={`num mt-0.5 font-medium ${valueClass ?? ""}`}>{value}</dd>
    </div>
  );
}

function ClosedCard({ closure, date, onReopened }: {
  closure: any; date: string; onReopened: () => void;
}) {
  const { me } = useAuth();
  const guarded = useGuarded();
  const reopen = useMutation({
    mutationFn: () => guarded(() => api.post(`/cash/${closure.id}/reopen`)),
    onSuccess: () => {
      setConfirming(false);
      onReopened();
    },
  });
  const isToday = closure.date === todayISO();
  const canAsk = me?.role === "owner" || isToday;
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="flex flex-col items-end gap-2">
      <Badge tone="good">
        closed · variance {inr(closure.variance_paise, { sign: true })}
        {" "}· took home {inr(closure.taken_home_paise)}
      </Badge>
      {canAsk && (
        <Button variant="outline" size="sm" disabled={reopen.isPending}
                onClick={() => setConfirming(true)}>
          Reopen &amp; recount
          {!isToday && me?.role === "owner" ? " (password)" : ""}
        </Button>
      )}
      <ConfirmSheet
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={() => reopen.mutate()}
        title="Reopen this day?"
        description={"Reopen this day and recount the drawer?\n\n"
          + "The count you saved will be set aside until you close the day again."}
        confirmLabel="Reopen & recount"
        pending={reopen.isPending}
        pendingLabel="Reopening…"
      />
      <ErrorNote msg={reopen.error?.message ?? ""} />
    </div>
  );
}

function CountSheet({ outletId, date, dayData, alertPaise, prior, onDone }: {
  outletId: number; date: string; dayData: any; alertPaise: number;
  prior: any | null; onDone: () => void;
}) {
  const expectedPaise = dayData.expected_paise;
  const parts = {
    opening: Math.round((dayData.opening_paise ?? 0) / 100),
    sales: Math.round((dayData.cash_sales_paise ?? 0) / 100),
    expenses: Math.round((dayData.cash_expenses_paise ?? 0) / 100),
    advances: Math.round((dayData.advances_given_paise ?? 0) / 100),
    losses: Math.round((dayData.cash_losses_paise ?? 0) / 100),
  };
  const [open, setOpen] = useState(false);
  const [calcOpen, setCalcOpen] = useState(false);
  // A reopened day starts from the count that was set aside, so "unchanged"
  // means the saved count, not an empty drawer.
  const pristine = useMemo(() => ({
    counted: prior ? String(Math.round(prior.counted_paise) / 100) : "",
    takenHome: prior ? String(Math.round(prior.taken_home_paise) / 100) : "",
    note: prior?.note ?? "",
    denoms: Object.fromEntries(
      Object.entries(prior?.counted_breakdown ?? {}).map(([d, q]) => [Number(d), String(q)]),
    ) as Record<number, string>,
  }), [prior]);
  const [denoms, setDenoms] = useState<Record<number, string>>(pristine.denoms);
  const [counted, setCounted] = useState<string | null>(null);
  const [takenHome, setTakenHome] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const guarded = useGuarded();

  const openSheet = () => {
    setCounted(pristine.counted); setTakenHome(pristine.takenHome);
    setNote(pristine.note); setDenoms(pristine.denoms);
    if (prior?.counted_breakdown) setCalcOpen(true);
    setOpen(true);
  };
  const closeSheet = () => {
    setCounted(null); setTakenHome(null); setNote(null);
    setDenoms(pristine.denoms);
    setOpen(false);
  };

  const denomsList: number[] = (moneyCfg.denominations?.length
    ? moneyCfg.denominations : DENOMS_FALLBACK);
  const calcTotalPaise = denomsList.reduce(
    (s, d) => s + (Number(denoms[d]) || 0) * d * 100, 0);

  const shownCounted = counted ?? "";
  const takenHomeInput = takenHome ?? "";
  const countedValue = Number(shownCounted);
  const takenHomeValue = Number(takenHomeInput);
  const countedValid = shownCounted.trim() !== ""
    && Number.isFinite(countedValue) && countedValue >= 0;
  const takenHomeValid = takenHomeInput.trim() === ""
    || (Number.isFinite(takenHomeValue) && takenHomeValue >= 0);
  const takenHomeWithinCount = countedValid && takenHomeValid
    && (takenHomeInput.trim() === "" || takenHomeValue <= countedValue);
  const closeValidationError = shownCounted.trim() !== "" && !countedValid
    ? "Counted cash must be a finite amount of ₹0 or more."
    : takenHomeInput.trim() !== "" && !takenHomeValid
      ? "Cash taken home must be a finite amount of ₹0 or more."
      : countedValid && takenHomeValid && !takenHomeWithinCount
        ? "Cash taken home cannot exceed the counted cash."
        : "";
  const close = useMutation({
    mutationFn: () => guarded(() => api.post("/cash/close", {
      outlet_id: outletId,
      date,
      counted_rupees: countedValue,
      taken_home_rupees: takenHomeInput.trim() === "" ? 0 : takenHomeValue,
      breakdown: calcTotalPaise > 0
        ? Object.fromEntries(Object.entries(denoms).filter(([, q]) => Number(q) > 0))
        : undefined,
      note: note ?? "",
    })),
    onSuccess: () => {
      setOpen(false); setNote(null); setDenoms({});
      setCounted(null); setTakenHome(null); onDone();
    },
  });
  const draft = useDirtyDraft({
    open, label: "cash count",
    values: { counted: shownCounted, takenHome: takenHomeInput, note: note ?? "", denoms },
    pristine: pristine,
    discard: closeSheet,
  });

  if (!open)
    return (
      <Button size="lg" onClick={openSheet}>
        {prior ? "Recount & re-close" : "Count & close the day"}
      </Button>
    );

  const countedP = countedValid ? Math.round(countedValue * 100) : 0;
  const variance = countedP - expectedPaise;
  // Part-paid bills hide an unknown amount of cash sales, so the drawer
  // counting high by up to that much is arithmetic, not a discrepancy.
  // Only a surplus is explained: a shortage still needs chasing.
  const splitUnknownPaise = dayData.split_unknown_paise ?? 0;
  const splitExplains = explainedBySplit(variance, splitUnknownPaise);
  const takenP = takenHomeValid && takenHomeInput.trim() !== ""
    ? Math.round(takenHomeValue * 100) : 0;
  const leftP = countedP - takenP;
  const reasonNeeded = countedValid && variance !== 0;

  return (
    <Sheet open onClose={draft.close} title="Close the day" wide>
      <div className="space-y-4">
        {/* The math, transparent */}
        <Card className="bg-paper-3/50 px-4 py-3">
          <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm sm:grid-cols-4">
            <Line label="Opening" value={`₹${parts.opening.toLocaleString("en-IN")}`} />
            <Line label="+ Cash sales" value={`₹${parts.sales.toLocaleString("en-IN")}`} />
            <Line label="− Cash expenses" value={`₹${parts.expenses.toLocaleString("en-IN")}`} />
            <Line label="− Advances given" value={`₹${parts.advances.toLocaleString("en-IN")}`} />
            <Line label="− Drawer-paid refunds/losses" value={`₹${parts.losses.toLocaleString("en-IN")}`} />
          </div>
          {(dayData.split_unknown_paise ?? 0) > 0 && (
            <p className="mt-2 text-xs text-ink-faint">
              Part-paid bills are not included: their cash share is unknown.
            </p>
          )}
          <div className="mt-2 border-t border-rule pt-2 flex items-center justify-between">
            <span className="text-sm font-semibold">Expected in drawer</span>
            <span className="num text-2xl font-semibold">{inr(expectedPaise)}</span>
          </div>
        </Card>

        {/* Count */}
        <Field label="Count the cash now" hint="Use the calculator below or type the total you counted.">
          <div className="flex gap-2">
            <Input inputMode="decimal" placeholder="₹ counted" value={shownCounted}
                   onChange={(e) => setCounted(e.target.value)} className="text-right text-xl" />
            <Button variant="outline" onClick={() => setCalcOpen(!calcOpen)}>
              <Calculator size={15} /> Note calculator
            </Button>
          </div>
        </Field>

        {calcOpen && (
          <Card className="p-4">
            <SectionLabel>Note & coin calculator</SectionLabel>
            <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-3">
              {denomsList.map((d) => (
                <div key={d} className="flex items-center gap-1.5">
                  <span className="num w-12 text-right text-xs text-ink-faint">₹{d}</span>
                  <X size={12} aria-hidden="true" className="shrink-0 text-ink-faint" />
                  <Input size="compact" inputMode="numeric" placeholder="0"
                         aria-label={`Number of ${moneyCfg.symbol}${d} notes or coins counted`}
                         value={denoms[d] ?? ""}
                         onChange={(e) => setDenoms((x) => ({ ...x, [d]: e.target.value }))}
                         className="text-center" />
                </div>
              ))}
            </div>
            <div className="mt-3 flex items-center justify-between border-t border-rule pt-2">
              <span className="text-sm text-ink-soft">Calculator total</span>
              <div className="flex items-center gap-2">
                <span className="num text-lg font-semibold">{inr(calcTotalPaise)}</span>
                <Button size="sm"
                        disabled={calcTotalPaise === 0}
                        onClick={() => { setCounted(String(calcTotalPaise / 100)); }}>
                  Use this count
                </Button>
              </div>
            </div>
          </Card>
        )}

        {/* Variance verdict */}
        {countedValid && (
          <Card className={`px-4 py-3 ${
            variance === 0 ? "bg-good/10"
              : splitExplains ? ""
              : Math.abs(variance) > alertPaise ? "bg-bad/10" : ""}`}>
            <div className="flex items-center justify-between">
              <SectionLabel>Variance vs expected</SectionLabel>
              <span className={`num text-2xl font-semibold ${
                variance === 0 ? "text-good"
                  : splitExplains ? "text-ink-soft"
                  : variance > 0 ? "text-accent" : "text-bad"}`}>
                {inr(variance, { sign: true })}
              </span>
            </div>
            {splitExplains && (
              <p className="mt-1 text-xs text-ink-faint">
                Explained: {inr(splitUnknownPaise)} of today's sales were paid
                part cash, part online, and the sales report doesn't say how
                much was cash. A surplus up to that much is expected — not a
                shortage to chase.
              </p>
            )}
          </Card>
        )}

        {/* Take home */}
        <Field label="Cash you're taking home tonight"
               hint={`Whatever stays behind becomes tomorrow's opening float.`}>
          <div className="flex gap-2">
            <Input inputMode="decimal" placeholder="₹ taking home"
                   value={takenHome ?? ""}
                   onChange={(e) => setTakenHome(e.target.value)}
                   className="text-right" />
            <Button variant="outline"
                    disabled={!countedValid}
                    onClick={() => setTakenHome(String(countedP / 100))}>
              Take all ₹{countedP / 100}
            </Button>
          </div>
        </Field>
        {takenHomeInput !== "" && takenHomeWithinCount && (
          <Card className="px-4 py-2.5 text-sm">
            <span className="inline-flex items-center gap-1">Left in drawer <ArrowRight size={14} aria-hidden="true" /> tomorrow's opening:</span>
            <span className="num ml-1 font-semibold">{inr(leftP)}</span>
          </Card>
        )}

        {/* Reason gate */}
        {reasonNeeded && (
          <Field label="Variance reason (required)" hint="The day cannot close without explaining a non-zero variance.">
            <Input value={note ?? ""} required
                   aria-invalid={!(note ?? "").trim()}
                   onChange={(e) => setNote(e.target.value)}
                   placeholder="e.g., ₹200 chit pending with Ramesh" />
          </Field>
        )}

        <ErrorNote msg={(close.error?.message ?? closeValidationError)
          || (reasonNeeded && !(note ?? "").trim()
            ? "Variance must be explained before closing." : "")} />

        <Button size="lg" className="w-full"
                disabled={!countedValid || !takenHomeValid || !takenHomeWithinCount || close.isPending ||
                          (reasonNeeded && !(note ?? "").trim())}
                onClick={() => close.mutate()}>
          Close {date}
        </Button>
      </div>
    </Sheet>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-ink-soft">{label}</span>
      <span className="num font-medium">{value}</span>
    </div>
  );
}
