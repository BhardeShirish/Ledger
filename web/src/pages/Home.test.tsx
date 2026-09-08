/**
 * The home page's daily checklist.
 *
 * The page's whole job is to answer one question on a busy morning: what do I
 * do next? So exactly one step is highlighted, it is never an optional one,
 * and once the round is done nothing nags.
 */
import { describe, expect, it } from "vitest";

import { nextStep, steps } from "./Home";

/** A day where nothing has been entered yet. */
function freshDay(over: any = {}) {
  return {
    attendance: { done: false, total: 6, marked: 0, open: 0 },
    sales: { done: false, rupees_paise: 0 },
    expenses: { count: 0, total_paise: 0 },
    closed: false,
    ...over,
  };
}

const done = (mine: any) => ({
  ...mine,
  attendance: { ...mine.attendance, done: true },
  sales: { done: true, rupees_paise: 4500000 },
});

describe("the daily round", () => {
  it("points at attendance first thing in the morning", () => {
    expect(nextStep(freshDay())).toBe(1);
  });

  it("moves to sales once the staff are marked in", () => {
    const mine = freshDay({ attendance: { done: true, total: 6, marked: 6, open: 0 } });
    expect(nextStep(mine)).toBe(2);
  });

  it("skips expenses, because a day with no spending is a normal day", () => {
    // Steps 1 and 2 done, expenses untouched: the next prompt must be
    // "close the day", not a nag to invent an expense.
    expect(nextStep(done(freshDay()))).toBe(4);
  });

  it("still skips expenses even when some were logged", () => {
    const mine = done(freshDay({ expenses: { count: 3, total_paise: 120000 } }));
    expect(nextStep(mine)).toBe(4);
  });

  it("goes quiet once the drawer is counted", () => {
    expect(nextStep(done(freshDay({ closed: true })))).toBeNull();
  });

  it("highlights exactly one step, never two", () => {
    const n = nextStep(freshDay());
    expect(steps(freshDay()).filter((s) => s.n === n)).toHaveLength(1);
  });

  it("keeps the round to the four jobs in the bottom bar", () => {
    expect(steps(freshDay()).map((s) => s.title)).toEqual([
      "Mark attendance", "Enter sales", "Log expenses", "Close the day",
    ]);
  });

  it("sends each step somewhere real", () => {
    for (const s of steps(freshDay())) expect(s.to).toMatch(/^\/[a-z]/);
  });
});
