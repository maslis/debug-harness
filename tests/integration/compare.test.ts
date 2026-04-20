import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { startFixtureServer, type FixtureServer } from "./helpers/fixture-server.ts";
import { compareRuns } from "../../src/compare.ts";

let browser: Browser;
let fixture: FixtureServer;

beforeAll(async () => {
  browser = await chromium.launch();
  fixture = await startFixtureServer();
});
afterAll(async () => {
  await browser.close();
  await fixture.close();
});

describe("compareRuns", () => {
  it("produces near-zero diff for the same URL vs itself", async () => {
    const result = await compareRuns(browser, {
      local: {
        url: fixture.url + "/baseline.html",
        actions: [{ op: "waitFor", selector: "h1" }],
        inspect: [],
        allowAds: false,
        blockHosts: [],
        settleMs: 100,
      },
      prod: { url: fixture.url + "/baseline.html" },
      viewport: { width: 800, height: 600 },
      diff: { threshold: 0.1, alpha: 0.3 },
    });
    expect(result.diff.diffPct).toBeLessThan(1);
    expect(result.local.summary.error).toBeUndefined();
    expect(result.prod.summary.error).toBeUndefined();
  });
});
