import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { startFixtureServer, type FixtureServer } from "./helpers/fixture-server.ts";
import { DEFAULT_AD_HOSTS } from "../../src/ad-hosts.ts";
import {
  attachNetworkLogger,
  createSafetyState,
  installRouteBlocker,
} from "../../src/safety.ts";

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

describe("installRouteBlocker", () => {
  it("blocks requests to ad hosts", async () => {
    const ctx = await browser.newContext();
    const state = createSafetyState();
    await installRouteBlocker(ctx, state, { blocklist: DEFAULT_AD_HOSTS, allowAds: false });
    const page = await ctx.newPage();
    attachNetworkLogger(page, state);

    await page.goto(fixture.url);
    await page.evaluate(() =>
      fetch("https://pagead2.googlesyndication.com/pagead/js.js").catch(() => {}),
    );
    await page.waitForTimeout(200);
    await ctx.close();

    expect(state.blockedAdRequests).toBeGreaterThan(0);
    expect(state.net.some((e) => e.blocked === "ads")).toBe(true);
  });

  it("does not block when allowAds=true", async () => {
    const ctx = await browser.newContext();
    const state = createSafetyState();
    await installRouteBlocker(ctx, state, { blocklist: DEFAULT_AD_HOSTS, allowAds: true });
    const page = await ctx.newPage();

    await page.goto(fixture.url);
    await ctx.close();

    expect(state.blockedAdRequests).toBe(0);
  });
});
