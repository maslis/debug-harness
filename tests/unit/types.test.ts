import { describe, expect, it } from "vitest";
import { CaptureRequestSchema, ActionSchema } from "../../src/types.ts";

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
});
