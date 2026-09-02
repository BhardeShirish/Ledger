import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useOutletContext, Link } from "react-router-dom";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import { useGuarded } from "../lib/auth";
import { useDateParam } from "../lib/useDateParam";
import { addDaysISO, DOW_LABELS, fmtDateShort, minToHHMM, parseTimeInput, todayISO } from "../lib/format";
import { Badge, Button, Card, ErrorNote, SaveBar, SectionLabel, Spinner } from "../components/ui";
import { ExportButton, ImportButtons } from "../components/DataButtons";

type Ctx = { outletId: number };
type ShiftRow = { id: number; name: string; start: string; end: string; start_min: number; end_min: number };
type Cell = {
  date: string; dow: number; off_day: boolean; shift_name: string; scheduled_in: string;
  row: null | {
    status: string; in_min: number | null; out_min: number | null;
    late_min: number; ot_min: number; double_duty: boolean; is_open: boolean;
    shift_id: number | null;
  };
};
type Emp = { id: number; name: string; designation: string; cells: Cell[] };

const CYCLE: Record<string, string> = { P: "A", A: "H", H: "L", L: "WO", WO: "P" };
const STATUS_TONE: Record<string, string> = {
  P: "bg-good/10 text-good", A: "bg-bad/10 text-bad",
  H: "bg-amber-100 text-amber-800", L: "bg-paper-3 text-ink-faint",
  WO: "bg-paper-3 text-ink-faint",
};

export default function AttendanceGrid() {
  const { outletId } = useOutletContext<Ctx>();
  const qc = useQueryClient();
  const guarded = useGuarded();
  const [sel, setSel] = useDateParam();
  const weekStart = mondayOf(sel);
  const [dirty, setDirty] = useState<Record<string, any>>({});
  const [err, setErr] = useState("");

  const shiftsQ = useQuery({ queryKey: ["shifts"], queryFn: () => api.get("/staff/shifts") });
  const shifts: ShiftRow[] = useMemo(() => {
    const all: ShiftRow[] = shiftsQ.data ?? [];
    const named = (needle: string) =>
      all.find((s) => s.name.toLowerCase().includes(needle));
    const pair = [named("shift 1"), named("shift 2")].filter(Boolean) as ShiftRow[];
    return pair.length === 2 ? pair : all.slice(0, 2);
  }, [shiftsQ.data]);

  const q = useQuery({
    queryKey: ["att-grid", outletId, weekStart],
    queryFn: () => api.get(`/attendance/grid?outlet_id=${outletId}&start=${weekStart}&end=${addDaysISO(weekStart, 6)}`),
  });

  // Tally the month of the *selected* day, not of the week start - a week that
  // straddles a month boundary would otherwise report the previous month.
  const month = sel.slice(0, 7);
  const overview = useQuery({
    queryKey: ["att-overview", outletId, month],
    queryFn: () => api.get(`/attendance/month-overview?outlet_id=${outletId}&year=${month.slice(0, 4)}&month=${Number(month.slice(5, 7))}`),
  });

  const bulk = useMutation({
    mutationFn: async (entries: any[]) =>
      guarded(() => api.post("/attendance/bulk", {
        outlet_id: outletId, date: sel, entries,
      })),
    onSuccess: () => {
      setErr(""); setDirty({});
      qc.invalidateQueries({ queryKey: ["att-grid"] });
      qc.invalidateQueries({ queryKey: ["att-overview"] });
      qc.invalidateQueries({ queryKey: ["home"] });
    },
    onError: (e: any) => setErr(e.message),
  });

  const emps: Emp[] = q.data?.employees ?? [];
  const days = emps[0]?.cells.map((c) => c.date) ?? [];

  const valueFor = (empId: number, cell: Cell) => {
    const k = `${empId}@${cell.date}`;
    return dirty[k] ?? cell.row ?? null;
  };

  const shiftForTimes = (empId: number, cell: Cell, entry: any): ShiftRow | null => {
    if (entry?.shift_id) return shifts.find((s) => s.id === entry.shift_id) ?? null;
    if (cell.row?.shift_id) return shifts.find((s) => s.id === cell.row!.shift_id) ?? null;
    // roster-resolved name → best match among the two main shifts
    const n = (cell.shift_name || "").toLowerCase();
    if (n.includes("1") || n.includes("morn")) return shifts[0] ?? null;
    if (n.includes("2") || n.includes("even")) return shifts[1] ?? null;
    return shifts[0] ?? null;
  };

  const cycle = (empId: number, cell: Cell) => {
    const cur = valueFor(empId, cell);
    const nextStatus = CYCLE[cur?.status ?? ""] ?? "P";
    const sh = shiftForTimes(empId, cell, cur);
    update(empId, cell, {
      employee_id: empId,
      status: nextStatus,
      shift_id: sh?.id ?? null,
      in_time: ["P", "H"].includes(nextStatus) ? (sh?.start ?? "") : "",
      out_time: ["P", "H"].includes(nextStatus) ? (sh?.end ?? "") : "",
      double_duty: false,
      note: cur?.note ?? "",
    });
  };

  // A double duty runs from the staff member's own shift start to the end of
  // the last shift of the day (S1 07:00 + S2 → 07:00–23:00), not to their own
  // shift end.
  const dayEnd = useMemo(
    () => shifts.reduce<ShiftRow | null>(
      (a, s) => (!a || s.end_min > a.end_min ? s : a), null)?.end ?? "",
    [shifts]);

  const pickShift = (empId: number, cell: Cell, s: ShiftRow) => {
    const cur = valueFor(empId, cell) ?? { status: "P", double_duty: false, note: "" };
    const st = ["P", "H"].includes(cur.status) ? cur.status : "P";
    const dbl = !!cur.double_duty;
    update(empId, cell, {
      ...toEntry(cur), employee_id: empId,
      status: st, shift_id: s.id,
      in_time: s.start, out_time: dbl ? (dayEnd || s.end) : s.end,
      double_duty: dbl,
    });
  };

  const setTime = (empId: number, cell: Cell, field: "in_time" | "out_time", raw: string) => {
    const cur = valueFor(empId, cell) ?? { status: "P", double_duty: false, note: "" };
    update(empId, cell, { ...toEntry(cur), employee_id: empId, [field]: raw });
  };

  const toggleDouble = (empId: number, cell: Cell) => {
    const cur = valueFor(empId, cell) ?? { status: "P", note: "" };
    if (!["P", "H", "A"].includes(cur.status)) return;
    const next = !cur.double_duty;
    const entry = { ...toEntry(cur), employee_id: empId, double_duty: next };
    if (["P", "H"].includes(cur.status)) {
      const own = shiftForTimes(empId, cell, cur);
      entry.out_time = next ? (dayEnd || entry.out_time) : (own?.end ?? entry.out_time);
    }
    update(empId, cell, entry);
  };

  const update = (empId: number, cell: Cell, entry: any) => {
    if (cell.date !== sel) return;   // only the selected day is editable
    setDirty((d) => ({ ...d, [`${empId}@${cell.date}`]: entry }));
  };

  const saveAll = () => {
    const entries = Object.keys(dirty).map((k) => {
      const v = dirty[k];
      const mins = parseTimeInput(v.in_time ?? "");
      const outm = parseTimeInput(v.out_time ?? "");
      return {
        ...v,
        in_time: mins != null ? minToHHMM(mins) : undefined,
        out_time: outm != null ? minToHHMM(outm) : undefined,
      };
    });
    bulk.mutate(entries);
  };

  const markAllPresent = () => {
    if (!emps.length || !shifts.length) return;
    const entries = emps.map((e) => {
      const cell = e.cells.find((c) => c.date === sel)!;
      if (cell.off_day) return { employee_id: e.id, status: "WO" as const };
      const sh = shiftForTimes(e.id, cell, null) ?? shifts[0];
      return {
        employee_id: e.id, status: "P",
        shift_id: sh.id, in_time: sh.start, out_time: sh.end,
      };
    });
    bulk.mutate(entries);
  };

  const dirtyCount = Object.keys(dirty).length;

  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (Object.keys(dirty).length > 0) { e.preventDefault(); e.returnValue = ""; }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  // head-count for the day being edited, straight off the grid cells
  const dayCounts = useMemo(() => {
    const mk = { s1: { p: 0, a: 0 }, s2: { p: 0, a: 0 } };
    if (!shifts.length) return mk;
    const s1id = shifts[0]?.id, s2id = shifts[1]?.id;
    emps.forEach((e) => {
      const cell = e.cells.find((c) => c.date === sel);
      if (!cell) return;
      const v = valueFor(e.id, cell);
      const st = v?.status ?? cell.row?.status;
      if (st === "A") {
        const sid = v?.shift_id ?? cell.row?.shift_id ?? s1id;
        const n = (v?.double_duty ?? cell.row?.double_duty) ? 2 : 1;
        if (sid === s2id) mk.s2.a += n; else mk.s1.a += n;
      } else if (st === "P" || st === "H") {
        const sid = v?.shift_id ?? cell.row?.shift_id ?? s1id;
        if (sid === s2id) mk.s2.p += 1; else mk.s1.p += 1;
      }
    });
    return mk;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, emps, shifts, sel]);

  if (q.isLoading || shiftsQ.isLoading) return <Spinner />;

  const ov = overview.data?.rows ?? [];
  const monthLabel = new Date(month + "-01T12:00:00")
    .toLocaleString("en-IN", { month: "long", year: "numeric" });

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <SectionLabel>Staff · Attendance</SectionLabel>
          <h1 className="text-2xl font-semibold tracking-tight">
            {fmtDateShort(sel)}
            {sel === todayISO() && <span className="ml-2 align-middle text-sm font-normal text-accent">today</span>}
          </h1>
          <p className="mt-0.5 text-xs text-ink-faint">
            Shift 1 · {shifts[0]?.start}–{shifts[0]?.end}
            {shifts[1] && <> · Shift 2 · {shifts[1]?.start}–{shifts[1]?.end}</>}
          </p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {(["s1", "s2"] as const).map((k, i) => (
              <Badge key={k} tone={i === 0 ? "accent" : "neutral"}>
                S{i + 1}: {dayCounts[k].p} present · {dayCounts[k].a} absent
              </Badge>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {sel !== todayISO() && (
            <Button variant="outline" size="sm" disabled={dirtyCount > 0}
                    onClick={() => setSel(todayISO())}>Today</Button>
          )}
          <ExportButton entity="attendance" params={{ outlet_id: outletId, start: weekStart, end: addDaysISO(weekStart, 6) }} />

          <ImportButtons entity="attendance" outletId={outletId} onDone={() => qc.invalidateQueries({ queryKey: ["att-grid", "att-overview"] })} />

          <Button size="sm" onClick={markAllPresent} disabled={bulk.isPending}>
            All as per shift
          </Button>
        </div>
      </header>

      {/* Day picker — exactly one day is editable, and never a future one. */}
      <Card className="flex items-center gap-1 p-2">
        <Button variant="outline" size="sm" disabled={dirtyCount > 0}
                onClick={() => setSel(addDaysISO(sel, -7))}
                title="Previous week">‹</Button>
        <div className="flex flex-1 gap-1">
          {days.map((d) => {
            const future = d > todayISO();
            const active = d === sel;
            return (
              <button key={d} disabled={future || (dirtyCount > 0 && !active)}
                onClick={() => setSel(d)}
                title={future ? "That day has not happened yet"
                  : dirtyCount > 0 && !active ? "Save or discard your changes first" : ""}
                className={`flex-1 rounded-md px-1 py-1.5 text-center transition ${
                  active ? "bg-accent text-white shadow-sm"
                  : future ? "cursor-not-allowed text-ink-faint/40"
                  : "hover:bg-paper-3"}`}>
                <div className="text-[10px] font-medium uppercase tracking-wide">
                  {DOW_LABELS[(new Date(d + "T12:00:00").getDay() + 6) % 7]}
                </div>
                <div className="num text-sm font-semibold">{d.slice(8)}</div>
                {d === todayISO() && (
                  <div className={`text-[9px] font-semibold uppercase ${active ? "text-white/80" : "text-accent"}`}>
                    today
                  </div>
                )}
              </button>
            );
          })}
        </div>
        <Button variant="outline" size="sm"
                disabled={dirtyCount > 0 || addDaysISO(weekStart, 7) > todayISO()}
                onClick={() => setSel(addDaysISO(sel, 7) > todayISO() ? todayISO() : addDaysISO(sel, 7))}
                title="Next week">›</Button>
      </Card>
      <ErrorNote msg={err} />

      {/* Desktop grid */}
      <Card className="hidden overflow-x-auto md:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-rule text-left">
              <th className="px-3 py-2 font-medium">Name</th>
              {days.map((d) => {
                const dow = new Date(d + "T12:00:00").getDay();
                const active = d === sel;
                return (
                  <th key={d} className={`px-2 py-2 text-center font-medium ${
                    active ? "bg-accent/5 text-accent" : "text-ink-soft"}`}>
                    {DOW_LABELS[(dow + 6) % 7]}<br />
                    <span className="num text-xs font-normal text-ink-faint">{d.slice(8)}</span>
                    {active && <div className="text-[9px] font-semibold uppercase text-accent">editing</div>}
                  </th>
                );
              })}
              <th className="px-2 py-2 text-right font-medium">Days</th>
            </tr>
          </thead>
          <tbody>
            {emps.map((e) => {
              let credit = 0;
              e.cells.forEach((c) => {
                const v = valueFor(e.id, c);
                const st = v?.status ?? c.row?.status;
                if (st === "P") credit += 1;
                if (st === "H") credit += 0.5;
                if ((v?.double_duty ?? c.row?.double_duty) && ["P", "H"].includes(st!)) credit += 1;
              });
              return (
                <tr key={e.id} className="border-b border-rule/60 last:border-0 align-top">
                  <td className="px-3 py-2">
                    <div className="font-medium">{e.name}</div>
                    <div className="text-xs text-ink-faint">{e.designation}</div>
                  </td>
                  {e.cells.map((c) => {
                    const v = valueFor(e.id, c);
                    const st = v?.status;
                    const editable = c.date === sel;
                    const activeShiftId = v?.shift_id ?? c.row?.shift_id
                      ?? shiftForTimes(e.id, c, v)?.id;
                    if (!editable) {
                      // Read-only glance. Only the selected day can be typed
                      // into, so a mark can never land on the wrong column.
                      return (
                        <td key={c.date}
                            className={`px-1.5 py-2 text-center ${c.off_day && !st ? "bg-paper-3/50" : ""}`}>
                          <span className={`inline-block min-w-[28px] rounded px-1 py-0.5 text-xs font-semibold ${
                            STATUS_TONE[st ?? ""] ?? "text-ink-faint/60"}`}>
                            {st ?? (c.off_day ? "off" : "·")}
                            {["P", "A"].includes(st!) && v?.double_duty ? " ×2" : ""}
                          </span>
                        </td>
                      );
                    }
                    return (
                      <td key={c.date} className={`bg-accent/5 px-1.5 py-2 text-center ${c.off_day && !st ? "bg-paper-3/50" : ""}`}>
                        {/* An off day is still markable: staff do come in on
                            their day off, and a cell you cannot click is a day
                            you can never record. */}
                        <div className="mx-auto w-[104px]">
                            <button onClick={() => cycle(e.id, c)}
                                    title={`Roster: ${c.shift_name}`}
                                    className={`w-full rounded px-1 py-0.5 text-xs font-semibold ${STATUS_TONE[st ?? ""] ?? "border border-dashed border-rule-strong text-ink-faint"}`}>
                              {st ?? (c.off_day ? "off" : "+")}
                              {["P", "A"].includes(st!) ? (v?.double_duty ? " ×2" : " ×1") : ""}
                            </button>
                            {st === "A" && (
                              <button onClick={() => toggleDouble(e.id, c)}
                                      title="Absent for both shifts — counts as two days missed"
                                      className={`mt-1 w-full rounded px-1 py-0.5 text-[11px] font-bold ${
                                        v?.double_duty ? "bg-bad text-white"
                                        : "border border-rule-strong text-ink-faint hover:bg-paper-3"}`}>
                                {v?.double_duty ? "×2 absent" : "×1 absent"}
                              </button>
                            )}
                            {["P", "H"].includes(st!) && (
                              <>
                                <div className="mt-1 flex justify-center gap-0.5">
                                  {shifts.map((s, i) => (
                                    <button key={s.id} onClick={() => pickShift(e.id, c, s)}
                                            title={`${s.name} (${s.start}–${s.end})`}
                                            className={`flex-1 rounded px-1 py-0.5 num text-[10px] font-bold ${
                                              activeShiftId === s.id ? "bg-accent text-white"
                                              : "border border-rule-strong text-ink-faint hover:bg-paper-3"}`}>
                                      S{i + 1}
                                    </button>
                                  ))}
                                </div>
                                <div className="mt-0.5 flex justify-center gap-1">
                                  <input aria-label={`${e.name} ${c.date} arrival time`}
                                    placeholder="in" value={toEntry(v).in_time}
                                    onChange={(ev) => setTime(e.id, c, "in_time", ev.target.value)}
                                    className="w-9 rounded border border-rule px-0.5 text-center num text-[11px]" />
                                  <input aria-label={`${e.name} ${c.date} departure time`}
                                    placeholder="out" value={toEntry(v).out_time}
                                    onChange={(ev) => setTime(e.id, c, "out_time", ev.target.value)}
                                    className="w-9 rounded border border-rule px-0.5 text-center num text-[11px]" />
                                  <button onClick={() => toggleDouble(e.id, c)}
                                          title="Double shift — counts as an extra day"
                                          className={`rounded px-1 text-[11px] font-bold ${
                                            v?.double_duty ? "bg-accent text-white"
                                            : "text-ink-faint hover:bg-paper-3"}`}>
                                    {v?.double_duty ? "×2" : "×1"}
                                  </button>
                                </div>
                                {!!v?.late_min && <div className="text-[10px] leading-none text-bad">late</div>}
                                {!!v?.ot_min && <div className="text-[10px] leading-none text-good">OT</div>}
                              </>
                            )}
                          </div>
                      </td>
                    );
                  })}
                  <td className="num px-2 pt-2 text-right font-medium">{credit % 1 ? credit.toFixed(1) : credit}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>

      {/* Mobile: the selected day only */}
      <div className="space-y-3 md:hidden">
        {[sel].map((date) => (
          <Card key={date} className="overflow-hidden">
            <div className="flex items-center gap-2 border-b border-rule bg-paper-3/60 px-3 py-1.5 text-xs font-semibold text-ink-soft">
              {DOW_LABELS[(new Date(date + "T12:00:00").getDay() + 6) % 7]} · {fmtDateShort(date)}
              {date === todayISO() && <Badge tone="accent">today</Badge>}
            </div>
            {emps.map((e) => {
              const cell = e.cells.find((c) => c.date === date)!;
              const v = valueFor(e.id, cell);
              const st = v?.status;
              const activeShiftId = v?.shift_id ?? cell.row?.shift_id;
              return (
                <div key={e.id} className="border-b border-rule/60 px-3 py-2 last:border-0">
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm">{e.name}</span>
                    {["P", "A"].includes(st!) && (
                      <button onClick={() => toggleDouble(e.id, cell)}
                              title={st === "A" ? "Absent for both shifts" : "Double shift"}
                              aria-label={st === "A" ? "Absent for both shifts" : "Double shift"}
                              className={`inline-flex min-h-11 min-w-11 items-center justify-center rounded px-1.5 py-0.5 num text-xs font-bold sm:min-h-0 sm:min-w-0 ${
                                v.double_duty ? (st === "A" ? "bg-bad text-white" : "bg-accent text-white")
                                : "border border-rule-strong text-ink-faint"}`}>
                        ×{v.double_duty ? 2 : 1}
                      </button>
                    )}
                    <button onClick={() => cycle(e.id, cell)}
                            aria-label={`${e.name}: change attendance`}
                            className={`inline-flex min-h-11 w-11 items-center justify-center rounded px-1 py-1 text-xs font-semibold sm:min-h-0 sm:w-9 ${STATUS_TONE[st ?? ""] ?? "border border-rule-strong text-ink-faint"}`}>
                      {st ?? (cell.off_day ? "off" : "—")}
                    </button>
                  </div>
                  {["P", "H"].includes(st!) && (
                    <div className="mt-1.5 flex items-center gap-1.5 pl-1">
                      {shifts.map((s, i) => (
                        <button key={s.id} onClick={() => pickShift(e.id, cell, s)}
                                className={`rounded px-2 py-1 text-[11px] font-bold ${
                                  activeShiftId === s.id ? "bg-accent text-white"
                                  : "border border-rule-strong text-ink-faint"}`}>
                          S{i + 1} {s.start}
                        </button>
                      ))}
                      <input aria-label={`${e.name} ${date} arrival time`}
                             placeholder="in" value={toEntry(v).in_time}
                             onChange={(ev) => setTime(e.id, cell, "in_time", ev.target.value)}
                             className="w-14 rounded border border-rule-strong px-1 py-1 text-center num text-xs" />
                      <input aria-label={`${e.name} ${date} departure time`}
                             placeholder="out" value={toEntry(v).out_time}
                             onChange={(ev) => setTime(e.id, cell, "out_time", ev.target.value)}
                             className="w-14 rounded border border-rule-strong px-1 py-1 text-center num text-xs" />
                    </div>
                  )}
                </div>
              );
            })}
          </Card>
        ))}
      </div>

      <SaveBar show={dirtyCount > 0}>
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-ink-soft">{dirtyCount} change{dirtyCount > 1 ? "s" : ""} to save</span>
          <Button onClick={saveAll} disabled={bulk.isPending}>
            {bulk.isPending ? "Saving…" : "Save attendance"}
          </Button>
        </div>
      </SaveBar>

      {/* Month tally with OFF column */}
      <Card className="overflow-hidden">
        <div className="border-b border-rule bg-paper-3/40 px-4 py-2.5 flex items-center justify-between">
          <SectionLabel>{monthLabel} so far</SectionLabel>
          <span className="text-[11px] text-ink-faint">OFF = weekly offs taken</span>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-rule text-left text-xs text-ink-faint">
              <th className="px-4 py-1.5 font-medium">Name</th>
              <th className="px-2 py-1.5 text-center font-medium">P</th>
              <th className="px-2 py-1.5 text-center font-medium">×2</th>
              <th className="px-2 py-1.5 text-center font-medium">H</th>
              <th className="px-2 py-1.5 text-center font-medium">A</th>
              <th className="px-2 py-1.5 text-center font-medium">OFF</th>
              <th className="px-3 py-1.5 text-right font-medium">Credited</th>
            </tr>
          </thead>
          <tbody>
            {ov.map((r: any) => (
              <tr key={r.employee_id} className="border-b border-rule/50 last:border-0">
                <td className="px-4 py-1.5">{r.name}</td>
                <td className="num px-2 py-1.5 text-center">{r.presents}</td>
                <td className="num px-2 py-1.5 text-center">{r.doubles}</td>
                <td className="num px-2 py-1.5 text-center">{r.halves}</td>
                <td className="num px-2 py-1.5 text-center">{r.absents}</td>
                <td className="num px-2 py-1.5 text-center font-medium">{r.offs}</td>
                <td className="num px-3 py-1.5 text-right font-semibold">{r.credited_days % 1 ? r.credited_days.toFixed(1) : r.credited_days}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <p className="px-1 text-xs leading-relaxed text-ink-faint">
        Everyone defaults to <b>×1</b> on their roster shift; tap a person's <b>S1/S2</b> to say which
        shift they came in — times snap to 7–4 or 3–11 and stay editable for exceptions.
        <b> ×2</b> credits a second shift as one extra day. Older weeks: navigate back and edit —
        beyond 48h your password is asked automatically.
      </p>
    </div>
  );
}

const toEntry = (v: any) => ({
  status: v.status,
  in_time: v.in_time ?? (v.in_min != null ? minToHHMM(v.in_min) : ""),
  out_time: v.out_time ?? (v.out_min != null ? minToHHMM(v.out_min) : ""),
  double_duty: !!v.double_duty,
  shift_id: v.shift_id ?? null,
  note: v.note ?? "",
});

function mondayOf(iso: string): string {
  const d = new Date(iso + "T12:00:00");
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
