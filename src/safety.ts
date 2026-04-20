import type { BrowserContext, Frame, Locator, Page, Route } from "playwright";
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

export interface ClickGuardBlock {
  kind: "click_guard_blocked";
  selector: string;
  reason: string;
  ancestorMatched: string | null;
}

const AD_ID_RE = /^(google_ads_|gpt-ad|aswift_|div-gpt-ad)/;

export async function preClickGuard(
  page: Page,
  locator: Locator,
  blocklist: readonly string[],
  extraSelectors: readonly string[] = [],
): Promise<ClickGuardBlock | null> {
  const frame: Frame | null = await locator
    .elementHandle()
    .then((h) => h?.ownerFrame() ?? null)
    .catch(() => null);
  if (!frame) return { kind: "click_guard_blocked", selector: "", reason: "element not found", ancestorMatched: null };

  const frameUrl = frame.url();
  try {
    const fu = new URL(frameUrl);
    if (blocklist.some((p) => fu.hostname.toLowerCase().includes(p.toLowerCase()))) {
      return {
        kind: "click_guard_blocked",
        selector: "",
        reason: "element lives inside ad-host iframe",
        ancestorMatched: `iframe[src*=${fu.hostname}]`,
      };
    }
  } catch {
    // frameUrl may be about:blank — continue to DOM check
  }

  const result = await locator.evaluate(
    (el, args: { hosts: string[]; extraSelectors: string[]; adIdPattern: string }) => {
      const { hosts, extraSelectors, adIdPattern } = args;
      const re = new RegExp(adIdPattern);
      let node: Element | null = el;
      while (node) {
        const id = node.id ?? "";
        if (id && re.test(id)) return { matched: `#${id}` };
        if (node.classList.contains("adsbygoogle")) return { matched: ".adsbygoogle" };
        if (node.tagName === "INS" && node.classList.contains("adsbygoogle"))
          return { matched: "ins.adsbygoogle" };
        if (node.tagName === "IFRAME") {
          const src = (node as HTMLIFrameElement).src ?? "";
          if (hosts.some((h) => src.toLowerCase().includes(h.toLowerCase())))
            return { matched: `iframe[src*=${src}]` };
        }
        for (const sel of extraSelectors) {
          if (node.matches(sel)) return { matched: sel };
        }
        node = node.parentElement ?? ((node.getRootNode() as ShadowRoot).host ?? null);
      }
      return { matched: null };
    },
    { hosts: [...blocklist], extraSelectors: [...extraSelectors], adIdPattern: AD_ID_RE.source },
  );

  if (result.matched) {
    return {
      kind: "click_guard_blocked",
      selector: "",
      reason: "ancestor matched ad selector",
      ancestorMatched: result.matched,
    };
  }
  return null;
}

export async function highlightElement(page: Page, locator: Locator): Promise<void> {
  await locator
    .evaluate((el) => {
      (el as HTMLElement).style.outline = "3px solid red";
      (el as HTMLElement).style.outlineOffset = "2px";
    })
    .catch(() => {});
}
