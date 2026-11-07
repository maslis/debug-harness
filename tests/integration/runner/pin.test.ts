import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startRunner, type RunnerHandle } from "../../../src/runner/server.ts";
import { makeSandbox, postRun, type RunEvent, type Sandbox } from "./helpers.ts";

// The real Playwright binary and the real hook; no browser, so it runs anywhere.
// A test's trace.zip is written without one, through the same zipBundle import.
const REAL_PLAYWRIGHT = resolve("node_modules/.bin/playwright");

let s: Sandbox;
let runner: RunnerHandle;

beforeEach(async () => {
  s = makeSandbox();
  writeFileSync(join(s.root, "playwright.config.ts"), `export default { testDir: "./tests", retries: 0, use: { trace: "retain-on-failure" } };\n`);
  runner = await startRunner(s.config({ playwright: { bin: REAL_PLAYWRIGHT } }), { log: () => {}, port: 0, host: "127.0.0.1" });
});
afterEach(async () => {
  await runner.close();
  s.cleanup();
});

function findAll(dir: string, name: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) return findAll(p, name);
    return entry === name ? [p] : [];
  });
}

const textOf = (events: RunEvent[]) => events.filter((e) => e.type === "output").map((e) => e.data).join("");

// SetAlarmClock's specs load through import, a project without "type": "module" through require.
describe.each(["module", "commonjs"])("pin hook, real Playwright, %s project", (type) => {
  beforeEach(() => writeFileSync(join(s.root, "package.json"), JSON.stringify({ type })));

  it("a failing test with retain-on-failure writes trace.zip, and prints no false package error", async () => {
    writeFileSync(join(s.root, "tests/fail.spec.ts"), `import { test, expect } from "@playwright/test";\ntest("fails", () => { expect(1).toBe(2); });\n`);
    const r = await postRun(runner.port, { command: "playwright", args: ["tests/fail.spec.ts"], cwd: s.root, env: {} });
    const started = r.events.find((e) => e.type === "started") as unknown as { resultsDir: string };
    expect(r.events.at(-1)).toMatchObject({ type: "exit", code: 1 });
    expect(textOf(r.events)).not.toMatch(/Cannot find (package|module)/);
    expect(findAll(started.resultsDir, "trace.zip")).toHaveLength(1);
  }, 60_000);

  it("a spec's own playwright-core import still means the image's copy", async () => {
    writeFileSync(
      join(s.root, "tests/core.spec.ts"),
      `import { test, expect } from "@playwright/test";\nimport { chromium } from "playwright-core";\nimport { createRequire } from "node:module";\n` +
        `test("pinned", () => {\n  expect(typeof chromium.launch).toBe("function");\n  expect(createRequire(process.cwd() + "/x.js").resolve("playwright-core")).toContain("playwright-core@1.59.1");\n});\n`,
    );
    const r = await postRun(runner.port, { command: "playwright", args: ["tests/core.spec.ts"], cwd: s.root, env: {} });
    expect(textOf(r.events)).not.toMatch(/Cannot find (package|module)/);
    expect(r.events.at(-1)).toMatchObject({ type: "exit", code: 0 });
  }, 60_000);
});
