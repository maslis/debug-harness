import type { Browser, BrowserContext, ConsoleMessage } from "playwright";
import { devices } from "playwright";
import { playAudit } from "playwright-lighthouse";
import type {
  AuditFailedCheck,
  AuditOpportunity,
  AuditRequest,
  AuditResult,
  AuditSummary,
  LighthouseCategory,
} from "./types.ts";
import { rewriteLocalhost, isInDocker } from "./url.ts";
import { DEFAULT_AD_HOSTS } from "./ad-hosts.ts";
import { attachNetworkLogger, createSafetyState, installRouteBlocker } from "./safety.ts";
import { runActions, type ActionFailure } from "./actions.ts";
import { buildRunId, createRunDir, writeBinary, writeJson } from "./artifacts.ts";
import { HARNESS_VERSION } from "./version.ts";

const ALL_CATEGORIES: LighthouseCategory[] = [
  "performance",
  "accessibility",
  "best-practices",
  "seo",
];

export async function audit(
  browser: Browser,
  req: AuditRequest,
  cdpPort: number,
): Promise<AuditResult> {
  const runId = buildRunId(req.runId);
  const run = await createRunDir(runId);
  const target = isInDocker() ? rewriteLocalhost(req.url) : req.url;
  const blocklist = [...DEFAULT_AD_HOSTS, ...req.blockHosts];

  const consoleLines: string[] = [];
  const state = createSafetyState();
  const evaluations: Record<string, unknown> = {};

  const baseOpts = req.device && devices[req.device]
    ? { ignoreHTTPSErrors: true, ...devices[req.device] }
    : { ignoreHTTPSErrors: true, viewport: req.viewport ?? { width: 1440, height: 900 } };
  const contextOpts = req.headers && Object.keys(req.headers).length > 0
    ? { ...baseOpts, extraHTTPHeaders: req.headers }
    : baseOpts;
  const context: BrowserContext = await browser.newContext(contextOpts);
  await installRouteBlocker(context, state, { blocklist, allowAds: req.allowAds });

  const page = await context.newPage();
  attachNetworkLogger(page, state);
  page.on("console", (m: ConsoleMessage) => {
    consoleLines.push(`[${m.type().toUpperCase()}] ${m.text()}`);
  });

  let fail: ActionFailure | null = null;
  let lighthouseError: { reason: string; detail?: unknown } | null = null;
  let lhrJson: unknown = null;
  let screenshot: Buffer | null = null;

  try {
    await page.goto(target, { waitUntil: "domcontentloaded", timeout: 30_000 });

    fail = await runActions(req.actions, {
      page,
      context,
      blocklist,
      extraGuardSelectors: [],
      state,
      evaluations,
      defaultTimeout: 5000,
    });

    if (!fail) {
      await page.waitForTimeout(req.settleMs);
      try {
        // playwright-lighthouse pins playwright-core at a different minor than
        // playwright/@playwright/test, producing a structural Page-type mismatch
        // at compile time. Runtime API is identical for the methods we touch.
        const playAuditConfig = {
          page,
          port: cdpPort,
          thresholds: {},
          opts: {
            onlyCategories: req.categories,
            preset: req.preset === "mobile" ? "perf" : undefined,
            formFactor: req.preset,
            screenEmulation: req.preset === "desktop"
              ? { mobile: false, width: 1350, height: 940, deviceScaleFactor: 1, disabled: false }
              : { mobile: true, width: 412, height: 823, deviceScaleFactor: 1.75, disabled: false },
          },
          reports: { formats: { json: true, html: false }, name: "lighthouse" },
        } as unknown as Parameters<typeof playAudit>[0];
        const lhResult = await playAudit(playAuditConfig);
        lhrJson = (lhResult as { lhr: unknown }).lhr;
      } catch (err) {
        lighthouseError = { reason: (err as Error).message };
      }

      try {
        screenshot = await page.screenshot({ fullPage: false });
      } catch { /* non-fatal */ }
    }
  } catch (err) {
    fail = {
      kind: "action_failed",
      actionIndex: -1,
      op: "goto",
      reason: (err as Error).message,
    };
  }

  const files: Record<string, string> = {};
  if (lhrJson) {
    files.lighthouse = await writeJson(run.absDir, "lighthouse.json", lhrJson);
  }
  if (screenshot) {
    files.viewport = await writeBinary(run.absDir, "viewport.png", screenshot);
  }
  files.console = await writeJson(run.absDir, "console.json", consoleLines);
  files.network = await writeJson(run.absDir, "network.json", state.net);

  const summary = buildSummary({
    lhr: lhrJson,
    target,
    pageUrl: page.url(),
    thresholds: req.thresholds,
    fail,
    lighthouseError,
  });

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

interface BuildSummaryArgs {
  lhr: unknown;
  target: string;
  pageUrl: string;
  thresholds: Partial<Record<LighthouseCategory, number>>;
  fail: ActionFailure | null;
  lighthouseError: { reason: string; detail?: unknown } | null;
}

export function buildSummary(args: BuildSummaryArgs): AuditSummary {
  const empty: AuditSummary = {
    finalUrl: args.pageUrl || args.target,
    fetchTime: new Date().toISOString(),
    scores: { performance: null, accessibility: null, "best-practices": null, seo: null },
    opportunities: [],
    failedAudits: [],
    thresholdFailures: [],
    cwv: {
      lcpMs: null, cls: null, fcpMs: null, ttfbMs: null, tbtMs: null, speedIndex: null,
    },
  };

  if (args.fail) {
    return { ...empty, error: { kind: args.fail.kind, reason: args.fail.reason, detail: args.fail.detail } };
  }
  if (args.lighthouseError) {
    return { ...empty, error: { kind: "lighthouse_failed", reason: args.lighthouseError.reason } };
  }
  if (!args.lhr || typeof args.lhr !== "object") {
    return { ...empty, error: { kind: "lighthouse_failed", reason: "no lighthouse result" } };
  }

  const lhr = args.lhr as LhrShape;
  const scores = extractScores(lhr);
  const auditEntries = lhr.audits ?? {};
  const opportunities = extractOpportunities(auditEntries);
  const failedAudits = extractFailedAudits(lhr);
  const thresholdFailures = computeThresholdFailures(scores, args.thresholds);
  const cwv = extractCwv(auditEntries);

  return {
    finalUrl: lhr.finalUrl ?? args.pageUrl ?? args.target,
    fetchTime: lhr.fetchTime ?? new Date().toISOString(),
    scores,
    opportunities,
    failedAudits,
    thresholdFailures,
    cwv,
  };
}

interface LhrShape {
  finalUrl?: string;
  fetchTime?: string;
  categories?: Record<string, { id: string; score: number | null; auditRefs?: Array<{ id: string }> }>;
  audits?: Record<string, LhrAudit>;
}

interface LhrAudit {
  id?: string;
  title?: string;
  description?: string;
  score?: number | null;
  scoreDisplayMode?: string;
  numericValue?: number;
  displayValue?: string;
  details?: { type?: string; overallSavingsMs?: number; overallSavingsBytes?: number };
}

function extractScores(lhr: LhrShape): Record<LighthouseCategory, number | null> {
  const out: Record<LighthouseCategory, number | null> = {
    performance: null, accessibility: null, "best-practices": null, seo: null,
  };
  for (const cat of ALL_CATEGORIES) {
    const raw = lhr.categories?.[cat]?.score;
    out[cat] = typeof raw === "number" ? Math.round(raw * 100) : null;
  }
  return out;
}

function extractOpportunities(audits: Record<string, LhrAudit>): AuditOpportunity[] {
  const ops: AuditOpportunity[] = [];
  for (const [id, a] of Object.entries(audits)) {
    if (a.details?.type !== "opportunity") continue;
    if ((a.score ?? 1) >= 0.9) continue;
    ops.push({
      id,
      title: a.title ?? id,
      description: a.description ?? "",
      score: a.score ?? null,
      wastedMs: a.details?.overallSavingsMs ?? null,
      wastedBytes: a.details?.overallSavingsBytes ?? null,
      displayValue: a.displayValue ?? null,
    });
  }
  ops.sort((x, y) => (y.wastedMs ?? 0) - (x.wastedMs ?? 0) || (y.wastedBytes ?? 0) - (x.wastedBytes ?? 0));
  return ops.slice(0, 10);
}

function extractFailedAudits(lhr: LhrShape): AuditFailedCheck[] {
  const audits = lhr.audits ?? {};
  const failures: AuditFailedCheck[] = [];
  for (const cat of ALL_CATEGORIES) {
    const refs = lhr.categories?.[cat]?.auditRefs ?? [];
    for (const ref of refs) {
      const a = audits[ref.id];
      if (!a) continue;
      if (a.scoreDisplayMode === "informative" || a.scoreDisplayMode === "notApplicable" || a.scoreDisplayMode === "manual") continue;
      if (a.score === null || a.score === undefined) continue;
      if (a.score >= 0.9) continue;
      failures.push({
        id: ref.id,
        title: a.title ?? ref.id,
        score: a.score,
        displayValue: a.displayValue ?? null,
        category: cat,
      });
    }
  }
  return failures;
}

function computeThresholdFailures(
  scores: Record<LighthouseCategory, number | null>,
  thresholds: Partial<Record<LighthouseCategory, number>>,
): Array<{ category: LighthouseCategory; score: number; min: number }> {
  const out: Array<{ category: LighthouseCategory; score: number; min: number }> = [];
  for (const cat of ALL_CATEGORIES) {
    const min = thresholds[cat];
    const score = scores[cat];
    if (typeof min === "number" && typeof score === "number" && score < min) {
      out.push({ category: cat, score, min });
    }
  }
  return out;
}

function extractCwv(audits: Record<string, LhrAudit>): AuditSummary["cwv"] {
  const num = (id: string): number | null => {
    const v = audits[id]?.numericValue;
    return typeof v === "number" ? Math.round(v * 1000) / 1000 : null;
  };
  return {
    lcpMs: num("largest-contentful-paint"),
    cls: num("cumulative-layout-shift"),
    fcpMs: num("first-contentful-paint"),
    ttfbMs: num("server-response-time"),
    tbtMs: num("total-blocking-time"),
    speedIndex: num("speed-index"),
  };
}
