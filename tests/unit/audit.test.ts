import { describe, expect, it } from "vitest";
import { AuditRequestSchema } from "../../src/types.ts";
import { buildSummary } from "../../src/audit.ts";

const fixtureLhr = {
  finalUrl: "http://localhost:4321/",
  fetchTime: "2026-05-12T10:00:00.000Z",
  categories: {
    performance: {
      id: "performance",
      score: 0.72,
      auditRefs: [
        { id: "largest-contentful-paint" },
        { id: "render-blocking-resources" },
        { id: "uses-text-compression" },
      ],
    },
    accessibility: {
      id: "accessibility",
      score: 0.95,
      auditRefs: [{ id: "color-contrast" }],
    },
    "best-practices": { id: "best-practices", score: 1.0, auditRefs: [] },
    seo: { id: "seo", score: 0.85, auditRefs: [{ id: "meta-description" }] },
  },
  audits: {
    "largest-contentful-paint": {
      id: "largest-contentful-paint",
      title: "Largest Contentful Paint",
      score: 0.5,
      scoreDisplayMode: "numeric",
      numericValue: 3200,
      displayValue: "3.2 s",
    },
    "cumulative-layout-shift": { numericValue: 0.04 },
    "first-contentful-paint": { numericValue: 1800 },
    "server-response-time": { numericValue: 250 },
    "total-blocking-time": { numericValue: 480 },
    "speed-index": { numericValue: 4100 },
    "render-blocking-resources": {
      id: "render-blocking-resources",
      title: "Eliminate render-blocking resources",
      description: "Resources are blocking the first paint of your page.",
      score: 0.4,
      scoreDisplayMode: "numeric",
      displayValue: "Potential savings of 850 ms",
      details: { type: "opportunity", overallSavingsMs: 850, overallSavingsBytes: 0 },
    },
    "uses-text-compression": {
      id: "uses-text-compression",
      title: "Enable text compression",
      description: "Text-based resources should be served with compression.",
      score: 0.3,
      scoreDisplayMode: "numeric",
      displayValue: "Potential savings of 320 KB",
      details: { type: "opportunity", overallSavingsMs: 200, overallSavingsBytes: 320_000 },
    },
    "color-contrast": {
      id: "color-contrast",
      title: "Background and foreground colors have sufficient contrast ratio",
      score: 0.5,
      scoreDisplayMode: "binary",
    },
    "meta-description": {
      id: "meta-description",
      title: "Document has a meta description",
      score: 0,
      scoreDisplayMode: "binary",
    },
  },
};

describe("AuditRequestSchema", () => {
  it("accepts minimal request (url only) with sensible defaults", () => {
    const parsed = AuditRequestSchema.parse({ url: "http://localhost:4321/" });
    expect(parsed.categories).toEqual(["performance", "accessibility", "best-practices", "seo"]);
    expect(parsed.preset).toBe("desktop");
    expect(parsed.thresholds).toEqual({});
  });

  it("accepts custom categories + thresholds", () => {
    const parsed = AuditRequestSchema.parse({
      url: "http://localhost:4321/",
      categories: ["performance", "accessibility"],
      thresholds: { performance: 90 },
      preset: "mobile",
    });
    expect(parsed.categories).toEqual(["performance", "accessibility"]);
    expect(parsed.thresholds.performance).toBe(90);
    expect(parsed.preset).toBe("mobile");
  });

  it("rejects threshold > 100", () => {
    expect(() =>
      AuditRequestSchema.parse({ url: "http://localhost:4321/", thresholds: { performance: 101 } }),
    ).toThrow();
  });
});

describe("buildSummary", () => {
  it("extracts scores rounded to 0–100", () => {
    const s = buildSummary({
      lhr: fixtureLhr, target: "http://localhost:4321/", pageUrl: "http://localhost:4321/",
      thresholds: {}, fail: null, lighthouseError: null,
    });
    expect(s.scores.performance).toBe(72);
    expect(s.scores.accessibility).toBe(95);
    expect(s.scores["best-practices"]).toBe(100);
    expect(s.scores.seo).toBe(85);
  });

  it("extracts CWV from numericValue", () => {
    const s = buildSummary({
      lhr: fixtureLhr, target: "x", pageUrl: "x", thresholds: {}, fail: null, lighthouseError: null,
    });
    expect(s.cwv.lcpMs).toBe(3200);
    expect(s.cwv.cls).toBe(0.04);
    expect(s.cwv.tbtMs).toBe(480);
    expect(s.cwv.speedIndex).toBe(4100);
  });

  it("returns top opportunities sorted by wastedMs desc", () => {
    const s = buildSummary({
      lhr: fixtureLhr, target: "x", pageUrl: "x", thresholds: {}, fail: null, lighthouseError: null,
    });
    expect(s.opportunities).toHaveLength(2);
    expect(s.opportunities[0]!.id).toBe("render-blocking-resources");
    expect(s.opportunities[0]!.wastedMs).toBe(850);
    expect(s.opportunities[1]!.id).toBe("uses-text-compression");
  });

  it("collects failed audits across categories", () => {
    const s = buildSummary({
      lhr: fixtureLhr, target: "x", pageUrl: "x", thresholds: {}, fail: null, lighthouseError: null,
    });
    const ids = s.failedAudits.map((a) => a.id);
    expect(ids).toContain("color-contrast");
    expect(ids).toContain("meta-description");
    expect(ids).toContain("render-blocking-resources");
  });

  it("flags threshold failures", () => {
    const s = buildSummary({
      lhr: fixtureLhr, target: "x", pageUrl: "x",
      thresholds: { performance: 90, accessibility: 90 },
      fail: null, lighthouseError: null,
    });
    expect(s.thresholdFailures).toEqual([{ category: "performance", score: 72, min: 90 }]);
  });

  it("returns error summary on action failure", () => {
    const s = buildSummary({
      lhr: null, target: "x", pageUrl: "x", thresholds: {},
      fail: { kind: "action_failed", actionIndex: 0, op: "click", reason: "timeout" },
      lighthouseError: null,
    });
    expect(s.error?.kind).toBe("action_failed");
    expect(s.scores.performance).toBeNull();
  });

  it("returns error summary on lighthouse failure", () => {
    const s = buildSummary({
      lhr: null, target: "x", pageUrl: "x", thresholds: {},
      fail: null, lighthouseError: { reason: "CDP connection refused" },
    });
    expect(s.error?.kind).toBe("lighthouse_failed");
    expect(s.error?.reason).toContain("CDP");
  });
});
