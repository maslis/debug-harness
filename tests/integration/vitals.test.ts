import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { startFixtureServer, type FixtureServer } from "./helpers/fixture-server.ts";
import { installVitals, readVitals } from "../../src/vitals.ts";

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

describe("installVitals / readVitals", () => {
  it("captures LCP and CLS on lcp-cls.html", async () => {
    const ctx = await browser.newContext();
    await installVitals(ctx);
    const page = await ctx.newPage();
    await page.goto(`${fixture.url}/lcp-cls.html`);
    await page.waitForTimeout(1000);
    const v = await readVitals(page);
    await ctx.close();
    expect(v.lcp).not.toBeNull();
    expect(v.lcp!.value).toBeGreaterThan(0);
    expect(v.cls).not.toBeNull();
  });
});
