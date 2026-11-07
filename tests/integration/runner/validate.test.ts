import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
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

  it.each([["tests/a\nb"], ["tests/a\rb"], ["tests/a\u2028b"], ["tests/a\u2029b"], ["\n"], ["tests/a.spec.ts\n"], ["tests/a.spec.ts\n:12"]])(
    "refuses the line terminator in %j instead of throwing",
    (arg) => {
      expect(refused(resolveRun(s.config(), pw([arg])))).toBe("bad_request");
    },
  );

  it("refuses an empty argument, which would run the whole suite", () => {
    expect(refused(resolveRun(s.config(), pw([""])))).toBe("bad_request");
    expect(refused(resolveRun(s.config(), pw(["tests/a.spec.ts", ""])))).toBe("bad_request");
  });

  it("refuses a :line with no file, which would also run the whole suite", () => {
    expect(refused(resolveRun(s.config(), pw([":12"])))).toBe("bad_request");
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

  it.each([["--grep="], ["--project="], ["--workers="], ["--retries="], ["--output="], ["--reporter="], ["--browser="]])(
    "refuses the empty value in %s",
    (flag) => {
      expect(refused(resolveRun(s.config(), pw([flag])))).toBe("flag_bad_value");
    },
  );

  it("refuses an empty value given as its own argument", () => {
    expect(refused(resolveRun(s.config(), pw(["--grep", ""])))).toBe("flag_bad_value");
    expect(refused(resolveRun(s.config(), pw(["-g", ""])))).toBe("flag_bad_value");
  });

  it.each([["--workers=1"], ["--workers=16"], ["--workers=50%"], ["--workers=100%"], ["-j=4"]])("allows %s", (flag) => {
    expect(allowed(resolveRun(s.config(), pw([flag]))).flags).toHaveLength(1);
  });

  it.each([["--workers=17"], ["--workers=99999999999999999999"], ["--workers=0"], ["--workers=101%"], ["--workers=0%"], ["--workers=007"]])(
    "refuses %s, past the limit or not a worker count",
    (flag) => {
      expect(refused(resolveRun(s.config(), pw([flag])))).toBe("flag_bad_value");
    },
  );

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

describe("--output", () => {
  const out = (value: string) => resolveRun(s.config(), pw([`--output=${value}`]));

  it("is allowed under the results folder, and written back as an absolute path", () => {
    expect(allowed(out(join(s.results, "my-output"))).flags).toEqual([`--output=${join(s.results, "my-output")}`]);
    expect(allowed(out(".debug-harness/a/b")).flags).toEqual([`--output=${join(s.results, "a/b")}`]);
  });

  it.each([["/tmp/x"], ["tests/out"], [".debug-harness/../tests/out"], ["."]])("refuses %s, outside the results folder", (v) => {
    expect(refused(out(v))).toBe("output_outside_results");
  });

  it("refuses a symlink in the path that leaves the results folder", () => {
    symlinkSync(s.outside, join(s.results, "link"));
    expect(refused(out(".debug-harness/link/x"))).toBe("output_outside_results");
    expect(refused(out(".debug-harness/link"))).toBe("output_outside_results");
  });

  it("refuses a sibling sharing the results folder's prefix", () => {
    expect(refused(out(`${s.results}-other/x`))).toBe("output_outside_results");
  });

  // Playwright empties its output folder when a run starts.
  it("refuses the results folder itself, which Playwright would empty", () => {
    expect(refused(out(".debug-harness"))).toBe("output_would_wipe");
  });

  it("refuses the runner's own run folders", () => {
    expect(refused(out(".debug-harness/runner"))).toBe("output_would_wipe");
    expect(refused(out(".debug-harness/runner/123"))).toBe("output_would_wipe");
  });

  it("refuses a folder holding something other than Playwright output", () => {
    mkdirSync(join(s.results, "baselines"));
    writeFileSync(join(s.results, "baselines/home.png"), "x");
    expect(refused(out(".debug-harness/baselines"))).toBe("output_would_wipe");
  });

  it("refuses a path that is a file", () => {
    writeFileSync(join(s.results, "file"), "x");
    expect(refused(out(".debug-harness/file"))).toBe("output_would_wipe");
  });

  it("allows an empty folder, and an earlier Playwright output folder", () => {
    mkdirSync(join(s.results, "empty"));
    expect(allowed(out(".debug-harness/empty")).flags).toHaveLength(1);
    mkdirSync(join(s.results, "earlier"));
    writeFileSync(join(s.results, "earlier/.last-run.json"), "{}");
    writeFileSync(join(s.results, "earlier/trace.zip"), "x");
    expect(allowed(out(".debug-harness/earlier")).flags).toHaveLength(1);
  });

  it("hides its value in the log like every other flag", () => {
    expect(allowed(out(".debug-harness/a")).logArgs).toEqual(["--output=<hidden>"]);
  });

  it("can be switched off per project", () => {
    const cfg = s.config({ playwright: { bin: "/x", flags: ["--workers"] } });
    expect(refused(resolveRun(cfg, pw(["--output=.debug-harness/a"])))).toBe("flag_not_allowed");
  });
});

describe("environment", () => {
  const withEnv = (env: Record<string, string>, over = {}) => resolveRun(s.config(over), pw([], { env }));

  it("allows names that match a pattern in full", () => {
    expect(allowed(withEnv({ BASE_URL: "http://web", PRO47_X: "1" })).env).toEqual({ BASE_URL: "http://web", PRO47_X: "1" });
  });

  it("the ProTag names and pattern pass", () => {
    const allowedEnv = ["BASE_URL", "PROTAG_PUBLIC_DIR", "PROTAG_TEMPLATE", "PRO47_MODE", "PRO47_CLOSE_TYPE", "PRO47_OUT_DIR", "PRO[0-9]+_.*"];
    const env = { BASE_URL: "x", PROTAG_PUBLIC_DIR: "x", PROTAG_TEMPLATE: "x", PRO47_MODE: "x", PRO47_CLOSE_TYPE: "x", PRO47_OUT_DIR: "x", PRO123_ANY: "x" };
    expect(allowed(withEnv(env, { allowedEnv })).env).toEqual(env);
    expect(refused(withEnv({ PROTAG_OTHER: "x" }, { allowedEnv }))).toBe("env_not_allowed");
  });

  it("does not check a value that names a path: the read-only mount protects the repo", () => {
    expect(allowed(withEnv({ PRO47_OUT_DIR: "/etc/../outside/anywhere" })).env.PRO47_OUT_DIR).toBe("/etc/../outside/anywhere");
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

describe("a value is checked in the form it ends up in", () => {
  const scripts = { scripts: { dir: "scripts/shell" } };

  it.each([
    ["./--config=x", "--config=x"],
    [".//--config=x", "--config=x"],
    ["tests/../--config=x", "--config=x"],
    ["./-c", "-c"],
    ["./-", "-"],
    ["./--", "--"],
    ["./--output=x:12", "--output=x"],
  ])("refuses the spec %s, which normalizes to a leading dash", (spec, file) => {
    writeFileSync(join(s.root, file), "\n");
    expect(refused(resolveRun(s.config(), pw([spec])))).toBe("bad_request");
    expect(refused(resolveRun(s.config(), pw([join(s.root, spec)])))).toBe("bad_request");
  });

  it("leaves --output absolute, whatever it was given as", () => {
    const r = allowed(resolveRun(s.config(), { command: "playwright", args: ["--output=./--config=x"], cwd: s.results }));
    expect(r.flags).toEqual([`--output=${join(s.results, "--config=x")}`]);
  });

  it("leaves a script absolute, so a dash in its name is no flag to node", () => {
    writeFileSync(join(s.root, "scripts/shell/-x.mjs"), "\n");
    const fromInside = allowed(resolveRun(s.config(scripts), { command: "script", args: ["./-x.mjs"], cwd: join(s.root, "scripts/shell") }));
    expect(fromInside.scriptPath).toBe(join(s.root, "scripts/shell/-x.mjs"));
  });

  it("does not change a script argument or an env value", () => {
    const r = allowed(resolveRun(s.config(scripts), { command: "script", args: ["scripts/shell/ok.mjs", "./--config=x"], cwd: s.root, env: { BASE_URL: "./--x" } }));
    expect(r.scriptArgs).toEqual(["./--config=x"]);
    expect(r.env).toEqual({ BASE_URL: "./--x" });
  });

  it.each([["\n"], ["\r"], ["\v"], ["\f"], ["\u0085"], ["\u2028"], ["\u2029"]])("refuses the line terminator %j in --output", (eol) => {
    expect(refused(resolveRun(s.config(), pw([`--output=${join(s.results, `o${eol}x`)}`])))).toBe("flag_bad_value");
    expect(refused(resolveRun(s.config(), pw(["--output", join(s.results, `o${eol}x`)])))).toBe("flag_bad_value");
  });

  it("leaves a line break in --grep alone", () => {
    expect(allowed(resolveRun(s.config(), pw(["--grep=a\nb"]))).flags).toEqual(["--grep=a\nb"]);
  });
});

describe("value size", () => {
  const huge = "x".repeat(100_001);

  it.each([[`--grep=${huge}`], [`--project=${huge}`], [`--output=${huge}`], [huge]])("refuses an oversized argument (%#)", (arg) => {
    expect(refused(resolveRun(s.config(), pw([arg])))).toBe("bad_request");
  });

  it("refuses an oversized value given as its own argument, env value and script argument", () => {
    expect(refused(resolveRun(s.config(), pw(["--grep", huge])))).toBe("bad_request");
    expect(refused(resolveRun(s.config(), pw([], { env: { BASE_URL: huge } })))).toBe("bad_request");
    const script = { command: "script", args: ["scripts/shell/ok.mjs", huge], cwd: s.root };
    expect(refused(resolveRun(s.config({ scripts: { dir: "scripts/shell" } }), script))).toBe("bad_request");
  });

  it("counts bytes, because that is what the kernel limits", () => {
    expect(refused(resolveRun(s.config(), pw([`--grep=${"é".repeat(50_001)}`])))).toBe("bad_request");
  });

  it("takes a long value under the limit", () => {
    const r = allowed(resolveRun(s.config(), pw([`--grep=${"x".repeat(99_000)}`], { env: { BASE_URL: "x".repeat(99_000) } })));
    expect(r.flags).toHaveLength(1);
  });
});
