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

  it.each(["DEV_BYPASS_KEY", "STG_BYPASS", "CLOUDFLARE_API_TOKEN", "RUN_BOT_PROTECTION_TESTS", "CI", "INP_OTHER", "INP_PAGE"])("refuses %s", (name) => {
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
    expect(yaml[0]).toContain("${WORKSPACE_DIR:-${PWD}}/.debug-harness/runner.json:/etc/debug-harness/runner.json:ro");
    expect(readme).not.toContain("./.debug-harness/runner.json");
  });

  it("default the workspace the way the project's compose file does", () => {
    for (const block of yaml) {
      expect(block).toContain("${WORKSPACE_DIR:-${PWD}}");
      expect(block).not.toContain("${WORKSPACE_DIR}");
    }
  });

  describe("ProTag: the whole service, and no way to worktrees/", () => {
    const WS = "<ws>";
    const mounts = () =>
      /^ {4}volumes:\n((?: {6}.*\n)*)/m
        .exec(yaml[1]!)![1]!
        .split("\n")
        .map((l) => /^ {6}- (.+)$/.exec(l)?.[1])
        .filter((l): l is string => l !== undefined)
        .map((v) => {
          const [source, target, mode] = v.replaceAll("${WORKSPACE_DIR:-${PWD}}", WS).split(":");
          return { source: source!, target: target!, mode };
        });

    it("is a complete service, so it inherits no mount", () => {
      expect(readme).not.toContain("same service with these values");
      expect(yaml[1]).not.toContain("extends");
      for (const line of ["image: ", "command: ", "user: pwuser", "read_only: true", "cap_drop: [ALL]", "no-new-privileges:true", "shm_size: ", "mem_limit: ", "- /tmp:mode=1777", "- /app/artifacts"]) {
        expect(yaml[1]).toContain(line);
      }
    });

    it("mounts what its test service does, without worktrees", () => {
      expect(mounts()).toEqual([
        { source: `${WS}/tests`, target: "/work/tests", mode: "ro" },
        { source: `${WS}/playwright.config.ts`, target: "/work/playwright.config.ts", mode: "ro" },
        { source: `${WS}/protag/public`, target: "/work/protag-public", mode: "ro" },
        { source: `${WS}/.debug-harness`, target: "/work/.debug-harness", mode: undefined },
        { source: `${WS}/.debug-harness/work-package.json`, target: "/work/package.json", mode: "ro" },
        { source: `${WS}/.debug-harness/runner.json`, target: "/etc/debug-harness/runner.json", mode: "ro" },
      ]);
    });

    it("no mount source holds worktrees/ or is named after it", () => {
      for (const { source, target } of mounts()) {
        expect(`${WS}/worktrees/ID/data/key`.startsWith(`${source}/`), source).toBe(false);
        expect(source).not.toContain("worktrees");
        expect(target).not.toContain("worktrees");
      }
    });

    it("has no host-path alias: only /work and the config are targets", () => {
      for (const { target } of mounts()) expect(target).toMatch(/^\/(work|etc\/debug-harness)\//);
    });

    it("writes to the results folder only, and the config agrees", () => {
      expect(mounts().filter((m) => m.mode !== "ro").map((m) => m.target)).toEqual([example("protag").resultsDir]);
      expect(example("protag").roots).toEqual(["/work"]);
    });

    it("ties the claim to those mounts", () => {
      expect(readme).toMatch(/only with these mounts/i);
    });
  });
});
