import type { Browser } from "playwright";
import { createReadStream, createWriteStream } from "node:fs";
import { join, resolve } from "node:path";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import type { CompareRequest, CaptureResult } from "./types.ts";
import { capture } from "./capture.ts";
import { buildRunId, writeJson } from "./artifacts.ts";

export interface CompareResult {
  runId: string;
  artifactDir: string;
  local: CaptureResult;
  prod: CaptureResult;
  diff: {
    image: string;
    diffPct: number;
    diffPixels: number;
    total: number;
    vitalsDelta: Record<string, number | null>;
  };
}

function readPng(path: string): Promise<PNG> {
  return new Promise((res, rej) => {
    const png = new PNG();
    createReadStream(path).pipe(png).on("parsed", () => res(png)).on("error", rej);
  });
}

function writePng(png: PNG, path: string): Promise<void> {
  return new Promise((res, rej) => {
    png.pack().pipe(createWriteStream(path)).on("finish", () => res()).on("error", rej);
  });
}

export async function compareRuns(
  browser: Browser,
  req: CompareRequest,
): Promise<CompareResult> {
  const runId = buildRunId("compare");
  const sharedViewport = req.viewport;
  // Top-level req.headers is the shared baseline for both local and prod.
  // Per-capture headers (req.local.headers / req.prod.headers) take priority
  // on key overlap so JSON consumers can override per side.
  const mergeHeaders = (
    perCapture: Record<string, string> | undefined,
  ): Record<string, string> | undefined => {
    const top = req.headers;
    if (!top && !perCapture) return undefined;
    return { ...(top ?? {}), ...(perCapture ?? {}) };
  };
  const mergedProd = {
    actions: req.local.actions,
    inspect: req.local.inspect,
    allowAds: req.local.allowAds,
    blockHosts: req.local.blockHosts,
    settleMs: req.local.settleMs,
    ...req.prod,
    viewport: sharedViewport ?? req.local.viewport,
    device: req.device ?? req.prod.device ?? req.local.device,
    headers: mergeHeaders(req.prod.headers),
  };

  const local = await capture(
    browser,
    {
      ...req.local,
      viewport: sharedViewport ?? req.local.viewport,
      device: req.device ?? req.local.device,
      headers: mergeHeaders(req.local.headers),
    },
    { subpath: "local", runIdOverride: runId },
  );
  const prod = await capture(
    browser,
    mergedProd as never,
    { subpath: "prod", runIdOverride: runId },
  );

  const localShot = resolve(process.cwd(), local.artifactDir, local.files.viewport!);
  const prodShot = resolve(process.cwd(), prod.artifactDir, prod.files.viewport!);
  const [l, p] = await Promise.all([readPng(localShot), readPng(prodShot)]);
  const { width, height } = l;
  if (p.width !== width || p.height !== height) {
    throw new Error(
      `dimension mismatch: local ${width}x${height} vs prod ${p.width}x${p.height}`,
    );
  }
  const diffPng = new PNG({ width, height });
  const diffPixels = pixelmatch(l.data, p.data, diffPng.data, width, height, {
    threshold: req.diff.threshold,
    alpha: req.diff.alpha,
    diffColor: [255, 0, 0],
  });
  const diffDir = resolve(process.cwd(), "artifacts", runId);
  await writePng(diffPng, join(diffDir, "diff.png"));

  const vitalsDelta: Record<string, number | null> = {
    lcp:
      local.summary.lcpMs !== null && prod.summary.lcpMs !== null
        ? local.summary.lcpMs - prod.summary.lcpMs
        : null,
    cls:
      local.summary.cls !== null && prod.summary.cls !== null
        ? +(local.summary.cls - prod.summary.cls).toFixed(4)
        : null,
    inp:
      local.summary.inpMs !== null && prod.summary.inpMs !== null
        ? local.summary.inpMs - prod.summary.inpMs
        : null,
  };

  const total = width * height;
  const result: CompareResult = {
    runId,
    artifactDir: join("artifacts", runId),
    local,
    prod,
    diff: {
      image: "diff.png",
      diffPct: +((diffPixels / total) * 100).toFixed(2),
      diffPixels,
      total,
      vitalsDelta,
    },
  };
  await writeJson(diffDir, "compare-meta.json", {
    diffPct: result.diff.diffPct,
    diffPixels,
    total,
    vitalsDelta,
    localRun: local.runId,
    prodRun: prod.runId,
  });
  return result;
}
