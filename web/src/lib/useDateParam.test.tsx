import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { useDateParam } from "./useDateParam";
import { todayISO } from "./format";

function at(url: string) {
  return renderHook(() => useDateParam(), {
    wrapper: ({ children }) => <MemoryRouter initialEntries={[url]}>{children}</MemoryRouter>,
  }).result.current[0];
}

describe("useDateParam", () => {
  it("opens on the day a catch-up link names", () => {
    expect(at("/sales?date=2020-03-04")).toBe("2020-03-04");
  });

  it("falls back to today when no date is asked for", () => {
    expect(at("/sales")).toBe(todayISO());
  });

  it("refuses a future date", () => {
    expect(at("/sales?date=2999-01-01")).toBe(todayISO());
  });

  it("refuses a malformed date rather than passing it to the API", () => {
    expect(at("/sales?date=yesterday")).toBe(todayISO());
    expect(at("/sales?date=2020-3-4")).toBe(todayISO());
  });
});
