import type { BrowserContext, Page } from "playwright";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const VITALS_IIFE_PATH = resolve(process.cwd(), "vendor/web-vitals.iife.js");

// The IIFE assigns to `var webVitals` which in Playwright's addInitScript wrapper
// runs in a function scope, so `var` does NOT reach `window`. We read the file and
// replace the leading `var webVitals=` with `window.webVitals=` to force the global.
function buildVitalsScript(): string {
  const raw = readFileSync(VITALS_IIFE_PATH, "utf8");
  return raw.replace(/^var webVitals=/, "window.webVitals=");
}

const SHIM = `
(() => {
  const v = { lcp: null, cls: null, fcp: null, ttfb: null, inp: null };
  const wv = window.webVitals;
  if (!wv) { window.__vitals = v; return; }
  wv.onLCP((m) => { v.lcp = { value: m.value, rating: m.rating, element: m.entries[m.entries.length-1]?.element?.tagName ?? null }; }, { reportAllChanges: true });
  wv.onCLS((m) => { v.cls = { value: m.value, rating: m.rating, entries: m.entries.length }; }, { reportAllChanges: true });
  wv.onFCP((m) => { v.fcp = { value: m.value, rating: m.rating }; });
  wv.onTTFB((m) => { v.ttfb = { value: m.value, rating: m.rating }; });
  wv.onINP((m) => { v.inp = { value: m.value, rating: m.rating, target: m.entries[0]?.target?.tagName ?? null, synthetic: true }; }, { reportAllChanges: true });
  window.__vitals = v;
})();
`;

export interface VitalsSnapshot {
  lcp: { value: number; rating: string; element: string | null } | null;
  cls: { value: number; rating: string; entries: number } | null;
  fcp: { value: number; rating: string } | null;
  ttfb: { value: number; rating: string } | null;
  inp: { value: number; rating: string; target: string | null; synthetic: boolean } | null;
}

export async function installVitals(context: BrowserContext): Promise<void> {
  await context.addInitScript({ content: buildVitalsScript() });
  await context.addInitScript({ content: SHIM });
}

export async function readVitals(page: Page): Promise<VitalsSnapshot> {
  return (await page.evaluate(() => (window as unknown as { __vitals: VitalsSnapshot }).__vitals)) ?? {
    lcp: null, cls: null, fcp: null, ttfb: null, inp: null,
  };
}
