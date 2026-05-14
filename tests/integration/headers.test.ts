import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { audit } from "../../src/audit.ts";
import { capture } from "../../src/capture.ts";
import { compareRuns } from "../../src/compare.ts";

interface EchoServer {
  url: string;
  recordedHeaders: IncomingHttpHeaders[];
  close: () => Promise<void>;
}

async function startEchoServer(): Promise<EchoServer> {
  const recordedHeaders: IncomingHttpHeaders[] = [];
  const server: Server = createServer((req, res) => {
    recordedHeaders.push(req.headers);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<!doctype html><html><body><h1>echo</h1></body></html>");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("server address unavailable");
  return {
    url: `http://127.0.0.1:${addr.port}`,
    recordedHeaders,
    close: () =>
      new Promise<void>((res, rej) => server.close((err) => (err ? rej(err) : res()))),
  };
}

let browser: Browser;
let echo: EchoServer;

beforeAll(async () => {
  browser = await chromium.launch();
  echo = await startEchoServer();
});
afterAll(async () => {
  await browser.close();
  await echo.close();
});

describe("custom headers reach the network", () => {
  it("capture forwards req.headers as extraHTTPHeaders", async () => {
    const before = echo.recordedHeaders.length;
    await capture(browser, {
      url: echo.url + "/",
      viewport: { width: 800, height: 600 },
      actions: [],
      inspect: [],
      allowAds: false,
      blockHosts: [],
      settleMs: 0,
      headers: { setalarmclock: "local", "x-test": "yes" },
    });
    const seen = echo.recordedHeaders.slice(before);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]!["setalarmclock"]).toBe("local");
    expect(seen[0]!["x-test"]).toBe("yes");
  });

  it("capture behaves identically when headers is omitted (no regression)", async () => {
    const before = echo.recordedHeaders.length;
    await capture(browser, {
      url: echo.url + "/",
      actions: [],
      inspect: [],
      allowAds: false,
      blockHosts: [],
      settleMs: 0,
    });
    const seen = echo.recordedHeaders.slice(before);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]!["setalarmclock"]).toBeUndefined();
    expect(seen[0]!["x-test"]).toBeUndefined();
  });

  it("compare propagates top-level headers to BOTH local and prod captures", async () => {
    const before = echo.recordedHeaders.length;
    await compareRuns(browser, {
      local: {
        url: echo.url + "/",
        actions: [],
        inspect: [],
        allowAds: false,
        blockHosts: [],
        settleMs: 0,
      },
      prod: { url: echo.url + "/" },
      diff: { threshold: 0.1, alpha: 0.3 },
      headers: { "x-bypass": "shared" },
    });
    const seen = echo.recordedHeaders.slice(before);
    // compareRuns issues two captures → at least two top-level navigations.
    expect(seen.length).toBeGreaterThanOrEqual(2);
    for (const h of seen) expect(h["x-bypass"]).toBe("shared");
  });

  it("compare per-capture headers override the shared top-level on key overlap", async () => {
    const before = echo.recordedHeaders.length;
    await compareRuns(browser, {
      local: {
        url: echo.url + "/",
        actions: [],
        inspect: [],
        allowAds: false,
        blockHosts: [],
        settleMs: 0,
        headers: { "x-side": "local-wins" },
      },
      prod: {
        url: echo.url + "/",
        headers: { "x-side": "prod-wins" },
      },
      diff: { threshold: 0.1, alpha: 0.3 },
      headers: { "x-side": "shared", "x-shared-only": "yes" },
    });
    const seen = echo.recordedHeaders.slice(before);
    // The local capture runs first per compare.ts, then the prod capture.
    const xSideValues = seen.map((h) => h["x-side"]);
    expect(xSideValues).toContain("local-wins");
    expect(xSideValues).toContain("prod-wins");
    expect(xSideValues).not.toContain("shared");
    // Top-level keys not overridden still flow through.
    for (const h of seen) expect(h["x-shared-only"]).toBe("yes");
  });

  it("audit forwards req.headers as extraHTTPHeaders (no Lighthouse needed for assertion)", async () => {
    const before = echo.recordedHeaders.length;
    // Lighthouse may fail against a tiny echo server, but the context still
    // navigates with the configured headers, which is what we are asserting.
    await audit(
      browser,
      {
        url: echo.url + "/",
        actions: [],
        allowAds: false,
        blockHosts: [],
        settleMs: 0,
        categories: ["performance"],
        thresholds: {},
        preset: "desktop",
        headers: { "x-audit": "1" },
      },
      0,
    ).catch(() => undefined);
    const seen = echo.recordedHeaders.slice(before);
    expect(seen.some((h) => h["x-audit"] === "1")).toBe(true);
  });
});
