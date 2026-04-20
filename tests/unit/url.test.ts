import { describe, expect, it } from "vitest";
import { rewriteLocalhost } from "../../src/url.ts";

describe("rewriteLocalhost", () => {
  it("rewrites localhost to host.docker.internal", () => {
    expect(rewriteLocalhost("http://localhost:4322/path?q=1#frag")).toBe(
      "http://host.docker.internal:4322/path?q=1#frag",
    );
  });

  it("rewrites 127.0.0.1", () => {
    expect(rewriteLocalhost("http://127.0.0.1:3000/")).toBe(
      "http://host.docker.internal:3000/",
    );
  });

  it("rewrites [::1]", () => {
    expect(rewriteLocalhost("http://[::1]:3000/")).toBe(
      "http://host.docker.internal:3000/",
    );
  });

  it("leaves public URLs untouched", () => {
    expect(rewriteLocalhost("https://example.com/")).toBe("https://example.com/");
  });

  it("preserves https scheme", () => {
    expect(rewriteLocalhost("https://localhost:8443/secure")).toBe(
      "https://host.docker.internal:8443/secure",
    );
  });

  it("leaves invalid URL strings untouched (caller validates)", () => {
    expect(rewriteLocalhost("not a url")).toBe("not a url");
  });
});
