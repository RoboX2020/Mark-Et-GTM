import { describe, expect, it } from "vitest";
import { Budget, BudgetError, PRICES } from "./budget.js";

describe("Budget", () => {
  it("reserves and settles to actual cost", () => {
    const b = new Budget(1);
    const r = b.reserve(0.4);
    expect(b.remaining).toBeCloseTo(0.6);
    b.settle(r, 0.1, { input_tokens: 100, output_tokens: 50 });
    expect(b.committed).toBeCloseTo(0.1);
    expect(b.calls).toBe(1);
    expect(b.inTok).toBe(100);
  });

  it("refuses a reservation that would pass the cap", () => {
    const b = new Budget(0.5);
    b.reserve(0.4);
    expect(() => b.reserve(0.2)).toThrow(BudgetError);
    expect(b.committed).toBeCloseTo(0.4);
  });

  it("keeps unresolved reservations so unknown costs cannot walk past the cap", () => {
    const b = new Budget(1);
    const r = b.reserve(0.6);
    b.keepUnresolved(r);
    expect(b.committed).toBeCloseTo(0.6);
    expect(b.unresolved).toBe(1);
    expect(() => b.reserve(0.5)).toThrow(BudgetError);
  });

  it("release is the only way a reservation comes back", () => {
    const b = new Budget(1);
    const r = b.reserve(0.6);
    b.release(r);
    expect(b.committed).toBeCloseTo(0);
  });

  it("restores committed spend from a prior process", () => {
    const b = new Budget(5, 3.25);
    expect(b.remaining).toBeCloseTo(1.75);
  });

  it("notifies onChange after every mutation", () => {
    const seen: number[] = [];
    const b = new Budget(1);
    b.onChange = (c) => seen.push(c);
    const r = b.reserve(0.4);
    b.settle(r, 0.1);
    expect(seen.length).toBe(2);
    expect(seen[0]).toBeCloseTo(0.4);
    expect(seen[1]).toBeCloseTo(0.1);
  });

  it("haiku price constant matches the documented tier boundary", () => {
    expect(PRICES["claude-haiku-5-5"]).toEqual({ in: 0.1 / 1e6, out: 0.5 / 1e6 });
  });
});
