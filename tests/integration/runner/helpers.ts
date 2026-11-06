import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { RunnerConfigSchema, type RunnerConfig } from "../../../src/runner/config.ts";

export const FAKE_PLAYWRIGHT = resolve("tests/fixtures/runner/fake-playwright.mjs");

export interface Sandbox {
  base: string;
  root: string;
  worktrees: string;
  results: string;
  outside: string;
  config: (over?: Partial<Record<keyof RunnerConfig, unknown>>) => RunnerConfig;
  cleanup: () => void;
}

/** A project root with one spec, one script and one worktree, plus a folder outside it. */
export function makeSandbox(): Sandbox {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "runner-test-")));
  const root = join(base, "project");
  const worktrees = join(root, ".worktrees");
  const results = join(root, ".debug-harness");
  const outside = join(base, "outside");
  for (const d of [join(root, "tests"), join(root, "scripts/shell"), join(root, "scripts/other"), join(worktrees, "wt1/tests"), results, outside]) {
    mkdirSync(d, { recursive: true });
  }
  writeFileSync(join(root, "playwright.config.ts"), "export default {};\n");
  writeFileSync(join(worktrees, "wt1/playwright.config.ts"), "export default {};\n");
  writeFileSync(join(root, "tests/a.spec.ts"), "\n");
  writeFileSync(join(worktrees, "wt1/tests/w.spec.ts"), "\n");
  writeFileSync(join(root, "scripts/shell/ok.mjs"), "console.log(JSON.stringify(process.argv.slice(2)));\n");
  writeFileSync(join(root, "scripts/other/no.mjs"), "\n");
  writeFileSync(join(outside, "evil.spec.ts"), "\n");
  return {
    base,
    root,
    worktrees,
    results,
    outside,
    config: (over = {}) =>
      RunnerConfigSchema.parse({
        project: "test",
        roots: [root],
        worktreeRoots: [worktrees],
        resultsDir: results,
        allowedEnv: ["BASE_URL", "PRO[0-9]+_.*", "FAKE_.*"],
        playwright: { bin: FAKE_PLAYWRIGHT },
        ...over,
      }),
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

export interface RunEvent {
  type: string;
  [k: string]: unknown;
}

export interface RunReply {
  status: number;
  events: RunEvent[];
  error?: { code: string; message: string };
}

/** POST /run and collect the whole reply. */
export function postRun(port: number, body: unknown, headers: Record<string, string> = {}): Promise<RunReply> {
  return new Promise((res, rej) => {
    const req = request(
      { port, path: "/run", method: "POST", headers: { "content-type": "application/json", ...headers } },
      (r) => {
        let text = "";
        r.setEncoding("utf8");
        r.on("data", (c: string) => (text += c));
        r.on("end", () => {
          if (r.statusCode !== 200) {
            res({ status: r.statusCode ?? 0, events: [], error: JSON.parse(text).error });
            return;
          }
          res({ status: 200, events: text.trim().split("\n").map((l) => JSON.parse(l) as RunEvent) });
        });
      },
    );
    req.on("error", rej);
    req.end(typeof body === "string" ? body : JSON.stringify(body));
  });
}

/** POST /run, wait for `until` in the stream, hand back the open request so a test can drop it. */
export function openRun(
  port: number,
  body: unknown,
  until: (e: RunEvent) => boolean,
): Promise<{ drop: () => void; events: RunEvent[]; done: Promise<void> }> {
  return new Promise((res, rej) => {
    const events: RunEvent[] = [];
    let finish: () => void = () => {};
    const done = new Promise<void>((d) => (finish = d));
    const req = request({ port, path: "/run", method: "POST", headers: { "content-type": "application/json" } }, (r) => {
      let buf = "";
      r.setEncoding("utf8");
      r.on("data", (c: string) => {
        buf += c;
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const e = JSON.parse(buf.slice(0, i)) as RunEvent;
          buf = buf.slice(i + 1);
          events.push(e);
          if (until(e)) res({ drop: () => req.destroy(), events, done });
        }
      });
      r.on("end", finish);
      r.on("close", finish);
      r.on("error", finish);
    });
    req.on("error", (e) => (events.length ? finish() : rej(e)));
    req.end(JSON.stringify(body));
  });
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitFor(cond: () => boolean, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return cond();
}
