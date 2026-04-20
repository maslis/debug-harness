import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { capture } from "../../src/capture.ts";

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser.close(); });

describe("capture vs public URL (smoke)", () => {
  it("captures example.com", async () => {
    const r = await capture(browser, {
      url: "https://example.com/",
      viewport: { width: 1024, height: 768 },
      actions: [{ op: "waitFor", selector: "h1" }],
      inspect: ["h1"],
      allowAds: false, blockHosts: [], settleMs: 200,
    });
    expect(r.summary.statusCode).toBe(200);
    expect(r.summary.title.toLowerCase()).toContain("example");
  }, 60_000);
});
