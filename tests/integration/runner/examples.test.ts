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
  const WS = "<ws>";

  /** The short-form mounts of one block, with the workspace written as <ws>. */
  const mounts = (block: string) =>
    /^ {4}volumes:\n((?: {6}.*\n| {8}.*\n| {10}.*\n)*)/m
      .exec(block)![1]!
      .split("\n")
      .map((l) => /^ {6}- (?!type:)(.+)$/.exec(l)?.[1])
      .filter((l): l is string => l !== undefined)
      .map((v) => {
        const [source, target, mode] = v.replace(/\s+#.*$/, "").replaceAll("${WORKSPACE_DIR:-${PWD}}", WS).split(":");
        return { source: source!, target: target!, mode };
      });

  /** The source of the long-form mount that carries the runner's config. */
  const configSource = (block: string) =>
    /^ {6}- type: bind\n {8}source: (.+)\n {8}target: \/etc\/debug-harness\/runner\.json\n {8}read_only: true\n {8}bind:\n {10}create_host_path: false\n/m.exec(block)?.[1];

  /** The source of a long-form mount at `target`, only if it is read-only and never created. */
  const readOnlyFileSource = (block: string, target: string) => {
    const at = block.indexOf(`        target: ${target}\n        read_only: true\n        bind:\n          create_host_path: false\n`);
    return at === -1 ? undefined : /source: (.+)\n$/.exec(block.slice(0, at))?.[1];
  };

  it("both set a restart policy", () => {
    expect(yaml).toHaveLength(2);
    for (const block of yaml) expect(block).toContain("restart: unless-stopped");
  });

  it("both start through the image's start command, which holds the flags, and neither turns the sweep off", () => {
    for (const block of yaml) {
      expect(block).toContain('command: ["/app/bin/runner-start"]');
      expect(block).not.toContain("index.ts");
      expect(block).not.toContain("RUNNER_PROCESS_SWEEP");
    }
  });

  describe("package.json is a stub from outside the workspace, so a checkout cannot take root runs down", () => {
    const WS_VAR = "${WORKSPACE_DIR:-${PWD}}";

    it("SetAlarmClock: at /work and at the host path, read-only, never created", () => {
      const source = "${HOME}/.config/debug-harness/setalarmclock.package.json";
      expect(readOnlyFileSource(yaml[0]!, "/work/package.json")).toBe(source);
      expect(readOnlyFileSource(yaml[0]!, `${WS_VAR}/package.json`)).toBe(source);
    });

    it("ProTag: at /work, read-only, never created, and out of the results folder", () => {
      expect(readOnlyFileSource(yaml[1]!, "/work/package.json")).toBe("${HOME}/.config/debug-harness/protag.package.json");
      expect(readme).not.toContain("work-package.json");
    });

    it("no short-form mount brings the workspace's package.json back", () => {
      for (const block of yaml) for (const m of mounts(block)) {
        expect(m.source).not.toMatch(/package\.json$/);
        expect(m.target).not.toMatch(/package\.json$/);
      }
    });

    it("the README gives each project's content", () => {
      expect(readme).toContain(`printf '{"type":"module"}\\n' > ~/.config/debug-harness/setalarmclock.package.json`);
      expect(readme).toContain(`printf '{}\\n' > ~/.config/debug-harness/protag.package.json`);
    });
  });

  it("default the workspace the way the project's compose file does", () => {
    for (const block of yaml) {
      expect(block).toContain("${WORKSPACE_DIR:-${PWD}}");
      expect(block).not.toContain("${WORKSPACE_DIR}");
    }
  });

  describe.each([
    ["SetAlarmClock", 0, "setalarmclock"],
    ["ProTag", 1, "protag"],
  ] as const)("%s: nothing a run or a worker can write holds the runner's config", (_name, i, project) => {
    it("takes it from a file outside the workspace, read-only, and never creates it", () => {
      expect(configSource(yaml[i]!)).toBe(`\${HOME}/.config/debug-harness/${project}.runner.json`);
    });

    it("every other mount comes from the workspace, and none reaches that file or target", () => {
      const source = configSource(yaml[i]!)!;
      for (const m of mounts(yaml[i]!)) {
        expect(`${source}/`.startsWith(`${m.source}/`), m.source).toBe(false);
        expect(m.source === WS || m.source.startsWith(`${WS}/`), m.source).toBe(true);
        expect(m.target).not.toContain("/etc/debug-harness");
        expect(m.source).not.toContain("runner.json");
      }
    });

    it("is read_only, and writes to the results folder only", () => {
      expect(yaml[i]).toContain("read_only: true");
      expect(mounts(yaml[i]!).filter((m) => m.mode !== "ro").map((m) => m.target)).toEqual([example(project).resultsDir]);
    });
  });

  it("the old layout, with the config in the results folder, is gone", () => {
    expect(readme).not.toContain(".debug-harness/runner.json");
  });

  describe("SetAlarmClock: named mounts, so the root's secret files are not there at all", () => {
    const ROOT_NAMES = ["tests", "playwright.config.ts", "scripts", "src", ".worktrees", ".claude/worktrees"];

    it("never mounts the workspace itself, at any path, and has no masks", () => {
      for (const m of mounts(yaml[0]!)) expect(m.source).not.toBe(WS);
      expect(yaml[0]).not.toContain("/dev/null");
    });

    it("mounts exactly the named folders and files, read-only, at /work", () => {
      const atWork = mounts(yaml[0]!).filter((m) => m.target.startsWith("/work/") && m.mode === "ro");
      expect(atWork).toEqual(ROOT_NAMES.map((n) => ({ source: `${WS}/${n}`, target: `/work/${n}`, mode: "ro" })));
    });

    it("mounts the same names at the host-path alias, and the results folder read-only there", () => {
      const atHost = mounts(yaml[0]!).filter((m) => m.target.startsWith(`${WS}/`));
      expect(atHost).toEqual([...ROOT_NAMES, ".debug-harness"].map((n) => ({ source: `${WS}/${n}`, target: `${WS}/${n}`, mode: "ro" })));
    });

    it("no mount is a secret file, in any letter case", () => {
      for (const m of mounts(yaml[0]!)) expect(m.source).not.toMatch(/\/\.(env|dev\.vars)$/i);
    });

    it("the config's script folder and worktree roots are under what is mounted", () => {
      const config = example("setalarmclock");
      const targets = mounts(yaml[0]!).map((m) => m.target);
      expect(targets).toContain(`/work/${config.scripts!.dir.split("/")[0]}`);
      for (const wt of config.worktreeRoots.filter((p) => p.startsWith("/work/"))) expect(targets).toContain(wt);
    });

    it("says a new top-level name must be added, and states the worktree gap", () => {
      expect(readme).toMatch(/new top-level name/i);
      expect(readme).not.toContain("Mask secrets at the root");
      expect(readme).toContain("Secret files in a mounted worktree are readable");
    });
  });

  describe("ProTag: the whole service, and no way to worktrees/", () => {
    it("is a complete service, so it inherits no mount", () => {
      expect(readme).not.toContain("same service with these values");
      expect(yaml[1]).not.toContain("extends");
      for (const line of ["image: ", "command: ", "user: pwuser", "read_only: true", "cap_drop: [ALL]", "no-new-privileges:true", "shm_size: ", "mem_limit: ", "- /tmp:mode=1777", "- /app/artifacts"]) {
        expect(yaml[1]).toContain(line);
      }
    });

    it("mounts what its test service does, without worktrees", () => {
      expect(mounts(yaml[1]!)).toEqual([
        { source: `${WS}/tests`, target: "/work/tests", mode: "ro" },
        { source: `${WS}/playwright.config.ts`, target: "/work/playwright.config.ts", mode: "ro" },
        { source: `${WS}/protag/public`, target: "/work/protag-public", mode: "ro" },
        { source: `${WS}/.runner-builds`, target: "/work/builds", mode: "ro" },
        { source: `${WS}/.debug-harness`, target: "/work/.debug-harness", mode: undefined },
      ]);
    });

    it("no mount source holds worktrees/ or is named after it", () => {
      for (const { source, target } of mounts(yaml[1]!)) {
        expect(`${WS}/worktrees/ID/data/key`.startsWith(`${source}/`), source).toBe(false);
        expect(source).not.toContain("worktrees");
        expect(target).not.toContain("worktrees");
      }
    });

    it("has no host-path alias: only /work is a target", () => {
      for (const { target } of mounts(yaml[1]!)) expect(target).toMatch(/^\/work\//);
    });

    it("the config's root is /work", () => {
      expect(example("protag").roots).toEqual(["/work"]);
    });

    it("a build under test lives outside the results folder, read-only", () => {
      expect(readme).toContain("-e PROTAG_PUBLIC_DIR=/work/builds/<name>");
      expect(readme).toContain("protag-docker/.runner-builds/<name>/");
      expect(readme).not.toContain("copied into the results folder");
    });

    it("ties the claim to those mounts", () => {
      expect(readme).toMatch(/only with these mounts/i);
    });
  });

  it("states what a folder with no specs and a non-spec file do", () => {
    expect(readme).toMatch(/folder with no specs[^.]*exit 1/i);
    expect(readme).toMatch(/`playwright\.config\.ts`[^.]*`package\.json`[^.]*no tests/i);
  });
});
