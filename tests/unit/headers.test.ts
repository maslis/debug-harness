import { describe, expect, it } from "vitest";
import { collectHeaders, HeaderParseError, parseHeaderArg } from "../../src/headers.ts";

describe("parseHeaderArg", () => {
  it("splits a simple Name: Value pair", () => {
    expect(parseHeaderArg("setalarmclock: local")).toEqual(["setalarmclock", "local"]);
  });

  it("trims surrounding whitespace on name and value", () => {
    expect(parseHeaderArg("  X-Foo  :   bar baz  ")).toEqual(["X-Foo", "bar baz"]);
  });

  it("splits only on the first colon (values may contain ':')", () => {
    expect(parseHeaderArg("Authorization: Bearer abc:def:ghi")).toEqual([
      "Authorization",
      "Bearer abc:def:ghi",
    ]);
  });

  it("allows empty value", () => {
    expect(parseHeaderArg("X-Empty:")).toEqual(["X-Empty", ""]);
    expect(parseHeaderArg("X-Empty: ")).toEqual(["X-Empty", ""]);
  });

  it("rejects input without a colon", () => {
    expect(() => parseHeaderArg("nocolon")).toThrowError(HeaderParseError);
  });

  it("rejects empty name", () => {
    expect(() => parseHeaderArg(": value")).toThrowError(HeaderParseError);
    expect(() => parseHeaderArg("   : value")).toThrowError(HeaderParseError);
  });

  it("preserves the original input on the error for diagnostics", () => {
    try {
      parseHeaderArg("nocolon");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(HeaderParseError);
      expect((err as HeaderParseError).input).toBe("nocolon");
    }
  });
});

describe("collectHeaders", () => {
  it("combines multiple --header flags into one map", () => {
    expect(collectHeaders(["a: 1", "b: 2", "c: 3"])).toEqual({ a: "1", b: "2", c: "3" });
  });

  it("last occurrence wins on duplicate names (curl-compatible)", () => {
    expect(collectHeaders(["X: one", "X: two"])).toEqual({ X: "two" });
  });

  it("returns an empty object for no inputs", () => {
    expect(collectHeaders([])).toEqual({});
  });

  it("propagates parse errors from any element", () => {
    expect(() => collectHeaders(["valid: 1", "bad-no-colon"])).toThrowError(HeaderParseError);
  });
});
