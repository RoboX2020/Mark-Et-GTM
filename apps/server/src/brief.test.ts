import { describe, expect, it } from "vitest";
import { buildBrief, estimateRunCostUsd, InputError } from "./brief.js";

describe("buildBrief", () => {
  it("builds a brief from just an idea", () => {
    const b = buildBrief({ idea: "An app that walks your dog" });
    expect(b.product.name).toBe("Untitled product");
    expect(b.product.description).toBe("An app that walks your dog");
    expect(b.price.model).toBe("freemium");
    expect(b.population).toBe(120);
    expect(b.launchDate > new Date().toISOString().slice(0, 10)).toBe(true);
  });

  it("requires the idea", () => {
    expect(() => buildBrief({})).toThrow(InputError);
    expect(() => buildBrief("nope")).toThrow(InputError);
    expect(() => buildBrief({ idea: "  " })).toThrow(InputError);
  });

  it("enforces field limits", () => {
    expect(() => buildBrief({ idea: "x".repeat(801) })).toThrow(/idea/);
    expect(() => buildBrief({ idea: "ok", name: "n".repeat(121) })).toThrow(/name/);
    expect(() => buildBrief({ idea: "ok", price: 100_001 })).toThrow(/price/);
    expect(() => buildBrief({ idea: "ok", price: -1 })).toThrow(/price/);
    expect(() => buildBrief({ idea: "ok", population: 301 })).toThrow(/population/);
    expect(() => buildBrief({ idea: "ok", population: 39 })).toThrow(/population/);
    expect(() => buildBrief({ idea: "ok", population: 120.5 })).toThrow(/population/);
    expect(() => buildBrief({ idea: "ok", competitors: "not-array" })).toThrow(/competitors/);
    expect(() => buildBrief({ idea: "ok", competitors: Array(9).fill("a") })).toThrow(/competitors/);
  });

  it("accepts a fully specified input", () => {
    const b = buildBrief({
      name: "Acme",
      idea: "Meal kits for night-shift nurses",
      category: "food delivery",
      price: 12,
      market: "night-shift nurses",
      competitors: ["Factor", "HelloFresh"],
      population: 300,
    });
    expect(b.product.name).toBe("Acme");
    expect(b.price).toEqual({ amount: 12, currency: "USD", model: "subscription_monthly" });
    expect(b.competitors).toEqual(["Factor", "HelloFresh"]);
    expect(b.population).toBe(300);
  });
});

describe("estimateRunCostUsd", () => {
  it("stays under the $1 per-run cap at the default population", () => {
    const b = buildBrief({ idea: "test" });
    const est = estimateRunCostUsd(b, "claude-haiku-5-5");
    expect(est).toBeGreaterThan(0.05);
    expect(est).toBeLessThan(1);
  });

  it("stays under the $1 per-run cap at the maximum population", () => {
    const b = buildBrief({ idea: "test", population: 300 });
    const est = estimateRunCostUsd(b, "claude-haiku-5-5");
    expect(est).toBeLessThan(1);
  });

  it("scales with population", () => {
    const small = estimateRunCostUsd(buildBrief({ idea: "t", population: 40 }), "claude-haiku-5-5");
    const big = estimateRunCostUsd(buildBrief({ idea: "t", population: 300 }), "claude-haiku-5-5");
    expect(big).toBeGreaterThan(small);
  });

  it("refuses models without a verified price", () => {
    expect(() => estimateRunCostUsd(buildBrief({ idea: "t" }), "claude-opus-5-5")).toThrow(/no verified price/);
  });
});
