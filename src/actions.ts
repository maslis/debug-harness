import type { BrowserContext, Page } from "playwright";
import { devices } from "playwright";
import type { Action } from "./types.ts";
import { preClickGuard, highlightElement, type SafetyState } from "./safety.ts";

export interface ActionRunContext {
  page: Page;
  context: BrowserContext;
  blocklist: readonly string[];
  extraGuardSelectors: readonly string[];
  state: SafetyState;
  evaluations: Record<string, unknown>;
  defaultTimeout: number;
}

export interface ActionFailure {
  kind: "action_failed" | "click_guard_blocked";
  actionIndex: number;
  op: string;
  reason: string;
  detail?: unknown;
}

export async function runActions(
  actions: readonly Action[],
  ctx: ActionRunContext,
): Promise<ActionFailure | null> {
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i]!;
    try {
      await runOne(a, ctx);
    } catch (err) {
      if (err && typeof err === "object" && (err as { kind?: string }).kind === "click_guard_blocked") {
        ctx.state.clickGuardBlocks++;
        return { ...(err as Omit<ActionFailure, "actionIndex">), actionIndex: i };
      }
      return {
        kind: "action_failed",
        actionIndex: i,
        op: a.op,
        reason: (err as Error).message,
      };
    }
  }
  return null;
}

async function runOne(a: Action, ctx: ActionRunContext): Promise<void> {
  const { page } = ctx;
  switch (a.op) {
    case "waitFor":
      await page.locator(a.selector).waitFor({
        state: a.state ?? "visible",
        timeout: a.timeout ?? ctx.defaultTimeout,
      });
      return;
    case "sleep":
      await page.waitForTimeout(a.ms);
      return;
    case "click":
    case "hover":
    case "type": {
      const loc = page.locator(a.selector);
      const block = await preClickGuard(page, loc, ctx.blocklist, ctx.extraGuardSelectors);
      if (block) {
        await highlightElement(page, loc);
        throw Object.assign(new Error(block.reason), {
          kind: "click_guard_blocked",
          op: a.op,
          reason: block.reason,
          detail: block,
        });
      }
      if (a.op === "click") {
        await loc.click({
          button: a.button,
          clickCount: a.clickCount,
          timeout: a.timeout ?? ctx.defaultTimeout,
        });
      } else if (a.op === "hover") {
        await loc.hover();
      } else {
        if (a.clear) await loc.fill("");
        await loc.type(a.text, { delay: a.delay });
      }
      return;
    }
    case "press":
      await page.keyboard.press(a.key);
      return;
    case "scroll":
      if (a.selector) {
        await page.locator(a.selector).scrollIntoViewIfNeeded();
      } else {
        await page.evaluate((y) => window.scrollTo(0, y ?? 0), a.y);
      }
      return;
    case "select":
      await page.locator(a.selector).selectOption(a.value);
      return;
    case "evaluate": {
      try {
        const val = await page.evaluate(new Function(`return (${a.script})`)() as never);
        if (a.returnAs) ctx.evaluations[a.returnAs] = val;
      } catch (err) {
        ctx.evaluations[a.returnAs ?? `_err_${Date.now()}`] = {
          error: (err as Error).message,
        };
      }
      return;
    }
    case "goto":
      await page.goto(a.url, { waitUntil: a.waitUntil ?? "domcontentloaded" });
      return;
    case "setViewport":
      await page.setViewportSize({ width: a.width, height: a.height });
      return;
    case "emulate": {
      const preset = devices[a.device];
      if (!preset) throw new Error(`unknown device preset: ${a.device}`);
      await page.setViewportSize(preset.viewport);
      return;
    }
  }
}
