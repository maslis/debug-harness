import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { startFixtureServer, type FixtureServer } from "./helpers/fixture-server.ts";
import { runActions } from "../../src/actions.ts";
import { createSafetyState } from "../../src/safety.ts";
import { DEFAULT_AD_HOSTS } from "../../src/ad-hosts.ts";

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

async function setup() {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(fixture.url);
  return {
    context,
    page,
    state: createSafetyState(),
  };
}

describe("runActions", () => {
  it("runs waitFor + click + assertion via evaluate", async () => {
    const { context, page, state } = await setup();
    const fail = await runActions(
      [
        { op: "waitFor", selector: "#greet" },
        { op: "click", selector: "#greet" },
        { op: "waitFor", selector: "#greeting" },
      ],
      {
        page,
        context,
        blocklist: DEFAULT_AD_HOSTS,
        extraGuardSelectors: [],
        state,
        evaluations: {},
        defaultTimeout: 5000,
      },
    );
    expect(fail).toBeNull();
    const visible = await page.locator("#greeting").isVisible();
    expect(visible).toBe(true);
    await context.close();
  });

  it("returns action_failed on selector timeout", async () => {
    const { context, page, state } = await setup();
    const fail = await runActions(
      [{ op: "waitFor", selector: "#does-not-exist", timeout: 500 }],
      {
        page,
        context,
        blocklist: DEFAULT_AD_HOSTS,
        extraGuardSelectors: [],
        state,
        evaluations: {},
        defaultTimeout: 5000,
      },
    );
    expect(fail?.kind).toBe("action_failed");
    expect(fail?.actionIndex).toBe(0);
    await context.close();
  });

  it("returns click_guard_blocked on ad-iframe click", async () => {
    const { context, page, state } = await setup();
    await page.goto(`${fixture.url}/ad-iframe.html`);
    const fail = await runActions(
      [{ op: "click", selector: "ins.adsbygoogle" }],
      {
        page,
        context,
        blocklist: DEFAULT_AD_HOSTS,
        extraGuardSelectors: [],
        state,
        evaluations: {},
        defaultTimeout: 5000,
      },
    );
    expect(fail?.kind).toBe("click_guard_blocked");
    expect(state.clickGuardBlocks).toBe(1);
    await context.close();
  });
});
