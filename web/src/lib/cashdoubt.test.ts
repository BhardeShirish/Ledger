import { describe, expect, it } from "vitest";

import { explainedBySplit } from "./cashdoubt";

describe("a surplus explained by part-paid bills", () => {
  it("explains a surplus inside the unknown amount", () => {
    expect(explainedBySplit(30_000, 50_000)).toBe(true);
  });

  it("explains a surplus exactly equal to the unknown amount", () => {
    expect(explainedBySplit(50_000, 50_000)).toBe(true);
  });

  it("stops explaining once the surplus exceeds what could have been cash", () => {
    expect(explainedBySplit(50_001, 50_000)).toBe(false);
  });

  it("never explains a shortage — that money should have been there", () => {
    expect(explainedBySplit(-30_000, 50_000)).toBe(false);
  });

  it("never explains a shortage larger than the unknown either", () => {
    expect(explainedBySplit(-80_000, 50_000)).toBe(false);
  });

  it("explains nothing on a day with no part-paid bills", () => {
    expect(explainedBySplit(30_000, 0)).toBe(false);
  });

  it("treats an exact count as an exact count, not as doubt", () => {
    expect(explainedBySplit(0, 50_000)).toBe(false);
  });

  it("is not fooled by a negative unknown", () => {
    expect(explainedBySplit(30_000, -50_000)).toBe(false);
  });
});
