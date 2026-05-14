import { describe, expect, it } from "vitest";
import {
  ActionSchema,
  AuditRequestSchema,
  CaptureRequestSchema,
  CompareRequestSchema,
} from "../../src/types.ts";

describe("ActionSchema", () => {
  it("accepts a valid waitFor action", () => {
    expect(() => ActionSchema.parse({ op: "waitFor", selector: "main" })).not.toThrow();
  });

  it("rejects unknown op", () => {
    expect(() => ActionSchema.parse({ op: "bogus" })).toThrow();
  });

  it("accepts a valid click action with all options", () => {
    expect(() =>
      ActionSchema.parse({
        op: "click",
        selector: "button",
        button: "left",
        clickCount: 1,
        timeout: 5000,
      }),
    ).not.toThrow();
  });

  it("requires selector on click", () => {
    expect(() => ActionSchema.parse({ op: "click" })).toThrow();
  });
});

describe("CaptureRequestSchema", () => {
  it("accepts minimal request (url only)", () => {
    const parsed = CaptureRequestSchema.parse({ url: "http://localhost:4322/" });
    expect(parsed.allowAds).toBe(false);
    expect(parsed.settleMs).toBe(500);
    expect(parsed.actions).toEqual([]);
  });

  it("rejects non-URL string", () => {
    expect(() => CaptureRequestSchema.parse({ url: "not-a-url" })).toThrow();
  });

  it("accepts device emulation", () => {
    const parsed = CaptureRequestSchema.parse({
      url: "http://localhost:4322/",
      device: "iPhone 13",
    });
    expect(parsed.device).toBe("iPhone 13");
  });

  it("accepts optional headers map", () => {
    const parsed = CaptureRequestSchema.parse({
      url: "http://localhost:4322/",
      headers: { "x-test": "1", "x-other": "two" },
    });
    expect(parsed.headers).toEqual({ "x-test": "1", "x-other": "two" });
  });

  it("leaves headers undefined when omitted (backwards compat)", () => {
    const parsed = CaptureRequestSchema.parse({ url: "http://localhost:4322/" });
    expect(parsed.headers).toBeUndefined();
  });

  it("rejects empty-string header name", () => {
    expect(() =>
      CaptureRequestSchema.parse({
        url: "http://localhost:4322/",
        headers: { "": "value" },
      }),
    ).toThrow();
  });
});

describe("CompareRequestSchema headers", () => {
  it("accepts top-level headers applied to both sub-requests", () => {
    const parsed = CompareRequestSchema.parse({
      local: { url: "http://localhost:4322/" },
      prod: { url: "https://example.com/" },
      headers: { "x-bypass": "yes" },
    });
    expect(parsed.headers).toEqual({ "x-bypass": "yes" });
  });
});

describe("AuditRequestSchema headers", () => {
  it("accepts optional headers map", () => {
    const parsed = AuditRequestSchema.parse({
      url: "https://example.com/",
      headers: { "x-bypass": "1" },
    });
    expect(parsed.headers).toEqual({ "x-bypass": "1" });
  });
});
