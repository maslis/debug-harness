import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RunnerConfigSchema } from "../../../src/runner/config.ts";
import { resolveRun } from "../../../src/runner/validate.ts";
import { makeSandbox, type Sandbox } from "./helpers.ts";

const example = (name: string) => RunnerConfigSchema.parse(JSON.parse(readFileSync(`examples/runner.${name}.json`, "utf8")));

let s: Sandbox;
beforeEach(() => {
  s = makeSandbox();
});
afterEach(() => s.cleanup());

/** The example's env rule, on a sandbox's paths. */
const allows = (name: string, envName: string) =>
  !("refused" in resolveRun(s.config({ allowedEnv: example(name).allowedEnv }), { command: "playwright", args: [], cwd: s.root, env: { [envName]: "1" } }));

describe("examples/runner.protag.json", () => {
  it("has no worktree roots: ProTag always runs with --cwd /work", () => {
    expect(example("protag").worktreeRoots).toEqual([]);
  });

  it.each(["BASE_URL", "PROTAG_SITE", "PROTAG_COUNTRY", "PROTAG_PUBLIC_DIR", "PROTAG_TEMPLATE", "PRO47_MODE", "PRO47_CLOSE_TYPE", "PRO1_FOO"])("allows %s", (name) => {
    expect(allows("protag", name)).toBe(true);
  });

  it.each(["PROTAG_", "PROTAG_lower", "PRO_1", "XPRO1_A", "NODE_OPTIONS", "PLAYWRIGHT_FOO"])("refuses %s", (name) => {
    expect(allows("protag", name)).toBe(false);
  });
});

describe("examples/runner.setalarmclock.json", () => {
  it.each(["BASE_URL", "INP_PROFILE", "INP_PROFILE_DAYLIGHT", "INP_A13", "INP_PAINT", "INP_CPU_THROTTLE", "AUDIT", "PROFILE", "TIER", "VW", "VH", "DPR"])("allows %s", (name) => {
    expect(allows("setalarmclock", name)).toBe(true);
  });

  it.each(["DEV_BYPASS_KEY", "STG_BYPASS", "CLOUDFLARE_API_TOKEN", "RUN_BOT_PROTECTION_TESTS", "CI", "INP_OTHER"])("refuses %s", (name) => {
    expect(allows("setalarmclock", name)).toBe(false);
  });

  it("lists exact names, no patterns", () => {
    for (const p of example("setalarmclock").allowedEnv) expect(p).toMatch(/^[A-Z0-9_]+$/);
  });
});

describe("README compose examples", () => {
  const readme = readFileSync("README.md", "utf8");
  const yaml = [...readme.matchAll(/```yaml\n([\s\S]*?)```/g)].map((m) => m[1]!);

  it("both set a restart policy", () => {
    expect(yaml).toHaveLength(2);
    for (const block of yaml) expect(block).toContain("restart: unless-stopped");
  });

  it("mount runner.json from the host path, like the other volumes", () => {
    expect(yaml[0]).toContain("${WORKSPACE_DIR}/.debug-harness/runner.json:/etc/debug-harness/runner.json:ro");
    expect(readme).not.toContain("./.debug-harness/runner.json");
  });
});
