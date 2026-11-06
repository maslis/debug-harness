import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FAKE_PLAYWRIGHT, isAlive, makeSandbox, postRun, type Sandbox } from "./helpers.ts";

const NODE_TS = ["--experimental-strip-types", "--no-warnings"];

let s: Sandbox;
let proc: ChildProcess | undefined;
beforeEach(() => {
  s = makeSandbox();
});
afterEach(() => {
  if (proc?.exitCode === null) proc.kill("SIGKILL");
  s.cleanup();
});

/** The real service in its own process: in-process, a crash would be the test runner's. */
function startService(): Promise<number> {
  const configFile = join(s.base, "runner.json");
  writeFileSync(configFile, JSON.stringify({ project: "test", roots: [s.root], resultsDir: s.results, playwright: { bin: FAKE_PLAYWRIGHT } }));
  proc = spawn(process.execPath, [...NODE_TS, resolve("src/runner/index.ts")], {
    env: { ...process.env, RUNNER_CONFIG: configFile, RUNNER_PORT: "0", RUNNER_HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  return new Promise((res, rej) => {
    let buf = "";
    proc!.stdout!.on("data", (c) => {
      buf += c;
      const line = buf.split("\n").find((l) => l.includes('"listening"'));
      if (line) res((JSON.parse(line) as { port: number }).port);
    });
    proc!.on("exit", (code) => rej(new Error(`service exited ${code} before listening`)));
  });
}

describe("one request cannot stop the service", () => {
  it.each([
    ["\\n inside a path", "tests/a\nb"],
    ["\\r inside a path", "tests/a\rb"],
    ["U+2028 inside a path", "tests/a b"],
    ["U+2029 inside a path", "tests/a b"],
    ["a lone \\n", "\n"],
  ])("%s is refused as bad_request, and /health still answers", async (_name, arg) => {
    const port = await startService();
    const r = await postRun(port, { command: "playwright", args: [arg], cwd: s.root, env: {} });
    expect(r.status).toBe(400);
    expect(r.error?.code).toBe("bad_request");
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    expect(health.status).toBe(200);
    expect(isAlive(proc!.pid!)).toBe(true);
  });
});

describe("process guard", () => {
  const SECRET = "s3cr3t-in-a-message";
  // Throws from a timer and rejects a promise: nothing in a request handler can catch these.
  const script = `
    import { installProcessGuard } from ${JSON.stringify(resolve("src/runner/guard.ts"))};
    installProcessGuard((line) => console.log(line));
    setTimeout(() => { throw new TypeError(${JSON.stringify(SECRET)}); }, 0);
    void Promise.reject(new Error(${JSON.stringify(SECRET)}));
    setTimeout(() => console.log("still-alive"), 100);
  `;

  function runScript(): Promise<{ code: number | null; out: string }> {
    const child = spawn(process.execPath, [...NODE_TS, "--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    return new Promise((res) => child.on("close", (code) => res({ code, out })));
  }

  it("survives an uncaught exception and an unhandled rejection", async () => {
    const r = await runScript();
    expect(r.code).toBe(0);
    expect(r.out).toContain("still-alive");
  });

  it("logs each one with its type and frames, never its message", async () => {
    const r = await runScript();
    const lines = r.out.split("\n").filter((l) => l.includes('"uncaught"')).map((l) => JSON.parse(l));
    expect(lines.map((l) => l.kind).sort()).toEqual(["exception", "rejection"]);
    expect(lines.find((l) => l.kind === "exception")).toMatchObject({ error: "TypeError" });
    expect(r.out).not.toContain(SECRET);
  });
});
