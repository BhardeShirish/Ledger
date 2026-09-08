import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { todayISO } from "./format";

function isPastBusinessDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value > todayISO()) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(year, month - 1, day);
  return parsed.getFullYear() === year
    && parsed.getMonth() === month - 1
    && parsed.getDate() === day;
}

/**
 * A day-picker's state, seeded from `?date=` so catch-up links land on the day
 * they name. Anything malformed or in the future falls back to today, because
 * no screen here can record a day that has not happened yet.
 */
export function useDateParam() {
  const [params] = useSearchParams();
  const [date, setDate] = useState(() => {
    const asked = params.get("date") ?? "";
    return isPastBusinessDate(asked) ? asked : todayISO();
  });
  // Date inputs can be changed by scripts as well as their max attribute.
  // Keep future or malformed dates out of every caller's API query.
  const safeSetDate = (next: string) => {
    if (isPastBusinessDate(next)) setDate(next);
  };
  return [date, safeSetDate] as const;
}
