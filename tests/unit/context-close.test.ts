import { describe, expect, it, vi } from "vitest";
import type { Browser } from "playwright";
import { capture } from "../../src/capture.ts";
import { audit } from "../../src/audit.ts";
import { CaptureRequestSchema, AuditRequestSchema } from "../../src/types.ts";

// A context whose newPage() throws outside any of the harness's own try/catch
// blocks, standing in for any late failure (artifact write, summary build).
function fakeBrowser() {
  const close = vi.fn(async () => {});
  const context = {
    route: async () => {},
    addInitScript: async () => {},
    newPage: async () => { throw new Error("boom"); },
    close,
  };
  const browser = { newContext: async () => context } as unknown as Browser;
  return { browser, close };
}

describe("context cleanup", () => {
  it("capture closes the context when the body throws", async () => {
    const { browser, close } = fakeBrowser();
    const req = CaptureRequestSchema.parse({ url: "http://localhost:1/" });
    await expect(capture(browser, req)).rejects.toThrow("boom");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("audit closes the context when the body throws", async () => {
    const { browser, close } = fakeBrowser();
    const req = AuditRequestSchema.parse({ url: "http://localhost:1/" });
    await expect(audit(browser, req, 9222)).rejects.toThrow("boom");
    expect(close).toHaveBeenCalledTimes(1);
  });
});
