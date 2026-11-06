import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startRunner, type RunnerHandle } from "../../../src/runner/server.ts";
import { makeSandbox, postRun, type RunEvent, type Sandbox } from "./helpers.ts";

// The real Playwright binary through the real runner, with no browser.
const REAL_PLAYWRIGHT = resolve("node_modules/.bin/playwright");
const PIN_HOOK = resolve("src/runner/pin-playwright.mjs");
const TWO_TESTS = `const { test } = require("@playwright/test");\ntest("one", () => {});\ntest("two", () => {});\n`;

let s: Sandbox;
let runner: RunnerHandle | undefined;
let logs: string[];

async function start(bin: string): Promise<number> {
  logs = [];
  const started = await startRunner(s.config({ playwright: { bin } }), { log: (l) => logs.push(l), port: 0, host: "127.0.0.1" });
  runner = started;
  return started.port;
}

beforeEach(() => {
  s = makeSandbox();
  writeFileSync(join(s.root, "playwright.config.ts"), `export default { testDir: "./tests" };\n`);
});
afterEach(async () => {
  await runner?.close();
  runner = undefined;
  s.cleanup();
});

const textOf = (events: RunEvent[]) => events.filter((e) => e.type === "output").map((e) => e.data).join("");

function writeAt(path: string, content = "\n"): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

describe("a spec path that normalizes to a flag, real Playwright", () => {
  /** Every way to write `<cwd>/<name>` so that it comes out as just `<name>`. */
  const spellings = (cwd: string, name: string): string[] => [
    `./${name}`,
    `.//${name}`,
    `././${name}`,
    `tests/../${name}`,
    `${cwd}/${name}`,
    `${cwd}/./${name}`,
    `./${name}:1`,
    `./${name}:1:1`,
    `${cwd}/${name}:1`,
  ];

  async function attack(name: string, extraArgs: string[] = []): Promise<void> {
    writeAt(join(s.root, name));
    const port = await start(REAL_PLAYWRIGHT);
    for (const spec of spellings(s.root, name)) {
      const r = await postRun(port, { command: "playwright", args: [spec, ...extraArgs], cwd: s.root });
      expect(r.status, spec).toBe(400);
      expect(r.error?.code, spec).toBe("bad_request");
    }
    expect(logs.join("\n")).not.toContain("--");
  }

  it("--config: the config outside the root never loads", async () => {
    const marker = join(s.outside, "config-loaded");
    const cfg = join(s.outside, "outside.cjs");
    writeFileSync(cfg, `require("fs").writeFileSync(${JSON.stringify(marker)}, "x");\nmodule.exports = {};\n`);
    await attack(`--config=${cfg}`);
    expect(existsSync(marker)).toBe(false);
  }, 60_000);

  it("--reporter: the reporter outside the root never loads", async () => {
    const marker = join(s.outside, "reporter-loaded");
    const rep = join(s.outside, "reporter.cjs");
    writeFileSync(rep, `require("fs").writeFileSync(${JSON.stringify(marker)}, "x");\nmodule.exports = class {};\n`);
    await attack(`--reporter=${rep}`, ["tests/a.spec.ts"]);
    expect(existsSync(marker)).toBe(false);
  }, 60_000);

  it("--output: the folder outside the results is not emptied", async () => {
    const victim = join(s.outside, "victim");
    writeAt(join(victim, "sentinel"), "keep");
    await attack(`--output=${victim}`, ["tests/a.spec.ts"]);
    expect(readFileSync(join(victim, "sentinel"), "utf8")).toBe("keep");
  }, 60_000);

  it("from a cwd below the root, a path back into the cwd is caught as well", async () => {
    const marker = join(s.outside, "config-loaded");
    const cfg = join(s.outside, "outside.cjs");
    writeFileSync(cfg, `require("fs").writeFileSync(${JSON.stringify(marker)}, "x");\nmodule.exports = {};\n`);
    const cwd = join(s.root, "tests");
    const name = `--config=${cfg}`;
    writeAt(join(cwd, name));
    const port = await start(REAL_PLAYWRIGHT);
    for (const spec of [`./${name}`, `../tests/${name}`, `${cwd}/${name}`]) {
      const r = await postRun(port, { command: "playwright", args: [spec], cwd });
      expect(r.error?.code, spec).toBe("bad_request");
    }
    expect(existsSync(marker)).toBe(false);
  }, 60_000);

  it("the log holds the refusal's code, not the injected value", async () => {
    const value = "CANARY-injected-value";
    const name = `--grep=${value}`;
    writeAt(join(s.root, name));
    const port = await start(REAL_PLAYWRIGHT);
    const r = await postRun(port, { command: "playwright", args: [`./${name}`], cwd: s.root });
    expect(r.error?.code).toBe("bad_request");
    expect(logs.join("\n")).not.toContain(value);
  }, 60_000);

  it("a leading space stays a path, whatever follows it", async () => {
    writeAt(join(s.root, "tests/ --config=x.spec.cjs"), TWO_TESTS);
    const port = await start(REAL_PLAYWRIGHT);
    const r = await postRun(port, { command: "playwright", args: ["./tests/ --config=x.spec.cjs"], cwd: s.root });
    expect(r.events.at(-1)).toMatchObject({ type: "exit", code: 0 });
  }, 60_000);

  it("a file with a dash deeper in its path still runs", async () => {
    writeAt(join(s.root, "tests/--x.spec.cjs"), TWO_TESTS);
    const port = await start(REAL_PLAYWRIGHT);
    const r = await postRun(port, { command: "playwright", args: ["tests/--x.spec.cjs"], cwd: s.root });
    expect(textOf(r.events)).toContain("2 passed");
    expect(r.events.at(-1)).toMatchObject({ type: "exit", code: 0 });
  }, 60_000);
});

describe("the -- before spec operands", () => {
  function realPlaywright(args: string[]): void {
    spawnSync(REAL_PLAYWRIGHT, ["test", `--config=${join(s.root, "playwright.config.ts")}`, "--list", ...args], {
      cwd: s.root,
      env: { ...process.env, NODE_OPTIONS: `--import=${PIN_HOOK}` },
      encoding: "utf8",
    });
  }

  // The second lock on its own, with the first one out of the way: Playwright itself, handed the attack.
  it("real Playwright reads what follows it as a filter, and without it as a flag", () => {
    const marker = join(s.outside, "config-loaded");
    const cfg = join(s.outside, "outside.cjs");
    writeFileSync(cfg, `require("fs").writeFileSync(${JSON.stringify(marker)}, "x");\nmodule.exports = {};\n`);

    realPlaywright(["--", `--config=${cfg}`]);
    expect(existsSync(marker)).toBe(false);

    realPlaywright([`--config=${cfg}`]);
    expect(existsSync(marker)).toBe(true);
  }, 60_000);

  it("is in the final argv, after every flag and before every spec", async () => {
    const port = await start(resolve("tests/fixtures/runner/fake-playwright.mjs"));
    const out = join(s.base, "argv.json");
    await postRun(port, { command: "playwright", args: ["tests/a.spec.ts", "--workers=1", "tests/a.spec.ts:1"], cwd: s.root, env: { FAKE_OUT: out } });
    const argv = JSON.parse(readFileSync(out, "utf8")).argv as string[];
    const dashes = argv.indexOf("--");
    expect(dashes).toBeGreaterThan(argv.indexOf("--workers=1"));
    expect(argv.length - dashes - 1).toBe(2);
  });

  it("works with :line on a real run", async () => {
    writeAt(join(s.root, "tests/two.spec.cjs"), TWO_TESTS);
    const port = await start(REAL_PLAYWRIGHT);
    const r = await postRun(port, { command: "playwright", args: ["tests/two.spec.cjs:3", "--reporter=list"], cwd: s.root });
    expect(textOf(r.events)).toContain("1 passed");
    expect(textOf(r.events)).toContain("two");
    expect(textOf(r.events)).not.toContain("one");
    expect(r.events.at(-1)).toMatchObject({ type: "exit", code: 0 });
  }, 60_000);

  it("a line break in --grep reaches real Playwright as a harmless value", async () => {
    writeAt(join(s.root, "tests/two.spec.cjs"), TWO_TESTS);
    const port = await start(REAL_PLAYWRIGHT);
    const r = await postRun(port, { command: "playwright", args: ["tests/two.spec.cjs", "--grep=one\ntwo", "--reporter=list"], cwd: s.root });
    expect(textOf(r.events)).toContain("No tests found");
    expect(r.events.at(-1)).toMatchObject({ type: "exit", code: 1 });
  }, 60_000);
});

describe("what a spec argument selects, real playwright test --list", () => {
  /** The runner's whole argv, handed to real Playwright with --list added. */
  function listingBin(): string {
    const bin = join(s.base, "playwright-list");
    writeFileSync(bin, `#!/bin/sh\nshift\nexec ${JSON.stringify(REAL_PLAYWRIGHT)} test --list "$@"\n`);
    chmodSync(bin, 0o755);
    return bin;
  }

  async function listed(specs: string[], cwd = s.root): Promise<string[]> {
    const port = runner ? runner.port : await start(listingBin());
    const r = await postRun(port, { command: "playwright", args: specs, cwd });
    expect(r.status, r.error?.message).toBe(200);
    return textOf(r.events)
      .split("\n")
      .map((l) => /^\s+(.+\.spec\.cjs:\d+:\d+) › /.exec(l)?.[1])
      .filter((l): l is string => l !== undefined)
      .sort();
  }

  it.each([
    // The file, then what the unescaped path would have selected instead.
    ["case[1].spec.cjs", "case1.spec.cjs"],
    ["a+b.spec.cjs", "aab.spec.cjs"],
    ["(x).spec.cjs", "x.spec.cjs"],
    ["c{2}.spec.cjs", "cc.spec.cjs"],
    ["d$e.spec.cjs", "de.spec.cjs"],
    ["f^g.spec.cjs", "fg.spec.cjs"],
    ["h|i.spec.cjs", "h.spec.cjs"],
    ["j?.spec.cjs", "j.spec.cjs"],
    ["k*.spec.cjs", "kk.spec.cjs"],
    ["l\\m.spec.cjs", "lm.spec.cjs"],
    ["n.o.spec.cjs", "nxo.spec.cjs"],
  ])("%s selects itself, not %s", async (file, neighbour) => {
    writeAt(join(s.root, "tests", file), TWO_TESTS);
    writeAt(join(s.root, "tests", neighbour), TWO_TESTS);
    expect(await listed([`tests/${file}`])).toEqual([`${file}:2:1`, `${file}:3:1`]);
  }, 60_000);

  it("keeps :line and :line:col on a path with regex characters", async () => {
    writeAt(join(s.root, "tests/case[1].spec.cjs"), TWO_TESTS);
    expect(await listed(["tests/case[1].spec.cjs:3"])).toEqual(["case[1].spec.cjs:3:1"]);
    expect(await listed(["tests/case[1].spec.cjs:3:1"])).toEqual(["case[1].spec.cjs:3:1"]);
    expect(await listed(["tests/case[1].spec.cjs:3:9"])).toEqual([]);
  }, 60_000);

  it("reads a colon inside a file name as part of the name", async () => {
    writeAt(join(s.root, "tests/p:1.spec.cjs"), TWO_TESTS);
    expect(await listed(["tests/p:1.spec.cjs"])).toEqual(["p:1.spec.cjs:2:1", "p:1.spec.cjs:3:1"]);
    expect(await listed(["tests/p:1.spec.cjs:2"])).toEqual(["p:1.spec.cjs:2:1"]);
  }, 60_000);

  it("a file is selected exactly, not as part of a longer name", async () => {
    writeAt(join(s.root, "tests/a.spec.cjs"), TWO_TESTS);
    writeAt(join(s.root, "tests/data.spec.cjs"), TWO_TESTS);
    writeAt(join(s.root, "tests/sub/a.spec.cjs"), TWO_TESTS);
    expect(await listed(["a.spec.cjs"], join(s.root, "tests"))).toEqual(["a.spec.cjs:2:1", "a.spec.cjs:3:1"]);
  }, 60_000);

  it("a folder selects what is in it, not a sibling sharing its prefix", async () => {
    writeAt(join(s.root, "tests/dir/in.spec.cjs"), TWO_TESTS);
    writeAt(join(s.root, "tests/dir2/out.spec.cjs"), TWO_TESTS);
    expect(await listed(["tests/dir"])).toEqual(["dir/in.spec.cjs:2:1", "dir/in.spec.cjs:3:1"]);
  }, 60_000);

  it("a path up out of the cwd, still inside the root, still selects its file", async () => {
    writeAt(join(s.root, "tests/a.spec.cjs"), TWO_TESTS);
    writeAt(join(s.root, "tests/sub/b.spec.cjs"), TWO_TESTS);
    expect(await listed(["../a.spec.cjs"], join(s.root, "tests/sub"))).toEqual(["a.spec.cjs:2:1", "a.spec.cjs:3:1"]);
  }, 60_000);

  it("a folder named like a regex's flags is not read as a regex", async () => {
    writeAt(join(s.root, "tests/gi/in.spec.cjs"), TWO_TESTS);
    writeAt(join(s.root, "tests/other.spec.cjs"), TWO_TESTS);
    expect(await listed([`${s.root}/tests/gi`])).toEqual(["gi/in.spec.cjs:2:1", "gi/in.spec.cjs:3:1"]);
  }, 60_000);
});
