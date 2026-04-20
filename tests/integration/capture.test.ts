import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { startFixtureServer, type FixtureServer } from "./helpers/fixture-server.ts";
import { capture } from "../../src/capture.ts";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

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

describe("capture", () => {
  it("captures all artifacts for baseline page", async () => {
    const result = await capture(browser, {
      url: fixture.url + "/baseline.html",
      viewport: { width: 800, height: 600 },
      device: null,
      actions: [{ op: "waitFor", selector: "h1" }],
      inspect: ["h1"],
      allowAds: false,
      blockHosts: [],
      settleMs: 100,
    });
    expect(result.summary.statusCode).toBe(200);
    expect(result.summary.title).toBe("Baseline");
    expect(result.summary.actionsRun).toBe(1);
    expect(result.summary.error).toBeUndefined();

    const dir = resolve(process.cwd(), result.artifactDir);
    for (const f of Object.values(result.files)) {
      const s = await stat(join(dir, f));
      expect(s.size).toBeGreaterThan(0);
    }
    const dom = await readFile(join(dir, result.files.dom!), "utf8");
    expect(dom).toContain("Baseline Page");
  });

  it("emits 422-shaped error when selector times out", async () => {
    const result = await capture(browser, {
      url: fixture.url + "/baseline.html",
      actions: [{ op: "waitFor", selector: "#nope", timeout: 200 }],
      inspect: [],
      allowAds: false,
      blockHosts: [],
      settleMs: 0,
    });
    expect(result.summary.error?.kind).toBe("action_failed");
    expect(result.summary.error?.actionIndex).toBe(0);
  });
});
