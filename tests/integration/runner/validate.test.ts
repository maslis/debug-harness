import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RunnerConfigSchema } from "../../../src/runner/config.ts";
import { resolveRun, type Refusal, type ResolvedRun } from "../../../src/runner/validate.ts";
import { makeSandbox, type Sandbox } from "./helpers.ts";

let s: Sandbox;
beforeEach(() => {
  s = makeSandbox();
});
afterEach(() => s.cleanup());

function refused(r: ResolvedRun | Refusal): string {
  if (!("refused" in r)) throw new Error(`expected a refusal, got ${JSON.stringify(r)}`);
  return r.refused;
}
function allowed(r: ResolvedRun | Refusal): ResolvedRun {
  if ("refused" in r) throw new Error(`expected a run, got ${r.refused}: ${r.message}`);
  return r;
}
const pw = (args: string[], extra: object = {}) => ({ command: "playwright", args, cwd: s.root, ...extra });

describe("cwd", () => {
  it("accepts the project root and resolves its config", () => {
    const r = allowed(resolveRun(s.config(), pw(["tests/a.spec.ts"])));
    expect(r.cwd).toBe(s.root);
    expect(r.configPath).toBe(join(s.root, "playwright.config.ts"));
  });

  it("uses the worktree's own root and config when cwd is inside a worktree", () => {
    const wt = join(s.worktrees, "wt1");
    const r = allowed(resolveRun(s.config(), { command: "playwright", args: ["tests/w.spec.ts"], cwd: join(wt, "tests/..") }));
    expect(r.cwd).toBe(wt);
    expect(r.configPath).toBe(join(wt, "playwright.config.ts"));
  });

  it("refuses a cwd outside the root", () => {
    expect(refused(resolveRun(s.config(), { command: "playwright", args: [], cwd: s.outside }))).toBe("cwd_outside_root");
  });

  it("refuses a cwd reached through .. out of the root", () => {
    const cwd = `${s.root}/../outside`;
    expect(refused(resolveRun(s.config(), { command: "playwright", args: [], cwd }))).toBe("cwd_outside_root");
  });

  it("refuses a cwd that is a symlink out of the root", () => {
    const link = join(s.root, "escape");
    symlinkSync(s.outside, link);
    expect(refused(resolveRun(s.config(), { command: "playwright", args: [], cwd: link }))).toBe("cwd_outside_root");
  });

  it("refuses a worktree folder that is a symlink out of the root", () => {
    const link = join(s.worktrees, "evil");
    symlinkSync(s.outside, link);
    expect(refused(resolveRun(s.config(), { command: "playwright", args: [], cwd: link }))).toBe("cwd_outside_root");
  });

  it("does not treat a sibling folder sharing the root's prefix as inside", () => {
    const sibling = `${s.root}-other`;
    mkdirSync(sibling);
    expect(refused(resolveRun(s.config(), { command: "playwright", args: [], cwd: sibling }))).toBe("cwd_outside_root");
  });

  it("refuses a relative or missing cwd", () => {
    expect(refused(resolveRun(s.config(), { command: "playwright", args: [], cwd: "tests" }))).toBe("cwd_outside_root");
    expect(refused(resolveRun(s.config(), { command: "playwright", args: [], cwd: join(s.root, "nope") }))).toBe("cwd_outside_root");
  });
});

describe("spec paths", () => {
  it("refuses an absolute path outside the root", () => {
    expect(refused(resolveRun(s.config(), pw([join(s.outside, "evil.spec.ts")])))).toBe("path_outside_root");
  });

  it("refuses .. out of the root", () => {
    expect(refused(resolveRun(s.config(), pw(["../outside/evil.spec.ts"])))).toBe("path_outside_root");
  });

  it("refuses a symlink that escapes the root", () => {
    symlinkSync(join(s.outside, "evil.spec.ts"), join(s.root, "tests/link.spec.ts"));
    expect(refused(resolveRun(s.config(), pw(["tests/link.spec.ts"])))).toBe("path_outside_root");
  });

  it("refuses a symlinked folder that escapes the root", () => {
    symlinkSync(s.outside, join(s.root, "tests/dir"));
    expect(refused(resolveRun(s.config(), pw(["tests/dir/evil.spec.ts"])))).toBe("path_outside_root");
  });

  it("from a worktree, refuses a spec in the main root", () => {
    const r = resolveRun(s.config(), { command: "playwright", args: [join(s.root, "tests/a.spec.ts")], cwd: join(s.worktrees, "wt1") });
    expect(refused(r)).toBe("path_outside_root");
  });

  it("refuses a path that does not exist", () => {
    expect(refused(resolveRun(s.config(), pw(["tests/missing.spec.ts"])))).toBe("path_not_found");
  });

  it("keeps a :line suffix, and checks the file without it", () => {
    expect(allowed(resolveRun(s.config(), pw(["tests/a.spec.ts:12"]))).specs).toEqual(["tests/a.spec.ts:12"]);
    expect(refused(resolveRun(s.config(), pw(["../outside/evil.spec.ts:12"])))).toBe("path_outside_root");
  });

  it("refuses a NUL byte instead of throwing", () => {
    expect(refused(resolveRun(s.config(), pw(["tests/a\0.spec.ts"])))).toBe("bad_request");
  });
});

describe("flags", () => {
  it("normalises every allowed form to --name=value", () => {
    const r = allowed(
      resolveRun(s.config(), pw(["--workers=1", "--browser", "firefox", "--grep", "-leading dash", "--project=chromium-desktop", "--reporter=line", "--retries=0", "-g", "x", "-j", "2"])),
    );
    expect(r.flags).toEqual([
      "--workers=1",
      "--browser=firefox",
      "--grep=-leading dash",
      "--project=chromium-desktop",
      "--reporter=line",
      "--retries=0",
      "--grep=x",
      "--workers=2",
    ]);
  });

  it.each([
    ["--config=/tmp/evil.ts"],
    ["-c"],
    ["--output=/tmp/x"],
    ["--update-snapshots"],
    ["--ui"],
    ["--debug"],
    ["--tsconfig=/tmp/t.json"],
    ["--global-timeout=1"],
    ["--"],
    ["--unknown"],
  ])("refuses %s", (flag) => {
    expect(refused(resolveRun(s.config(), pw([flag])))).toBe("flag_not_allowed");
  });

  it.each([
    ["--reporter=/tmp/evil-reporter.js"],
    ["--reporter=list,./evil.js"],
    ["--browser=/tmp/chrome"],
    ["--workers=lots"],
    ["--retries=-1"],
  ])("refuses the bad value in %s", (flag) => {
    expect(refused(resolveRun(s.config(), pw([flag])))).toBe("flag_bad_value");
  });

  it("refuses an allowed flag with no value", () => {
    expect(refused(resolveRun(s.config(), pw(["--workers"])))).toBe("flag_bad_value");
  });

  it("refuses a flag this project did not allow", () => {
    const cfg = s.config({ playwright: { bin: "/x", flags: ["--workers"] } });
    expect(refused(resolveRun(cfg, pw(["--grep=x"])))).toBe("flag_not_allowed");
  });

  it("config cannot allow a flag the runner has no rule for", () => {
    expect(() =>
      RunnerConfigSchema.parse({
        project: "x",
        roots: ["/x"],
        resultsDir: "/x/r",
        playwright: { flags: ["--config"] },
      }),
    ).toThrow();
  });
});

describe("environment", () => {
  const withEnv = (env: Record<string, string>, over = {}) => resolveRun(s.config(over), pw([], { env }));

  it("allows names that match a pattern in full", () => {
    expect(allowed(withEnv({ BASE_URL: "http://web", PRO47_X: "1" })).env).toEqual({ BASE_URL: "http://web", PRO47_X: "1" });
  });

  it("anchors patterns", () => {
    expect(refused(withEnv({ XBASE_URL: "1" }))).toBe("env_not_allowed");
    expect(refused(withEnv({ BASE_URL2: "1" }))).toBe("env_not_allowed");
  });

  it("refuses a name that matches nothing", () => {
    expect(refused(withEnv({ SECRET: "1" }))).toBe("env_not_allowed");
  });

  it.each(["NODE_OPTIONS", "NODE_PATH", "PATH", "HOME", "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES"])(
    "built-in refusal of %s beats a catch-all pattern and an exact name",
    (name) => {
      expect(refused(withEnv({ [name]: "x" }, { allowedEnv: [".*", name] }))).toBe("env_not_allowed");
    },
  );

  it("PLAYWRIGHT_* is refused by a pattern, allowed only when named exactly", () => {
    expect(refused(withEnv({ PLAYWRIGHT_BROWSERS_PATH: "/x" }, { allowedEnv: [".*", "PLAYWRIGHT_.*"] }))).toBe("env_not_allowed");
    expect(allowed(withEnv({ PLAYWRIGHT_FOO: "1" }, { allowedEnv: ["PLAYWRIGHT_FOO"] })).env).toEqual({ PLAYWRIGHT_FOO: "1" });
  });

  it("PW test hooks follow the same rule as PLAYWRIGHT_*", () => {
    expect(refused(withEnv({ PWDEBUG: "1" }, { allowedEnv: [".*"] }))).toBe("env_not_allowed");
    expect(refused(withEnv({ PWTEST_X: "1" }, { allowedEnv: [".*"] }))).toBe("env_not_allowed");
  });

  it("refuses a malformed name and a NUL in a value", () => {
    expect(refused(withEnv({ "A=B": "1" }, { allowedEnv: [".*"] }))).toBe("env_not_allowed");
    expect(refused(withEnv({ BASE_URL: "a\0b" }))).toBe("bad_request");
  });
});

describe("scripts", () => {
  const scripts = { scripts: { dir: "scripts/shell" } };
  const sc = (args: string[]) => ({ command: "script", args, cwd: s.root });

  it("are off by default", () => {
    expect(refused(resolveRun(s.config(), sc(["scripts/shell/ok.mjs"])))).toBe("scripts_disabled");
  });

  it("run from the configured folder, arguments untouched", () => {
    const r = allowed(resolveRun(s.config(scripts), sc(["scripts/shell/ok.mjs", "--a", "$(id); rm -rf /"])));
    expect(r.scriptPath).toBe(join(s.root, "scripts/shell/ok.mjs"));
    expect(r.scriptArgs).toEqual(["--a", "$(id); rm -rf /"]);
  });

  it.each([
    ["scripts/other/no.mjs"],
    ["scripts/shell/../other/no.mjs"],
    ["scripts/shell/missing.mjs"],
    ["../outside/evil.spec.ts"],
    ["--require=/tmp/x.js"],
    [""],
  ])("refuse %s", (p) => {
    expect(refused(resolveRun(s.config(scripts), sc([p])))).toMatch(/^script_/);
  });

  it("refuse a script file that is a symlink leaving the folder", () => {
    symlinkSync(join(s.root, "scripts/other/no.mjs"), join(s.root, "scripts/shell/link.mjs"));
    expect(refused(resolveRun(s.config(scripts), sc(["scripts/shell/link.mjs"])))).toBe("script_not_allowed");
  });

  it("refuse anything but .mjs", () => {
    expect(refused(resolveRun(s.config(scripts), sc(["scripts/shell/ok.ts"])))).toBe("script_not_allowed");
  });
});

it("refuses an unknown command", () => {
  expect(refused(resolveRun(s.config(), { command: "bash", args: ["-c", "id"], cwd: s.root }))).toBe("bad_request");
});
