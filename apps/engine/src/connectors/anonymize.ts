import type { Brief, EvidenceItem } from "@market/core";

/**
 * Replaces a real product's name, domain and known aliases with a neutral
 * alias so the model can't lean on what it already knows about the product.
 */
export class Anonymizer {
  private patterns: RegExp[];
  constructor(private terms: string[], readonly alias: string) {
    const uniq = [...new Set(terms.filter((t) => t.trim().length >= 2))].sort((a, b) => b.length - a.length);
    this.patterns = uniq.map((t) => new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"));
  }
  text(s: string): string {
    return this.patterns.reduce((acc, re) => acc.replace(re, this.alias), s);
  }
  evidence(e: EvidenceItem): EvidenceItem {
    return { ...e, title: e.title ? this.text(e.title) : undefined, text: this.text(e.text), url: e.url ? this.text(e.url) : undefined };
  }
  brief(b: Brief): Brief {
    return {
      ...b,
      product: { ...b.product, name: this.alias, description: this.text(b.product.description), url: undefined },
      targetMarket: this.text(b.targetMarket),
    };
  }
  /** Returns the terms still present in a model output: a leakage signal. */
  leaks(s: string): string[] {
    return this.terms.filter((t) => new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(s));
  }
}
