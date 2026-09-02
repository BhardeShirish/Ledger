/** Money & date presentation. All server money arrives as integer paise. */

/** Global currency presentation — mutated once by <MoneyProvider> at boot. */
export const moneyCfg = {
  code: "INR", symbol: "₹", locale: "en-IN",
  denominations: [500, 200, 100, 50, 20, 10, 5, 2, 1] as number[],
  timezone: "Asia/Kolkata",
  restaurant_name: "Ootaa Ledger",
};

export function inr(paise: number | null | undefined, opts?: { sign?: boolean }): string {
  if (paise == null) return "—";
  // A missing field arrives as undefined and turns into NaN on the way here
  // (undefined * 100). Showing "₹NaN" against a real stock item reads as
  // corrupted money; "—" honestly says "not known".
  if (!Number.isFinite(paise)) return "—";
  const v = paise / 100;
  const neg = v < 0;
  const abs = Math.abs(v);
  let s: string;
  try {
    s = abs.toLocaleString(moneyCfg.locale || "en-IN", {
      minimumFractionDigits: abs % 1 === 0 ? 0 : 2,
      maximumFractionDigits: 2,
    });
  } catch {
    s = abs.toLocaleString("en-IN", { maximumFractionDigits: 2 });
  }
  const core = `${moneyCfg.symbol}${s}`;
  // Zero is neither over nor short. Signing it ("+₹0") reads as a surplus and
  // undercuts the one number a cash count wants to show: that it balanced.
  if (opts?.sign) return v === 0 ? core : `${neg ? "−" : "+"}${core}`;
  return neg ? `−${core}` : core;
}

export const toPaise = (rupees: number | string | null | undefined): number => {
  const n = Number(rupees ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};

export const fromPaise = (paise: number | null | undefined): string =>
  paise == null ? "" : String(Math.round(paise) / 100);

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return `${DOW[new Date(y!, m! - 1, d!).getDay()]}, ${d} ${MON[m! - 1]}`;
}

export function fmtDateShort(iso: string | null | undefined): string {
  if (!iso) return "—";
  const [, m, d] = iso.slice(0, 10).split("-").map(Number);
  return `${d} ${MON[m! - 1]}`;
}

export const todayISO = (): string => {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: moneyCfg.timezone, year: "numeric", month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date());
    const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${value.year}-${value.month}-${value.day}`;
  } catch {
    return new Date().toLocaleDateString("en-CA");
  }
};

export const addDaysISO = (iso: string, days: number): string => {
  const d = new Date(iso + "T12:00:00");
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export const minToHHMM = (m: number | null | undefined): string => {
  if (m == null) return "";
  m = ((m % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};

/** "822" → "08:22", "08:22" → "08:22"; returns minutes or null */
export const parseTimeInput = (s: string): number | null => {
  s = s.trim();
  if (!s) return null;
  let h: number, m: number;
  if (s.includes(":")) {
    [h, m] = s.split(":").map(Number);
  } else if (s.length >= 3) {
    h = Number(s.slice(0, -2));
    m = Number(s.slice(-2));
  } else {
    h = Number(s);
    m = 0;
  }
  if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || h > 23 || m < 0 || m > 59) {
    return null;
  }
  const total = h * 60 + m;
  return total;
};

export const monthName = (y: number, m: number) =>
  `${["January","February","March","April","May","June","July","August","September","October","November","December"][m - 1]} ${y}`;

/** "2026-09" → "September 2026". Month pickers should never show raw ISO. */
export const monthLabel = (ym: string | null | undefined): string => {
  if (!ym) return "—";
  const [y, m] = ym.slice(0, 7).split("-").map(Number);
  if (!y || !m || m < 1 || m > 12) return ym;
  return monthName(y, m);
};

/** "2026-09" → "Sep 2026", for tight spaces like buttons. */
export const monthLabelShort = (ym: string | null | undefined): string => {
  if (!ym) return "—";
  const [y, m] = ym.slice(0, 7).split("-").map(Number);
  if (!y || !m || m < 1 || m > 12) return ym;
  return `${MON[m - 1]} ${y}`;
};

export const DOW_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
