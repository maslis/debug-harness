import type { Browser, BrowserContext, ConsoleMessage } from "playwright";
import { devices } from "playwright";
import type { CaptureRequest, CaptureResult, CaptureSummary } from "./types.ts";
import { rewriteLocalhost, isInDocker } from "./url.ts";
import { DEFAULT_AD_HOSTS } from "./ad-hosts.ts";
import {
  attachNetworkLogger,
  createSafetyState,
  installRouteBlocker,
} from "./safety.ts";
import { runActions, type ActionFailure } from "./actions.ts";
import { installVitals, readVitals } from "./vitals.ts";
import {
  buildRunId,
  createRunDir,
  writeBinary,
  writeJson,
  writeText,
} from "./artifacts.ts";
import { HARNESS_VERSION } from "./version.ts";

export async function capture(
  browser: Browser,
  req: CaptureRequest,
  opts: { subpath?: string; runIdOverride?: string } = {},
): Promise<CaptureResult> {
  const runId = opts.runIdOverride ?? buildRunId(req.runId);
  const run = await createRunDir(runId, opts.subpath);
  const target = isInDocker() ? rewriteLocalhost(req.url) : req.url;
  const blocklist = [...DEFAULT_AD_HOSTS, ...req.blockHosts];

  const consoleLines: string[] = [];
  const errors: Array<{ type: string; message: string; stack?: string; timestamp: string }> = [];
  const state = createSafetyState();
  const evaluations: Record<string, unknown> = {};

  const contextOpts = req.device && devices[req.device]
    ? { ...devices[req.device] }
    : { viewport: req.viewport ?? { width: 1440, height: 900 } };
  const context: BrowserContext = await browser.newContext(contextOpts);
  await installRouteBlocker(context, state, { blocklist, allowAds: req.allowAds });
  await installVitals(context);

  const page = await context.newPage();
  attachNetworkLogger(page, state);
  page.on("console", (m: ConsoleMessage) => {
    const loc = m.location();
    consoleLines.push(
      `[${m.type().toUpperCase()}] [${new Date().toISOString()}] ${m.text()} (${loc.url}:${loc.lineNumber})`,
    );
    if (m.type() === "error") {
      errors.push({
        type: "console.error",
        message: m.text(),
        timestamp: new Date().toISOString(),
      });
    }
  });
  page.on("pageerror", (err) => {
    errors.push({
      type: "pageerror",
      message: err.message,
      stack: err.stack,
      timestamp: new Date().toISOString(),
    });
  });

  let initialStatus: number | null = null;
  let fail: ActionFailure | null = null;
  try {
    const res = await page.goto(target, { waitUntil: "domcontentloaded", timeout: 30_000 });
    initialStatus = res?.status() ?? null;

    fail = await runActions(req.actions, {
      page,
      context,
      blocklist,
      extraGuardSelectors: [],
      state,
      evaluations,
      defaultTimeout: 5000,
    });

    if (!fail) await page.waitForTimeout(req.settleMs);
  } catch (err) {
    fail = {
      kind: "action_failed",
      actionIndex: -1,
      op: "goto",
      reason: (err as Error).message,
    };
  }

  // Always capture what we can, even on failure.
  const files: Record<string, string> = {};
  try {
    files.viewport = await writeBinary(run.absDir, "viewport.png", await page.screenshot({ fullPage: false }));
    files.fullPage = await writeBinary(run.absDir, "full.png", await page.screenshot({ fullPage: true }));
    files.dom = await writeText(run.absDir, "dom.html", await page.content());
    const consoleHeader = `# run: ${runId} target: ${target}`;
    const consoleBody = consoleLines.length > 0 ? `${consoleHeader}\n${consoleLines.join("\n")}` : consoleHeader;
    files.console = await writeText(run.absDir, "console.log", consoleBody);
    files.network = await writeJson(run.absDir, "network.json", state.net);
    files.errors = await writeJson(run.absDir, "errors.json", errors);
    files.computedStyles = await writeJson(
      run.absDir,
      "computed-styles.json",
      await inspectSelectors(page, req.inspect),
    );
    files.vitals = await writeJson(run.absDir, "web-vitals.json", await readVitals(page));
  } catch (err) {
    errors.push({
      type: "internal",
      message: `artifact write failed: ${(err as Error).message}`,
      timestamp: new Date().toISOString(),
    });
  }

  const vitals = await readVitals(page).catch(() => null);
  const summary: CaptureSummary = {
    finalUrl: page.url(),
    title: await page.title().catch(() => ""),
    statusCode: initialStatus,
    pageErrors: errors.filter((e) => e.type === "pageerror").length,
    consoleErrors: errors.filter((e) => e.type === "console.error").length,
    requests: state.net.length,
    failedRequests: state.net.filter((n) => n.status !== null && n.status >= 400).length,
    blockedAdRequests: state.blockedAdRequests,
    clickGuardBlocks: state.clickGuardBlocks,
    actionsRun: fail ? Math.max(0, fail.actionIndex) : req.actions.length,
    actionsFailed: fail ? 1 : 0,
    lcpMs: vitals?.lcp?.value ?? null,
    cls: vitals?.cls?.value ?? null,
    inpMs: vitals?.inp?.value ?? null,
    error: fail
      ? { kind: fail.kind, actionIndex: fail.actionIndex, op: fail.op, reason: fail.reason }
      : undefined,
  };

  files.meta = await writeJson(run.absDir, "meta.json", {
    harnessVersion: HARNESS_VERSION,
    request: req,
    target,
    evaluations,
    summary,
  });

  await context.close();

  return { runId, artifactDir: run.relDir, files, summary };
}

async function inspectSelectors(
  page: import("playwright").Page,
  selectors: readonly string[],
): Promise<Record<string, unknown>> {
  if (selectors.length === 0) return {};
  return page.evaluate((sels) => {
    const out: Record<string, unknown[]> = {};
    const props = [
      "display", "position", "color", "backgroundColor", "fontSize", "fontFamily",
      "fontWeight", "margin", "padding", "border", "width", "height",
      "gridTemplateColumns", "gridTemplateRows", "flexDirection", "alignItems", "justifyContent",
      "zIndex", "opacity", "visibility", "transform",
    ];
    for (const sel of sels) {
      const nodes = Array.from(document.querySelectorAll(sel)).slice(0, 5);
      out[sel] = nodes.map((n) => {
        const cs = window.getComputedStyle(n);
        const bbox = n.getBoundingClientRect();
        const styles: Record<string, string> = {};
        for (const p of props) styles[p] = cs.getPropertyValue(p as never) || (cs as never)[p as never] || "";
        return {
          textContent: (n.textContent ?? "").trim().slice(0, 200),
          bbox: { x: bbox.x, y: bbox.y, width: bbox.width, height: bbox.height },
          styles,
        };
      });
    }
    return out;
  }, [...selectors]);
}
