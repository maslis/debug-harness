import { describe, expect, it } from "vitest";
import { startFixtureServer } from "./fixture-server.ts";

describe("startFixtureServer", () => {
  it("serves baseline.html at /", async () => {
    const s = await startFixtureServer();
    try {
      const body = await fetch(s.url).then((r) => r.text());
      expect(body).toContain("Baseline Page");
    } finally {
      await s.close();
    }
  });

  it("serves error.html at /error.html", async () => {
    const s = await startFixtureServer();
    try {
      const body = await fetch(`${s.url}/error.html`).then((r) => r.text());
      expect(body).toContain("Boom");
    } finally {
      await s.close();
    }
  });
});
