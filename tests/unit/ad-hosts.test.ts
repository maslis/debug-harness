import { describe, expect, it } from "vitest";
import { DEFAULT_AD_HOSTS, isAdHost, buildAdHostMatcher } from "../../src/ad-hosts.ts";

describe("isAdHost", () => {
  it("matches exact host", () => {
    expect(isAdHost("doubleclick.net", DEFAULT_AD_HOSTS)).toBe(true);
  });

  it("matches subdomain", () => {
    expect(isAdHost("pagead2.googlesyndication.com", DEFAULT_AD_HOSTS)).toBe(true);
  });

  it("does not match localhost", () => {
    expect(isAdHost("localhost", DEFAULT_AD_HOSTS)).toBe(false);
    expect(isAdHost("host.docker.internal", DEFAULT_AD_HOSTS)).toBe(false);
  });

  it("does not match unrelated host", () => {
    expect(isAdHost("example.com", DEFAULT_AD_HOSTS)).toBe(false);
  });

  it("matches 'adsbygoogle' substring in host", () => {
    expect(isAdHost("tpc.adsbygoogle.com", DEFAULT_AD_HOSTS)).toBe(true);
  });
});

describe("buildAdHostMatcher (URL-based)", () => {
  it("matches full URL against ad host", () => {
    const match = buildAdHostMatcher(DEFAULT_AD_HOSTS);
    expect(match("https://pagead2.googlesyndication.com/pagead/js.js")).toBe(true);
    expect(match("https://example.com/ads.js")).toBe(false);
  });

  it("accepts extra hosts", () => {
    const match = buildAdHostMatcher([...DEFAULT_AD_HOSTS, "mycdn.example.com"]);
    expect(match("https://mycdn.example.com/script.js")).toBe(true);
  });

  it("returns false for non-URL strings", () => {
    const match = buildAdHostMatcher(DEFAULT_AD_HOSTS);
    expect(match("about:blank")).toBe(false);
  });
});
