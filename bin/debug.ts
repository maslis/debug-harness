#!/usr/bin/env -S node --experimental-strip-types
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const ENDPOINT = process.env.DEBUG_HARNESS_URL ?? "http://localhost:3939";

async function main(): Promise<number> {
  const [, , cmd, ...rest] = process.argv;
  switch (cmd) {
    case "up": return cmdDocker(["up", "-d"]);
    case "down": return cmdDocker(["down"]);
    case "logs": return cmdDocker(["logs", ...rest]);
    case "health": return cmdHealth();
    case "devices": return cmdDevices();
    case "capture": return cmdCapture(rest);
    case "compare": return cmdCompare(rest);
    case "audit": return cmdAudit(rest);
    case "audit-diff": return cmdAuditDiff(rest);
    case "test": return cmdTest(rest);
    case "open": return cmdOpen(rest[0] ?? "");
    default:
      printUsage();
      return cmd ? 2 : 0;
  }
}

function printUsage(): void {
  console.log(`debug <command>
  up | down | logs [-f]
  health | devices
  capture <url> [flags]
  compare <local> <prod> [flags]
  audit <url> [--categories=perf,a11y,best-practices,seo] [--thresholds=perf:90,...] [--preset=mobile|desktop]
  audit-diff <runId-before> <runId-after>
  test [-- playwright args]
  open <runId>
Flags:
  --viewport <WxH>        --device <name>
  --actions <path|-|json> --inspect <sel,sel,...>
  --allow-ads             --block-host <host>          (repeatable)
  --settle <ms>           --run-id <name>
  --timeout <ms>          --json                        --quiet`);
}

function parseFlags(args: string[]): {
  positional: string[];
  viewport?: { width: number; height: number };
  device?: string;
  actions?: unknown;
  inspect?: string[];
  allowAds?: boolean;
  blockHosts: string[];
  settleMs?: number;
  runId?: string;
  timeout?: number;
  json: boolean;
  quiet: boolean;
  failOn?: string[];
  categories?: string[];
  thresholds?: Record<string, number>;
  preset?: "mobile" | "desktop";
} {
  const out: ReturnType<typeof parseFlags> = {
    positional: [], blockHosts: [], json: false, quiet: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const next = () => args[++i] ?? "";
    switch (a) {
      case "--viewport": {
        const [w, h] = next().split("x").map(Number);
        out.viewport = { width: w!, height: h! }; break;
      }
      case "--device": out.device = next(); break;
      case "--actions": out.actions = next(); break;
      case "--inspect": out.inspect = next().split(",").map((s) => s.trim()).filter(Boolean); break;
      case "--allow-ads": out.allowAds = true; break;
      case "--block-host": out.blockHosts.push(next()); break;
      case "--settle": out.settleMs = Number(next()); break;
      case "--run-id": out.runId = next(); break;
      case "--timeout": out.timeout = Number(next()); break;
      case "--json": out.json = true; break;
      case "--quiet": out.quiet = true; break;
      case "--fail-on": out.failOn = next().split(",").map((s) => s.trim()); break;
      case "--categories": out.categories = next().split(",").map(expandCategory); break;
      case "--thresholds": {
        const map: Record<string, number> = {};
        for (const pair of next().split(",")) {
          const [k, v] = pair.split(":");
          if (k && v) map[expandCategory(k)] = Number(v);
        }
        out.thresholds = map;
        break;
      }
      case "--preset": {
        const v = next();
        if (v === "mobile" || v === "desktop") out.preset = v;
        break;
      }
      default: out.positional.push(a);
    }
  }
  return out;
}

function expandCategory(s: string): string {
  const t = s.trim().toLowerCase();
  if (t === "perf" || t === "performance") return "performance";
  if (t === "a11y" || t === "accessibility") return "accessibility";
  if (t === "best-practices" || t === "bp") return "best-practices";
  if (t === "seo") return "seo";
  return t;
}

async function resolveActions(raw: unknown): Promise<unknown> {
  if (!raw) return [];
  if (typeof raw !== "string") return raw;
  if (raw === "-") {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }
  if (raw.trim().startsWith("[") || raw.trim().startsWith("{")) return JSON.parse(raw);
  const body = await readFile(raw, "utf8");
  return JSON.parse(body);
}

async function cmdHealth(): Promise<number> {
  try {
    const res = await fetch(ENDPOINT + "/health");
    if (!res.ok) { console.error("unhealthy:", res.status); return 2; }
    console.log(await res.text());
    return 0;
  } catch {
    console.error("service not running — start with: debug up");
    return 2;
  }
}

async function cmdDevices(): Promise<number> {
  const res = await fetch(ENDPOINT + "/devices");
  console.log((await res.json() as string[]).join("\n"));
  return 0;
}

async function cmdCapture(args: string[]): Promise<number> {
  const p = parseFlags(args);
  const url = p.positional[0];
  if (!url) { console.error("usage: debug capture <url>"); return 2; }
  const payload = {
    url,
    viewport: p.viewport,
    device: p.device,
    actions: await resolveActions(p.actions),
    inspect: p.inspect ?? [],
    allowAds: p.allowAds ?? false,
    blockHosts: p.blockHosts,
    settleMs: p.settleMs,
    runId: p.runId,
  };
  return sendAndPrint("/capture", payload, p);
}

async function cmdCompare(args: string[]): Promise<number> {
  const p = parseFlags(args);
  const [local, prod] = p.positional;
  if (!local || !prod) { console.error("usage: debug compare <localUrl> <prodUrl>"); return 2; }
  const actions = await resolveActions(p.actions);
  const payload = {
    local: {
      url: local, actions, inspect: p.inspect ?? [],
      allowAds: p.allowAds ?? false, blockHosts: p.blockHosts,
      settleMs: p.settleMs,
    },
    prod: { url: prod },
    viewport: p.viewport, device: p.device,
  };
  return sendAndPrint("/compare", payload, p);
}

async function cmdAudit(args: string[]): Promise<number> {
  const p = parseFlags(args);
  const url = p.positional[0];
  if (!url) { console.error("usage: debug audit <url> [flags]"); return 2; }
  const payload = {
    url,
    viewport: p.viewport,
    device: p.device,
    actions: await resolveActions(p.actions),
    allowAds: p.allowAds ?? false,
    blockHosts: p.blockHosts,
    settleMs: p.settleMs,
    runId: p.runId,
    categories: p.categories,
    thresholds: p.thresholds,
    preset: p.preset,
  };
  return sendAndPrint("/audit", payload, p);
}

async function cmdAuditDiff(args: string[]): Promise<number> {
  const [before, after] = args;
  if (!before || !after) {
    console.error("usage: debug audit-diff <runId-before> <runId-after>");
    return 2;
  }
  const beforePath = resolve("artifacts", before, "lighthouse.json");
  const afterPath = resolve("artifacts", after, "lighthouse.json");
  if (!existsSync(beforePath) || !existsSync(afterPath)) {
    console.error(`missing lighthouse.json:\n  ${existsSync(beforePath) ? "OK" : "MISSING"} ${beforePath}\n  ${existsSync(afterPath) ? "OK" : "MISSING"} ${afterPath}`);
    return 2;
  }
  const lhBefore = JSON.parse(await readFile(beforePath, "utf8"));
  const lhAfter = JSON.parse(await readFile(afterPath, "utf8"));
  const cats = ["performance", "accessibility", "best-practices", "seo"] as const;
  const score = (lh: { categories?: Record<string, { score: number | null }> }, c: string): number | null => {
    const s = lh.categories?.[c]?.score;
    return typeof s === "number" ? Math.round(s * 100) : null;
  };
  console.log("category          before  after  delta");
  for (const c of cats) {
    const b = score(lhBefore, c);
    const a = score(lhAfter, c);
    const d = b !== null && a !== null ? a - b : null;
    const arrow = d === null ? "  ?" : d > 0 ? `+${d}` : d < 0 ? `${d}` : " 0";
    console.log(`${c.padEnd(18)}${String(b ?? "n/a").padStart(6)} ${String(a ?? "n/a").padStart(6)}  ${arrow}`);
  }
  return 0;
}

async function cmdTest(args: string[]): Promise<number> {
  const composeFile = resolve(process.cwd(), "compose.test.yml");
  if (!existsSync(composeFile)) {
    console.error("no compose.test.yml in cwd — see debug-harness README for setup");
    return 2;
  }
  return new Promise((res) => {
    const proc = spawn(
      "docker",
      [
        "compose",
        "-f", composeFile,
        "run", "--rm", "test",
        "pnpm", "playwright", "test",
        ...args,
      ],
      { stdio: "inherit" },
    );
    proc.on("exit", (code) => res(code ?? 0));
  });
}

async function sendAndPrint(path: string, payload: unknown, p: { json: boolean; quiet: boolean }): Promise<number> {
  let res: Response;
  try {
    res = await fetch(ENDPOINT + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    console.error("service not running — start with: debug up");
    return 2;
  }
  const body = await res.json();
  if (p.json) { console.log(JSON.stringify(body, null, 2)); return res.ok ? 0 : 22; }
  if (p.quiet) { console.log((body as { artifactDir?: string }).artifactDir ?? ""); return res.ok ? 0 : 22; }
  prettyPrint(body as never, res.status);
  if (res.status === 422) return 22;
  if (!res.ok) return 2;
  return 0;
}

function prettyPrint(body: Record<string, unknown>, status: number): void {
  const s = (body.summary ?? {}) as Record<string, unknown>;
  const ok = status === 200 ? "✓" : "✗";
  console.log(`${ok} ${status} ${body.runId ?? ""}`);

  if (s.scores) {
    prettyPrintAudit(body, s);
    return;
  }

  if (body.diff) {
    const d = body.diff as Record<string, unknown>;
    console.log(`  Diff:         ${d.diffPct}% (${d.diffPixels}/${d.total} px)`);
  }
  console.log(`  Final URL:    ${s.finalUrl ?? ""}  (${s.statusCode ?? "?"}, "${s.title ?? ""}")`);
  console.log(`  Actions:      ${s.actionsRun ?? 0}/${(Number(s.actionsRun ?? 0) + Number(s.actionsFailed ?? 0))} passed`);
  console.log(`  Console:      ${s.consoleErrors ?? 0} errors`);
  console.log(`  Network:      ${s.requests ?? 0} requests, ${s.failedRequests ?? 0} failed, ${s.blockedAdRequests ?? 0} blocked (ads)`);
  console.log(`  Web Vitals:   LCP ${s.lcpMs ?? "n/a"}ms  CLS ${s.cls ?? "n/a"}  INP ${s.inpMs ?? "n/a"}`);
  console.log(`  Click guard:  ${s.clickGuardBlocks ?? 0} blocks`);
  console.log(`  Artifacts:    ${body.artifactDir ?? ""}`);
  if (s.error) console.log(`  ERROR:        ${JSON.stringify(s.error)}`);
}

function prettyPrintAudit(body: Record<string, unknown>, s: Record<string, unknown>): void {
  const scores = s.scores as Record<string, number | null>;
  console.log(`  Final URL:    ${s.finalUrl ?? ""}`);
  console.log(`  Scores:       perf ${fmt(scores.performance)}  a11y ${fmt(scores.accessibility)}  bp ${fmt(scores["best-practices"])}  seo ${fmt(scores.seo)}`);
  const cwv = s.cwv as Record<string, number | null>;
  console.log(`  CWV (lab):    LCP ${fmt(cwv.lcpMs)}ms  CLS ${fmt(cwv.cls)}  TBT ${fmt(cwv.tbtMs)}ms  SI ${fmt(cwv.speedIndex)}`);
  const failures = (s.thresholdFailures as Array<{ category: string; score: number; min: number }>) ?? [];
  if (failures.length > 0) {
    console.log(`  Threshold failures:`);
    for (const f of failures) console.log(`    - ${f.category}: ${f.score} < ${f.min}`);
  }
  const ops = (s.opportunities as Array<{ id: string; title: string; wastedMs: number | null; wastedBytes: number | null }>) ?? [];
  if (ops.length > 0) {
    console.log(`  Top opportunities:`);
    for (const o of ops.slice(0, 5)) {
      const cost = o.wastedMs ? `${o.wastedMs}ms` : o.wastedBytes ? `${o.wastedBytes}B` : "—";
      console.log(`    - [${cost}] ${o.title} (${o.id})`);
    }
  }
  console.log(`  Artifacts:    ${body.artifactDir ?? ""}`);
  if (s.error) console.log(`  ERROR:        ${JSON.stringify(s.error)}`);
}

function fmt(v: number | null | undefined): string {
  return v === null || v === undefined ? "n/a" : String(v);
}

function cmdDocker(args: string[]): Promise<number> {
  return new Promise((res) => {
    const proc = spawn("docker", ["compose", ...args], { stdio: "inherit" });
    proc.on("exit", (code) => res(code ?? 0));
  });
}

function cmdOpen(runId: string): Promise<number> {
  if (!runId) { console.error("usage: debug open <runId>"); return Promise.resolve(2); }
  return new Promise((res) => {
    const proc = spawn("open", [`artifacts/${runId}`], { stdio: "inherit" });
    proc.on("exit", (code) => res(code ?? 0));
  });
}

process.exit(await main());
