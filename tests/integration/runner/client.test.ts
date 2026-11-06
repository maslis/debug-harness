import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startRunner, type RunnerHandle } from "../../../src/runner/server.ts";
import { isAlive, makeSandbox, waitFor, type Sandbox } from "./helpers.ts";

let s: Sandbox;
let runner: RunnerHandle;

beforeEach(async () => {
  s = makeSandbox();
  runner = await startRunner(s.config({ killGraceMs: 300, scripts: { dir: "scripts/shell" } }), {
    log: () => {},
    port: 0,
    host: "127.0.0.1",
  });
});
afterEach(async () => {
  await runner.close();
  s.cleanup();
});

function debugRun(args: string[], opts: { env?: Record<string, string>; cwd?: string; url?: string; client?: string } = {}) {
  const proc = spawn(process.execPath, [opts.client ?? resolve("bin/runner-client.mjs"), ...args], {
    cwd: opts.cwd ?? s.root,
    env: { ...process.env, DEBUG_RUNNER_URL: opts.url ?? `http://127.0.0.1:${runner.port}`, ...opts.env },
  });
  let stdout = "";
  let stderr = "";
  proc.stdout.on("data", (c) => (stdout += c));
  proc.stderr.on("data", (c) => (stderr += c));
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((res) =>
    proc.on("close", (code) => res({ code, stdout, stderr })),
  );
  return { proc, done, out: () => stdout };
}

describe("runner client", () => {
  it("returns the run's exit code", async () => {
    const r = await debugRun(["-e", "FAKE_MODE=exit:7", "playwright", "tests/a.spec.ts"]).done;
    expect(r.code).toBe(7);
  });

  it("prints stdout and stderr on their own streams", async () => {
    const r = await debugRun(["playwright"]).done;
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("fake stdout");
    expect(r.stdout).not.toContain("fake stderr");
    expect(r.stderr).toContain("fake stderr");
  });

  it("sends its cwd", async () => {
    const out = join(s.base, "seen.json");
    await debugRun(["-e", `FAKE_OUT=${out}`, "playwright", "tests/w.spec.ts"], { cwd: join(s.worktrees, "wt1") }).done;
    expect(JSON.parse(readFileSync(out, "utf8")).cwd).toBe(join(s.worktrees, "wt1"));
  });

  it("forwards -e NAME from its own environment", async () => {
    const out = join(s.base, "seen.json");
    await debugRun(["-e", `FAKE_OUT=${out}`, "-e", "BASE_URL", "playwright"], { env: { BASE_URL: "http://web:1234" } }).done;
    expect(JSON.parse(readFileSync(out, "utf8")).env.BASE_URL).toBe("http://web:1234");
  });

  it("passes flags after the command through untouched, to the script too", async () => {
    const r = await debugRun(["script", "scripts/shell/ok.mjs", "-e", "--a", "$(id)"]).done;
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(["-e", "--a", "$(id)"]);
  });

  it("a refusal exits 125 and says why", async () => {
    const r = await debugRun(["playwright", "--config=/tmp/x"]).done;
    expect(r.code).toBe(125);
    expect(r.stderr).toContain("flag_not_allowed");
  });

  it("an unreachable runner exits 125, never 0", async () => {
    const r = await debugRun(["playwright"], { url: "http://127.0.0.1:1" }).done;
    expect(r.code).toBe(125);
    expect(r.stderr).toContain("runner");
  });

  it("usage error exits 2", async () => {
    expect((await debugRun(["nonsense"]).done).code).toBe(2);
    expect((await debugRun(["-e"]).done).code).toBe(2);
  });

  it("works as one file, fetched from the runner, with nothing else around it", async () => {
    const res = await fetch(`http://127.0.0.1:${runner.port}/client.mjs`);
    expect(res.status).toBe(200);
    const dir = mkdtempSync(join(tmpdir(), "runner-client-"));
    try {
      const client = join(dir, "client.mjs");
      writeFileSync(client, await res.text());
      const r = await debugRun(["-e", "FAKE_MODE=exit:7", "--cwd", s.root, "playwright"], { client, cwd: dir }).done;
      expect(r.code).toBe(7);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not import the debug CLI or anything outside Node", () => {
    const source = readFileSync("bin/runner-client.mjs", "utf8");
    const imports = [...source.matchAll(/from "([^"]+)"/g)].map((m) => m[1]!);
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.every((i) => i.startsWith("node:"))).toBe(true);
  });

  it("killing the client kills the run", async () => {
    const out = join(s.base, "pids.json");
    const c = debugRun(["-e", "FAKE_MODE=hang", "-e", `FAKE_OUT=${out}`, "playwright"]);
    await waitFor(() => c.out().includes("hanging"));
    const pids = JSON.parse(readFileSync(out, "utf8")) as Record<string, number>;
    c.proc.kill("SIGKILL");
    for (const pid of Object.values(pids)) expect(await waitFor(() => !isAlive(pid))).toBe(true);
  });
});

describe("runner client, exit code mapping", () => {
  it("timeout exits 124", async () => {
    await runner.close();
    runner = await startRunner(s.config({ timeoutMs: 200, killGraceMs: 100 }), { log: () => {}, port: 0, host: "127.0.0.1" });
    const out = join(s.base, "pids.json");
    const r = await debugRun(["-e", "FAKE_MODE=hang", "-e", `FAKE_OUT=${out}`, "playwright"]).done;
    expect(r.code).toBe(124);
    expect(r.stderr).toContain("timeout");
  });

  it("a run killed by a signal exits 128+n, never 0", async () => {
    const r = await debugRun(["-e", "FAKE_MODE=kill-self", "playwright"]).done;
    expect(r.code).toBe(137);
  });
});
