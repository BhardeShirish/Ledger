/** Date-range presets for the Analysis page. India FY = Apr–Mar. */
import { addDaysISO, todayISO } from "./format";

export type Range = { start: string; end: string; label: string };

const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function mondayOf(iso: string) {
  const d = new Date(iso + "T12:00:00");
  const diff = d.getDay() === 0 ? -6 : 1 - d.getDay();
  d.setDate(d.getDate() + diff);
  return ymd(d);
}

export function fyOf(dateIso: string): { start: string; end: string; label: string } {
  const d = new Date(dateIso + "T12:00:00");
  const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1; // Apr=3
  return {
    start: `${y}-04-01`, end: `${y + 1}-03-31`,
    label: `FY ${String(y).slice(2)}–${String(y + 1).slice(2)}`,
  };
}

/** The immediately preceding range of identical length. */
export function previousRange(r: Range): Range {
  const shiftDays =
    Math.round((new Date(r.end + "T12:00:00").getTime() -
                new Date(r.start + "T12:00:00").getTime()) / 86400000) + 1;
  return {
    start: addDaysISO(r.start, -shiftDays),
    end: addDaysISO(r.start, -1),
    label: `Previous ${shiftDays}d`,
  };
}

export function buildPresets(): Range[] {
  const t = todayISO();
  const now = new Date(t + "T12:00:00");
  const monthStart = t.slice(0, 8) + "01";
  const prevMEnd = new Date(now.getFullYear(), now.getMonth(), 0);
  const prevMStart = new Date(prevMEnd.getFullYear(), prevMEnd.getMonth(), 1);

  const thisFY = fyOf(t);
  const lastFYDate = `${Number(thisFY.start.slice(0, 4)) - 1}-04-01`;
  const lastFY = fyOf(lastFYDate);

  return [
    { label: "Today", start: t, end: t },
    { label: "Yesterday", start: addDaysISO(t, -1), end: addDaysISO(t, -1) },
    { label: "This week", start: mondayOf(t), end: t },
    { label: "Last 7 days", start: addDaysISO(t, -6), end: t },
    { label: "This month", start: monthStart, end: t },
    { label: "Last month",
      start: ymd(prevMStart), end: ymd(prevMEnd) },
    { label: "Last 30 days", start: addDaysISO(t, -29), end: t },
    { label: "Last 90 days", start: addDaysISO(t, -89), end: t },
    { label: "This year", start: `${now.getFullYear()}-01-01`, end: t },
    { label: thisFY.label, start: thisFY.start, end: thisFY.end > t ? t : thisFY.end },
    { label: lastFY.label, start: lastFY.start, end: lastFY.end },
    { label: "All time", start: "2020-01-01", end: t },
  ];
}
