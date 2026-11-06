import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findReadableSecretFiles, startRunner, type RunnerHandle } from "../../../src/runner/server.ts";
import { resolveRun } from "../../../src/runner/validate.ts";
import { FAKE_PLAYWRIGHT, makeSandbox, postRun, type RunEvent, type Sandbox } from "./helpers.ts";

const REAL_PLAYWRIGHT = resolve("node_modules/.bin/playwright");
const NODE_TS = ["--experimental-strip-types", "--no-warnings"];
const THREE_TESTS = `const { test } = require("@playwright/test");
test("top", () => {});
test.describe("group", () => {
  test("in group", () => {});
});
`;

let s: Sandbox;
let runner: RunnerHandle | undefined;
let logs: string[];

beforeEach(() => {
  s = makeSandbox();
  logs = [];
});
afterEach(async () => {
  await runner?.close();
  runner = undefined;
  s.cleanup();
});

async function start(over: Parameters<Sandbox["config"]>[0] = {}): Promise<number> {
  runner = await startRunner(s.config(over), { log: (l) => logs.push(l), port: 0, host: "127.0.0.1" });
  return runner.port;
}

const pw = (args: string[], cwd = s.root, env: Record<string, string> = {}) => ({ command: "playwright", args, cwd, env });
const refusedCode = (r: unknown) => (r as { refused?: string }).refused;
const runFolders = () => (existsSync(join(s.results, "runner")) ? readdirSync(join(s.results, "runner")) : []);
const textOf = (events: RunEvent[]) => events.filter((e) => e.type === "output").map((e) => e.data).join("");
const exitOf = (events: RunEvent[]) => events.find((e) => e.type === "exit");

function expectCleanRefusal(reply: { status: number; error?: { code: string } }, code: string): void {
  expect(reply.status).toBe(400);
  expect(reply.error?.code).toBe(code);
  expect(runFolders()).toEqual([]);
  expect(logs.join("\n")).not.toContain("internal_error");
  expect(logs.join("\n")).not.toContain("stack");
}

describe("--output: wipe protection does not depend on how the name is spelled", () => {
  it("refuses another letter case of the run folders while none exist yet", () => {
    for (const value of ["RUNNER/o7", "Runner/1/output", "rUnNeR"]) {
      expect(refusedCode(resolveRun(s.config(), pw([`--output=${join(s.results, value)}`])))).toBe("output_would_wipe");
    }
  });

  it("on a case-sensitive disk another letter case is another folder once the real one exists", () => {
    mkdirSync(join(s.results, "runner"));
    const r = resolveRun(s.config(), pw([`--output=${join(s.results, "RUNNER/o7")}`]));
    expect(refusedCode(r)).toBeUndefined();
  });

  it("refuses a symlink to the run folders", () => {
    mkdirSync(join(s.results, "runner/1"), { recursive: true });
    spawnSync("ln", ["-s", join(s.results, "runner"), join(s.results, "alias")]);
    expect(refusedCode(resolveRun(s.config(), pw([`--output=${join(s.results, "alias/1")}`])))).toBe("output_would_wipe");
  });

  // The repo sits on the Mac share in this project's container; on a Linux disk this one has nothing to test.
  const share = resolve("artifacts");
  mkdirSync(share, { recursive: true });
  const probe = mkdtempSync(join(share, "case-probe-"));
  const caseInsensitive = existsSync(probe.replace(/case-probe-/, "CASE-PROBE-"));
  rmSync(probe, { recursive: true });

  it.runIf(caseInsensitive)("on a case-insensitive share, refuses it by what the folder is", () => {
    const base = mkdtempSync(join(share, "runner-case-"));
    try {
      const results = join(base, "results");
      mkdirSync(join(results, "runner/1/output"), { recursive: true });
      writeFileSync(join(base, "playwright.config.ts"), "export default {};\n");
      const config = s.config({ roots: [base], worktreeRoots: [], resultsDir: results });
      for (const value of ["RUNNER/1/output", "RUNNER/o7", "Runner/1"]) {
        expect(refusedCode(resolveRun(config, pw([`--output=${join(results, value)}`], base))), value).toBe("output_would_wipe");
      }
      expect(refusedCode(resolveRun(config, pw([`--output=${join(results, "mine")}`], base)))).toBeUndefined();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("the final command line has to fit", () => {
  it("many small spec arguments: bad_request, no run folder, no stack", async () => {
    const port = await start();
    writeFileSync(join(s.root, "s"), "\n");
    expectCleanRefusal(await postRun(port, pw(Array(150_000).fill("s"))), "bad_request");
  });

  it("the filters count, not only what the client sent", () => {
    const deep = join(s.root, "d".repeat(200));
    mkdirSync(deep);
    writeFileSync(join(deep, "s"), "\n");
    expect(refusedCode(resolveRun(s.config(), pw(Array(12_000).fill("s"), deep)))).toBe("bad_request");
  });

  it("empty script arguments count: each costs a pointer", async () => {
    const port = await start({ scripts: { dir: "scripts/shell" } });
    const reply = await postRun(port, { command: "script", args: ["scripts/shell/ok.mjs", ...Array(300_000).fill("")], cwd: s.root, env: {} });
    expectCleanRefusal(reply, "bad_request");
  });

  it("env counts, including one name and value that together pass what one entry may be", async () => {
    const port = await start({ allowedEnv: ["FAKE_.*"] });
    const name = `FAKE_${"N".repeat(90_000)}`;
    expectCleanRefusal(await postRun(port, pw([], s.root, { [name]: "v".repeat(90_000) })), "bad_request");
  });

  it("a normal large request still runs", async () => {
    const port = await start({ allowedEnv: ["FAKE_.*"] });
    const reply = await postRun(port, pw(Array(2_000).fill("tests/a.spec.ts"), s.root, { FAKE_BIG: "v".repeat(100_000) }));
    expect(reply.status).toBe(200);
    expect(exitOf(reply.events)?.code).toBe(0);
  });
});

describe("--cwd naming a file", () => {
  it("gets its own code and no run folder", async () => {
    const port = await start();
    expectCleanRefusal(await postRun(port, pw([], join(s.root, "tests/a.spec.ts"))), "cwd_not_a_directory");
  });

  it("outside the project it is still cwd_outside_root", () => {
    expect(refusedCode(resolveRun(s.config(), pw([], join(s.outside, "evil.spec.ts"))))).toBe("cwd_outside_root");
  });
});

describe("--retries", () => {
  it.each(["0", "10"])("takes %s", (v) => {
    expect(refusedCode(resolveRun(s.config(), pw([`--retries=${v}`])))).toBeUndefined();
  });
  it.each(["11", "99999999999999999999"])("refuses %s", (v) => {
    expect(refusedCode(resolveRun(s.config(), pw([`--retries=${v}`])))).toBe("flag_bad_value");
  });
});

describe("readable secret files, in any letter case", () => {
  it.each([".ENV", ".Env", ".DEV.VARS", ".Dev.Vars"])("counts %s in the root", (name) => {
    writeFileSync(join(s.root, name), "marker");
    expect(findReadableSecretFiles(s.config({ secretFiles: [".env", ".dev.vars"] }))).toEqual([join(s.root, name)]);
  });

  it("counts them in a worktree too, and each file once", () => {
    writeFileSync(join(s.worktrees, "wt1/.ENV"), "marker");
    writeFileSync(join(s.root, ".env"), "marker");
    expect(findReadableSecretFiles(s.config({ secretFiles: [".env"] })).sort()).toEqual([join(s.root, ".env"), join(s.worktrees, "wt1/.ENV")]);
  });

  it("does not count a longer name", () => {
    writeFileSync(join(s.root, ".env.example"), "marker");
    expect(findReadableSecretFiles(s.config({ secretFiles: [".env"] }))).toEqual([]);
  });
});

describe("spec filters are exact on a case-sensitive disk (real Playwright)", () => {
  const listed = (events: RunEvent[]) =>
    textOf(events)
      .split("\n")
      .map((l) => /(\S+\.spec\.cjs):\d+:\d+ › /.exec(l)?.[1])
      .filter((l): l is string => l !== undefined);

  async function realPort(): Promise<number> {
    writeFileSync(join(s.root, "playwright.config.ts"), `export default { testDir: "./tests" };\n`);
    return start({ playwright: { bin: REAL_PLAYWRIGHT } });
  }

  beforeEach(() => {
    writeFileSync(join(s.root, "tests/a.spec.cjs"), THREE_TESTS);
    writeFileSync(join(s.root, "tests/A.spec.cjs"), THREE_TESTS);
    writeFileSync(join(s.root, "tests/B.spec.cjs"), THREE_TESTS);
    spawnSync("ln", ["-s", resolve("node_modules"), join(s.root, "node_modules")]);
  });

  it.each([
    ["tests/a.spec.cjs", 2, "tests/a.spec.cjs"],
    ["tests/A.spec.cjs", 2, "tests/A.spec.cjs"],
    ["tests/a.spec.cjs:2", 1, "tests/a.spec.cjs"],
    ["tests/A.spec.cjs:4:3", 1, "tests/A.spec.cjs"],
  ])("%s selects only itself", async (arg, count, file) => {
    const r = await postRun(await realPort(), pw([arg, "--workers=1"]));
    expect(exitOf(r.events)?.code).toBe(0);
    expect(listed(r.events)).toEqual(Array(count).fill(file));
  });

  it("a wrong-case path that does not exist here is refused, not widened", async () => {
    const r = await postRun(await realPort(), pw(["tests/b.spec.cjs"]));
    expect(r.error?.code).toBe("path_not_found");
  });
});

describe("a requested path that selected nothing is not a pass (real Playwright)", () => {
  async function realPort(): Promise<number> {
    writeFileSync(join(s.root, "playwright.config.ts"), `export default { testDir: "./tests" };\n`);
    return start({ playwright: { bin: REAL_PLAYWRIGHT } });
  }

  beforeEach(() => {
    mkdirSync(join(s.root, "tests/sub"), { recursive: true });
    mkdirSync(join(s.root, "tests/empty"), { recursive: true });
    writeFileSync(join(s.root, "tests/empty/readme.txt"), "\n");
    for (const f of ["tests/one.spec.cjs", "tests/two.spec.cjs", "tests/sub/deep.spec.cjs"]) writeFileSync(join(s.root, f), THREE_TESTS);
    writeFileSync(join(s.root, "x-outside.cjs"), THREE_TESTS);
    spawnSync("ln", ["-s", resolve("node_modules"), join(s.root, "node_modules")]);
  });

  it.each([
    ["a file outside testDir", ["tests/one.spec.cjs", "x-outside.cjs"], "x-outside.cjs"],
    ["a line with no test", ["tests/one.spec.cjs", "tests/two.spec.cjs:9999"], "tests/two.spec.cjs:9999"],
    ["a folder with no specs", ["tests/one.spec.cjs", "tests/empty"], "tests/empty"],
  ])("%s beside one that matches: exit 1, and it is named", async (_name, args, named) => {
    const r = await postRun(await realPort(), pw([...args, "--workers=1"]));
    expect(exitOf(r.events)).toMatchObject({ code: 1, outcome: "selected_nothing" });
    expect(textOf(r.events)).toContain(`runner: error: ${named} selected no test`);
  });

  it.each([
    ["two files", ["tests/one.spec.cjs", "tests/two.spec.cjs"]],
    ["a folder and a file", ["tests/sub", "tests/one.spec.cjs"]],
    ["a test's line", ["tests/one.spec.cjs:2", "tests/two.spec.cjs:4:3"]],
    ["a describe's line", ["tests/one.spec.cjs:3"]],
    ["line 0, which means the file", ["tests/one.spec.cjs:0"]],
  ])("%s still passes", async (_name, args) => {
    const r = await postRun(await realPort(), pw([...args, "--workers=1"]));
    expect(exitOf(r.events)).toMatchObject({ code: 0, outcome: "exited" });
  });

  it("is checked whatever reporter the caller chose", async () => {
    const r = await postRun(await realPort(), pw(["tests/one.spec.cjs", "x-outside.cjs", "--reporter=line", "--workers=1"]));
    expect(exitOf(r.events)?.code).toBe(1);
  });

  it("a run with no spec argument is not checked", async () => {
    const r = await postRun(await realPort(), pw(["--workers=1"]));
    expect(exitOf(r.events)?.code).toBe(0);
  });

  it("a run that exits 0 with no readable report is not a pass", async () => {
    const port = await start({ allowedEnv: ["FAKE_.*"] });
    const r = await postRun(port, pw(["tests/a.spec.ts"], s.root, { FAKE_NO_REPORT: "1" }));
    expect(exitOf(r.events)).toMatchObject({ code: 1, outcome: "selected_nothing" });
    expect(textOf(r.events)).toContain("runner: error:");
  });

  it("a failing run keeps its own exit code", async () => {
    const port = await start({ allowedEnv: ["FAKE_.*"] });
    const r = await postRun(port, pw(["tests/a.spec.ts"], s.root, { FAKE_MODE: "exit:7", FAKE_NO_REPORT: "1" }));
    expect(exitOf(r.events)).toMatchObject({ code: 7, outcome: "exited" });
  });
});

describe("the client on a bad answer", () => {
  let server: Server;
  afterEach(() => new Promise((r) => server.close(r)));

  async function clientAgainst(body: string): Promise<{ code: number | null; stderr: string }> {
    server = createServer((_req, res) => {
      res.writeHead(200);
      res.end(body);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const proc = spawn(process.execPath, [resolve("bin/runner-client.mjs"), "--cwd", s.root, "playwright"], {
      env: { ...process.env, DEBUG_RUNNER_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}` },
    });
    let stderr = "";
    proc.stderr.on("data", (c) => (stderr += c));
    const code = await new Promise<number | null>((r) => proc.on("close", r));
    return { code, stderr };
  }

  it.each([
    ["a line that is not JSON", "<html>hello</html>\n"],
    ["a line that is JSON but no event", "null\n"],
    ["an exit event with no code", '{"type":"exit"}\n'],
  ])("%s exits 125, never as a test result", async (_name, body) => {
    const r = await clientAgainst(body);
    expect(r.code).toBe(125);
    expect(r.stderr).toContain("runner-client:");
  });
});

describe("startup refuses a playwright.bin a run or a worker could replace", () => {
  function startService(bin: string, over: object = {}) {
    const configFile = join(s.base, "runner.json");
    writeFileSync(configFile, JSON.stringify({ project: "test", roots: [s.root], worktreeRoots: [s.worktrees], resultsDir: s.results, playwright: { bin }, ...over }));
    return spawnSync(process.execPath, [...NODE_TS, resolve("src/runner/index.ts")], {
      env: { ...process.env, RUNNER_CONFIG: configFile, RUNNER_PORT: "0", RUNNER_HOST: "127.0.0.1" },
      encoding: "utf8",
      timeout: 15_000,
    });
  }

  it.each([
    ["the results folder", () => join(s.results, "evil.sh")],
    ["the repo", () => join(s.root, "evil.sh")],
    ["a worktree", () => join(s.worktrees, "wt1/evil.sh")],
  ])("in %s", (_name, path) => {
    writeFileSync(path(), "#!/bin/sh\n");
    const r = startService(path());
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("refused_to_start");
    expect(r.stdout).toContain("playwright.bin");
  });

  it("in the scratch folder", () => {
    const bin = join(s.outside, "evil.sh");
    writeFileSync(bin, "#!/bin/sh\n");
    expect(startService(bin, { scratchDir: s.outside }).status).toBe(1);
  });

  it("through a symlink out of the repo that lands back in it", () => {
    const bin = join(s.results, "evil.sh");
    writeFileSync(bin, "#!/bin/sh\n");
    const link = join(s.outside, "link");
    spawnSync("ln", ["-s", bin, link]);
    expect(startService(link).status).toBe(1);
  });

  it("the fake binary outside those folders is fine: the service reaches listening", async () => {
    const configFile = join(s.base, "runner.json");
    writeFileSync(configFile, JSON.stringify({ project: "test", roots: [s.root], resultsDir: s.results, playwright: { bin: FAKE_PLAYWRIGHT } }));
    const proc = spawn(process.execPath, ["--disable-sigusr1", ...NODE_TS, resolve("src/runner/index.ts")], {
      env: { ...process.env, RUNNER_PROCESS_SWEEP: "off", RUNNER_CONFIG: configFile, RUNNER_PORT: "0", RUNNER_HOST: "127.0.0.1" },
    });
    let out = "";
    proc.stdout.on("data", (c) => (out += c));
    await expect.poll(() => out, { timeout: 15_000 }).toContain('"listening"');
    proc.kill("SIGKILL");
  });
});
