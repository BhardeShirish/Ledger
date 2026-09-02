import { afterEach, describe, expect, it, vi } from "vitest";

import {
  addDaysISO,
  fromPaise,
  inr,
  minToHHMM,
  moneyCfg,
  monthLabel,
  monthLabelShort,
  parseTimeInput,
  toPaise,
  todayISO,
} from "./format";

afterEach(() => {
  vi.useRealTimers();
  moneyCfg.timezone = "Asia/Kolkata";
});

describe("money formatting", () => {
  it("rounds rupees to integer paise and formats signed values", () => {
    expect(toPaise("12.345")).toBe(1235);
    expect(toPaise(Number.NaN)).toBe(0);
    expect(fromPaise(1235)).toBe("12.35");
    expect(inr(-12350, { sign: true })).toBe("−₹123.50");
    expect(inr(12350, { sign: true })).toBe("+₹123.50");
  });

  it("leaves a balanced cash count unsigned instead of reading as a surplus", () => {
    // A drawer that matches exactly is the good outcome; "+₹0" implies extra.
    expect(inr(0, { sign: true })).toBe("₹0");
  });

  it("never renders NaN money when a field is missing", () => {
    // A component reading a field the endpoint does not send yields
    // undefined * 100 = NaN. "₹NaN" against a real item reads as corruption.
    expect(inr(Number.NaN)).toBe("—");
    expect(inr(undefined as unknown as number * 100)).toBe("—");
    expect(inr(Number.POSITIVE_INFINITY)).toBe("—");
    expect(inr(Number.NaN, { sign: true })).toBe("—");
  });
});

describe("month labels", () => {
  it("turns an ISO month into something a person reads", () => {
    expect(monthLabel("2026-09")).toBe("September 2026");
    expect(monthLabel("2026-09-02")).toBe("September 2026");
    expect(monthLabelShort("2026-01")).toBe("Jan 2026");
  });

  it("does not invent a month when the input is unusable", () => {
    expect(monthLabel(null)).toBe("—");
    expect(monthLabel("")).toBe("—");
    expect(monthLabel("2026-13")).toBe("2026-13");
  });
});

describe("business dates", () => {
  it("uses the configured business timezone", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T20:00:00Z"));
    expect(todayISO()).toBe("2025-01-02");
  });

  it("adds days across month and leap-year boundaries", () => {
    expect(addDaysISO("2024-02-28", 1)).toBe("2024-02-29");
    expect(addDaysISO("2024-12-31", 1)).toBe("2025-01-01");
  });
});

describe("attendance time helpers", () => {
  it("parses supported clock formats and rejects invalid times", () => {
    expect(parseTimeInput("822")).toBe(502);
    expect(parseTimeInput("08:22")).toBe(502);
    expect(parseTimeInput("8")).toBe(480);
    expect(parseTimeInput("24:00")).toBeNull();
    expect(parseTimeInput("8:60")).toBeNull();
  });

  it("normalizes minutes into a 24-hour clock", () => {
    expect(minToHHMM(502)).toBe("08:22");
    expect(minToHHMM(-1)).toBe("23:59");
  });
});
