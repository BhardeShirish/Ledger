import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { todayISO } from "./format";

/**
 * A day-picker's state, seeded from `?date=` so catch-up links land on the day
 * they name. Anything malformed or in the future falls back to today, because
 * no screen here can record a day that has not happened yet.
 */
export function useDateParam() {
  const [params] = useSearchParams();
  return useState(() => {
    const asked = params.get("date") ?? "";
    return /^\d{4}-\d{2}-\d{2}$/.test(asked) && asked <= todayISO() ? asked : todayISO();
  });
}
