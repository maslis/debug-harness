import type { BrowserContext, Page, Route } from "playwright";
import { buildAdHostMatcher } from "./ad-hosts.ts";

export interface NetEvent {
  method: string;
  url: string;
  status: number | null;
  type: string;
  fromCache: boolean;
  durationMs: number;
  blocked: "ads" | false;
}

export interface SafetyState {
  net: NetEvent[];
  blockedAdRequests: number;
  clickGuardBlocks: number;
}

export interface InstallSafetyOptions {
  blocklist: readonly string[];
  allowAds: boolean;
}

export function createSafetyState(): SafetyState {
  return { net: [], blockedAdRequests: 0, clickGuardBlocks: 0 };
}

export async function installRouteBlocker(
  context: BrowserContext,
  state: SafetyState,
  opts: InstallSafetyOptions,
): Promise<void> {
  const isAd = buildAdHostMatcher(opts.blocklist);
  await context.route("**/*", async (route: Route) => {
    const url = route.request().url();
    if (!opts.allowAds && isAd(url)) {
      state.blockedAdRequests++;
      state.net.push({
        method: route.request().method(),
        url,
        status: null,
        type: route.request().resourceType(),
        fromCache: false,
        durationMs: 0,
        blocked: "ads",
      });
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
}

export function attachNetworkLogger(page: Page, state: SafetyState): void {
  const starts = new Map<string, number>();
  page.on("request", (req) => {
    starts.set(req.url() + "|" + req.method(), Date.now());
  });
  page.on("response", async (res) => {
    const req = res.request();
    const key = req.url() + "|" + req.method();
    const dur = Date.now() - (starts.get(key) ?? Date.now());
    starts.delete(key);
    state.net.push({
      method: req.method(),
      url: req.url(),
      status: res.status(),
      type: req.resourceType(),
      fromCache: res.fromServiceWorker() === false && res.status() === 304,
      durationMs: dur,
      blocked: false,
    });
  });
  page.on("requestfailed", (req) => {
    const key = req.url() + "|" + req.method();
    const dur = Date.now() - (starts.get(key) ?? Date.now());
    starts.delete(key);
    state.net.push({
      method: req.method(),
      url: req.url(),
      status: null,
      type: req.resourceType(),
      fromCache: false,
      durationMs: dur,
      blocked: false,
    });
  });
}
